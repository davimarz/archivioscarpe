const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const repository = 'https://github.com/davimarz/archivioscarpe.git';
const publicSite = 'https://davimarz.github.io/archivioscarpe/';
const rawBase = 'https://raw.githubusercontent.com/davimarz/archivioscarpe/';
const filesToPublish = ['catalogo-awin.json', 'catalogo-awin-indice.json'];
const feedExtension = /\.(?:(?:csv|tsv|jsonl|ndjson)(?:\.gz)?|gz)$/i;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw new Error('Impossibile avviare ' + path.basename(command) + ': ' + result.error.code);
  if (result.status !== 0) {
    throw new Error(path.basename(command) + ' ha restituito un errore. Il dettaglio è riportato sopra.');
  }
}

async function readJoinedAdvertisers(page) {
  const first = await readAdvertiserPage(page);
  const names = new Set(first.names);

  async function waitForNewRows() {
    const deadline = Date.now() + 10000;
    do {
      const current = await page.evaluate(inspectPersonalAdvertisers, false).catch(() => null);
      const additions = current?.names?.filter(name => !names.has(name));
      if (additions?.length) return additions;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    return [];
  }

  for (let number = 2; names.size && first.total > names.size; number++) {
    const route = '/merchant-directory/index/tab/active/page/' + number;
    const nextLabel = /^(successiv[ao]|next)(?:\s*[›»→])?$/i;
    const pageLabel = new RegExp('^' + number + '$');
    const controls = [
      ['Successivo', page.getByText(nextLabel, { exact: true }).filter({ visible: true })],
      ['pagina ' + number, page.getByRole('link', { name: pageLabel }).or(
        page.getByRole('button', { name: pageLabel })
      ).filter({ visible: true })]
    ];
    let additions = [];
    for (const [label, control] of controls) {
      if (await control.count() !== 1) continue;
      try {
        console.log('Paginazione Awin: clic su «' + label + '».');
        await control.click({ timeout: 5000 });
        additions = await waitForNewRows();
        if (additions.length) break;
      } catch {
        // Try the other visible control or direct navigation.
      }
    }
    if (!additions.length) {
      console.log('Paginazione Awin: apertura diretta di pagina ' + number + '.');
      await open(page, route);
      additions = await waitForNewRows();
    }
    if (!additions.length) {
      console.error('Pagina ' + number + ': nessun nuovo advertiser. Letti ' + names.size + ' di ' + first.total + '.');
      return [];
    }
    additions.forEach(name => names.add(name));
    console.log('Pagina ' + number + ': advertiser letti ' + names.size + ' di ' + first.total + '.');
  }
  return [...names];
}

async function downloadScript(revision, name, destination) {
  const response = await fetch(rawBase + revision + '/tools/awin/' + name, {
    redirect: 'error',
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('Impossibile scaricare ' + name + ' da GitHub (HTTP ' + response.status + ')');
  const source = await response.text();
  const pagination = /^async function readJoinedAdvertisers\(page\) \{[\s\S]*?^\}/m;
  if (!pagination.test(source)) throw new Error('La versione del downloader Awin non contiene il blocco di paginazione atteso.');
  fs.writeFileSync(destination, source.replace(pagination, () => readJoinedAdvertisers.toString()), { flag: 'wx' });
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

async function verifyOnline(repo) {
  const hashes = new Map(filesToPublish.map(name => [
    name, createHash('sha256').update(fs.readFileSync(path.join(repo, name))).digest('hex')
  ]));
  async function matches(name, expected) {
    try {
      const url = new URL(name, publicSite);
      url.searchParams.set('verifica', Date.now().toString());
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        await response.body?.cancel();
        return false;
      }
      const actual = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
      return actual === expected;
    } catch {
      return false;
    }
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    const confirmed = await Promise.all([...hashes].map(([name, expected]) => matches(name, expected)));
    if (confirmed.every(Boolean)) return true;
    if (attempt < 11) await delay(10000);
  }
  return false;
}

async function main() {
  const [publisher, option, ...values] = process.argv.slice(2);
  if (!/^\d+$/.test(publisher || '')) throw new Error('Specifica il tuo Publisher ID Awin.');
  const advertisers = option === '--advertiser' ? values.map(name => name.trim()) : [];
  const source = option === '--da-listini' && values.length === 1 && values[0].trim() ? path.resolve(values[0]) : null;
  if (option !== undefined && !source && (!advertisers.length || advertisers.some(name => !name || name.startsWith('--')) ||
      new Set(advertisers.map(name => name.toLowerCase())).size !== advertisers.length)) {
    throw new Error('Uso: node aggiorna-archivio-scarpe.cjs <publisher-id> [--advertiser <nome> ... | --da-listini <cartella>]');
  }
  const working = fs.mkdtempSync(path.join(os.tmpdir(), 'archivioscarpe-awin-'));
  const staging = path.join(working, 'listini');
  const repo = path.join(working, 'sito');
  const downloadPath = path.join(__dirname, '.scarica-awin-' + randomUUID() + '.cjs');
  const importPath = path.join(repo, 'tools', 'awin', 'importa-listini-awin.cjs');
  let phase = 'Preparazione';
  let preserveWorking = false;
  try {
    fs.mkdirSync(staging);
    if (source) {
      phase = '1/3 Lettura dei listini esistenti';
      console.log(phase + ' | ' + source);
      keepLocalFeeds(source, staging);
    } else {
      await downloadScript('a4bf3cc0ebecadc7450c6180d42a2d2af6407bc2', 'scarica-listini-awin.cjs', downloadPath);
      phase = '1/3 Scaricamento listini';
      console.log(phase);
      if (advertisers.length) console.log('Advertiser richiesti: ' + advertisers.join(', '));
      try {
        run(process.execPath, [downloadPath, publisher, ...advertisers], {
          env: { ...process.env, AWIN_LISTINI_DIR: staging }
        });
        if (advertisers.length && fs.readdirSync(staging).length !== advertisers.length) {
          throw new Error('Il numero di listini ricevuti non coincide con gli advertiser richiesti.');
        }
      } catch (error) {
        if (fs.readdirSync(staging).some(name => feedExtension.test(name))) {
          const recoveries = path.join(__dirname, 'LISTINI-PARZIALI');
          try {
            fs.mkdirSync(recoveries, { recursive: true });
            const saved = fs.mkdtempSync(path.join(recoveries, 'download-'));
            const retained = keepLocalFeeds(staging, saved);
            console.error('Listini parziali conservati: ' + retained + ' | ' + saved);
          } catch {
            preserveWorking = true;
            console.error('Listini parziali disponibili nella cartella temporanea: ' + staging);
          }
        }
        throw error;
      }
    }
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
    if (!await verifyOnline(repo)) {
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
    if (!preserveWorking) fs.rmSync(working, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('Aggiornamento interrotto: ' + error.message);
  process.exitCode = 1;
});
