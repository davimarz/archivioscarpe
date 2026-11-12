const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const repository = 'https://github.com/davimarz/archivioscarpe.git';
const publicCatalog = 'https://davimarz.github.io/archivioscarpe/catalogo-awin.json';
const rawBase = 'https://raw.githubusercontent.com/davimarz/archivioscarpe/';
const filesToPublish = ['index.html', 'sw.js', 'catalogo-awin.json'];
const feedExtension = /\.(?:(?:csv|tsv|jsonl|ndjson)(?:\.gz)?|gz)$/i;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw new Error('Impossibile avviare ' + path.basename(command) + ': ' + result.error.code);
  if (result.status !== 0) {
    throw new Error(path.basename(command) + ' ha restituito un errore. Il dettaglio è riportato sopra.');
  }
}

async function downloadScript(revision, name, destination) {
  const response = await fetch(rawBase + revision + '/tools/awin/' + name, {
    redirect: 'error',
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('Impossibile scaricare ' + name + ' da GitHub (HTTP ' + response.status + ')');
  fs.writeFileSync(destination, await response.text(), { flag: 'wx' });
  run(process.execPath, ['--check', destination]);
}

function keepLocalFeeds(staging, local) {
  const feeds = fs.readdirSync(staging, { withFileTypes: true }).filter(entry => entry.isFile());
  if (!feeds.length || feeds.some(entry => !feedExtension.test(entry.name))) {
    throw new Error('Scaricamento incompleto o formato non supportato. Sono attesi CSV, TSV, gzip o JSONL.');
  }
  fs.mkdirSync(local, { recursive: true });
  for (const { name } of feeds) {
    const temporary = path.join(local, '.' + randomUUID() + '.part');
    try {
      fs.copyFileSync(path.join(staging, name), temporary, fs.constants.COPYFILE_EXCL);
      fs.renameSync(temporary, path.join(local, name));
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return feeds.length;
}

function publish(repo) {
  const git = (...args) => run('git', ['-C', repo, ...args]);
  git('add', '--', ...filesToPublish);
  const diff = spawnSync('git', ['-C', repo, 'diff', '--cached', '--quiet', '--', ...filesToPublish], { stdio: 'inherit' });
  if (diff.status === 0) {
    console.log('Il catalogo su GitHub è già identico.');
    return;
  }
  if (diff.status !== 1) throw new Error('Impossibile verificare le modifiche Git.');
  git('commit', '-m', 'Aggiorna catalogo offerte Awin', '--', ...filesToPublish);
  git('push', 'origin', 'HEAD:main');
}

async function verifyOnline(catalogPath) {
  const expected = createHash('sha256').update(fs.readFileSync(catalogPath)).digest('hex');
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const url = new URL(publicCatalog);
      url.searchParams.set('verifica', Date.now().toString());
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        const actual = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
        if (actual === expected) return true;
      } else {
        await response.body?.cancel();
      }
    } catch {
      // Pages may still be building.
    }
    if (attempt < 11) await delay(10000);
  }
  return false;
}

async function main() {
  const publisher = process.argv[2];
  if (!/^\d+$/.test(publisher || '')) throw new Error('Specifica il tuo Publisher ID Awin.');
  const working = fs.mkdtempSync(path.join(os.tmpdir(), 'archivioscarpe-awin-'));
  const staging = path.join(working, 'listini');
  const repo = path.join(working, 'sito');
  const downloadPath = path.join(__dirname, '.scarica-awin-' + randomUUID() + '.cjs');
  const importPath = path.join(working, 'importa-listini-awin.cjs');
  let phase = 'Preparazione';
  try {
    fs.mkdirSync(staging);
    await downloadScript('a4bf3cc0ebecadc7450c6180d42a2d2af6407bc2', 'scarica-listini-awin.cjs', downloadPath);
    await downloadScript('8a42cd4e42b624770ce33dc19e6e0df9480c7cfb', 'importa-listini-awin.cjs', importPath);

    phase = '1/3 Scaricamento listini';
    console.log(phase);
    run(process.execPath, [downloadPath, publisher], {
      env: { ...process.env, AWIN_LISTINI_DIR: staging }
    });
    const local = path.join(__dirname, 'LISTINI');
    const count = keepLocalFeeds(staging, local);
    console.log('Listini aggiornati: ' + count + ' | ' + local);

    phase = '2/3 Aggiornamento catalogo';
    console.log(phase);
    run('git', ['clone', '--depth', '1', '--single-branch', '--branch', 'main', repository, repo]);
    run(process.execPath, [importPath, repo, staging, publisher]);

    phase = '3/3 Pubblicazione sito';
    console.log(phase);
    publish(repo);
    console.log('GitHub aggiornato. Attendo che GitHub Pages serva il nuovo catalogo.');
    if (!await verifyOnline(path.join(repo, 'catalogo-awin.json'))) {
      console.warn('GitHub aggiornato, ma il nuovo catalogo non è ancora verificabile sul sito pubblico.');
      process.exitCode = 2;
      return;
    }
    console.log('Catalogo verificato online: https://davimarz.github.io/archivioscarpe/');
  } catch (error) {
    console.error('Aggiornamento interrotto alla fase «' + phase + '»: ' + error.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(downloadPath, { force: true });
    fs.rmSync(working, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('Aggiornamento interrotto: ' + error.message);
  process.exitCode = 1;
});
