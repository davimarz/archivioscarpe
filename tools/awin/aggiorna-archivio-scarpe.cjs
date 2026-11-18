const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const repository = 'https://github.com/davimarz/archivioscarpe.git';
const publicSite = 'https://davimarz.github.io/archivioscarpe/';
const rawBase = 'https://raw.githubusercontent.com/davimarz/archivioscarpe/';
const filesToPublish = ['catalogo-awin.json', 'catalogo-awin-indice.json', 'catalogo-awin-report.json'];
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

  async function waitForNewRows(timeout = 10000) {
    const deadline = Date.now() + timeout;
    do {
      const current = await page.evaluate(inspectPersonalAdvertisers, false).catch(() => null);
      const additions = current?.names?.filter(name => !names.has(name));
      if (additions?.length) return additions;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (!page.isClosed() && Date.now() < deadline);
    return [];
  }

  async function expandResults() {
    const sizeLabel = page.getByText(/^Risultati per pagina\s*:?$/i).filter({ visible: true });
    if (await sizeLabel.count() === 1) {
      const currentValue = sizeLabel.locator('xpath=..').getByText(String(first.names.length), { exact: true })
        .filter({ visible: true });
      try {
        await (await currentValue.count() === 1 ? currentValue : sizeLabel).click({ timeout: 5000 });
        for (const size of [100, 50, 25, 20]) {
          if (size <= first.names.length) continue;
          const value = page.getByText(String(size), { exact: true }).filter({ visible: true });
          if (await value.count() !== 1) continue;
          console.log('Paginazione Awin: imposta «Risultati per pagina» su ' + size + '.');
          await value.click({ timeout: 5000 });
          const additions = await waitForNewRows();
          return additions;
        }
      } catch {
        // Manual recovery remains available.
      }
    }
    return [];
  }

  for (let number = 2; names.size && first.total > names.size; number++) {
    const nextLabel = /^(successiv[ao]|next)(?:\s*[›»→])?$/i;
    const pageLabel = new RegExp('^' + number + '$');
    const controls = [
      ['Successivo', page.getByText(nextLabel).filter({ visible: true })],
      ['Successivo', page.getByRole('button', { name: nextLabel }).or(
        page.getByRole('link', { name: nextLabel })
      ).filter({ visible: true })],
      ['numero ' + number, page.getByText(String(number), { exact: true }).filter({ visible: true })],
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
        // If the control changed, try the next visible control.
      }
    }
    if (!additions.length && number === 2 && !page.isClosed()) additions = await expandResults();
    if (!additions.length && !page.isClosed()) {
      console.log('Awin non ha cambiato pagina in automatico.');
      console.log('Nella finestra Awin aperta, in «Iscritto», imposta «Risultati per pagina» su 25 o più, se disponibile, oppure clicca sulla pagina ' + number + '.');
      console.log('Lo script attende nuovi advertiser per 2 minuti e riprende automaticamente.');
      additions = await waitForNewRows(120000);
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

async function openAwinRoute(page, route) {
  const label = route.startsWith('/merchant-directory') ? 'Iscritto' : 'Create-a-Feed';
  const temporary = /^(?:HTTP (?:408|429|5\d\d)|ERR_(?:ABORTED|TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED)|TIMEOUT)$/;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let reason;
    try {
      const response = await page.goto(account + route, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (response?.ok()) return;
      const status = response?.status();
      reason = Number.isInteger(status) ? 'HTTP ' + status : 'nessuna risposta HTTP';
    } catch (error) {
      const info = String(error?.message);
      reason = info.match(/\bERR_[A-Z0-9_]+\b/)?.[0] ||
        (error?.name === 'TimeoutError' ? 'TIMEOUT' : page.isClosed() ? 'finestra chiusa' : 'errore del browser');
    }
    const message = 'Navigazione Awin — ' + label + ': ' + reason;
    if (attempt === 3 || page.isClosed() || !temporary.test(reason)) throw new Error(message);
    console.log(message + ' (tentativo ' + attempt + ' di 3; riprovo).');
    await new Promise(resolve => setTimeout(resolve, attempt * 2000));
  }
}

async function clickCreateFeedNext(page) {
  if (!/\/datafeed\/step-one\/?$/.test(new URL(page.url()).pathname)) {
    throw new Error('Il passaggio iniziale di Create-a-Feed non è aperto');
  }
  const name = 'Successivo';
  const candidates = page.getByRole('button', { name, exact: true })
    .or(page.getByRole('link', { name, exact: true }))
    .or(page.getByText(name, { exact: true })).filter({ visible: true });
  await candidates.first().waitFor({ state: 'visible' });
  const index = await candidates.evaluateAll(elements => elements
    .map((element, index) => ({ index, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect.right > document.documentElement.clientWidth / 2)
    .sort((a, b) => a.rect.top - b.rect.top || b.rect.right - a.rect.right)[0]?.index ?? -1);
  if (index < 0) throw new Error('Pulsante Successivo in alto a destra non trovato');
  await candidates.nth(index).click({ timeout: 15000 });
}

function addOfficialFeedRecovery(source) {
  return source
    .replace(/^async function downloadBatch\(/m, () =>
      clickCreateFeedNext.toString() + '\n\nasync function downloadBatch(')
    .replace("  await control(page, 'Successivo').click();\n  console.log(name + ' | premuto Successivo');",
      "  await clickCreateFeedNext(page);\n  console.log(name + ' | clic su Successivo in alto a destra');")
    .replace("  const safeErrors = [",
      "  const safeErrors = [\n    'Il passaggio iniziale di Create-a-Feed non è aperto',\n    'Pulsante Successivo in alto a destra non trovato',")
    .replace("['onestreet', 'voghion global'].includes",
      "['onestreet', 'voghion global', 'yesshop', 'perletti - ombrelli per passione it', 'marco cerullo'].includes")
    .replace(
      "  await button.waitFor({ state: 'visible' });\n  if (name.trim()",
      "  try {\n    await button.waitFor({ state: 'visible' });\n  } catch (error) {\n" +
      "    if (!listUrl || error?.name !== 'TimeoutError') throw error;\n" +
      "    setStage('Recupero tramite Scarica lista Feed');\n" +
      "    console.log(name + ' | pagina di esportazione lenta: cerco il link nella lista ufficiale Awin');\n" +
      "    return saveListedFeed(page, name, setStage, listUrl);\n" +
      "  }\n  if (name.trim()"
    )
    .replace("  setStage('Verifica del nome del file');",
      "  return saveFeedFile(exportFile, name, setStage);\n}\n\n" +
      "async function saveListedFeed(page, name, setStage, listUrl) {\n" +
      "  const url = await findListedFeed(page, listUrl, name);\n" +
      "  const exportFile = await fetchGeneratedExport(page, name, enhancedUiExportUrl(url) || url);\n" +
      "  return saveFeedFile(exportFile, name, setStage);\n}\n\n" +
      "async function saveFeedFile(exportFile, name, setStage) {\n" +
      "  setStage('Verifica del nome del file');");
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
  const patched = source.replace(pagination, () => readJoinedAdvertisers.toString())
    .replace(/^async function open\(page, route\) \{[\s\S]*?^\}/m,
      () => openAwinRoute.toString().replace('function openAwinRoute(', 'function open('))
    .replace('const message = safeErrors.includes(error.message) ?',
      "const message = error.message.startsWith('Navigazione Awin — ') || safeErrors.includes(error.message) ?")
    .replace('main().catch(() => {', 'main().catch(error => {')
    .replace(
      'Impossibile aprire la scheda Iscritto. Controlla che il profilo Playwright sia libero e che Awin sia raggiungibile.',
      "' + (String(error?.message).startsWith('Navigazione Awin — ') ? error.message : /launchPersistentContext|ProcessSingleton|user data directory|profile.*in use/i.test(String(error?.message)) ? 'Avvio di Playwright fallito. Chiudi le finestre Awin aperte da questo script e controlla che il browser Playwright sia installato.' : /ERR_|page\\.goto|Pagina Awin non disponibile/i.test(String(error?.message)) ? 'Navigazione Awin fallita prima del download.' : 'Errore Playwright prima di completare il download.') + '"
    );
  fs.writeFileSync(destination, addOfficialFeedRecovery(patched), { flag: 'wx' });
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
  const resume = option === '--completa-listini';
  const recovery = resume && values[0]?.trim() ? path.resolve(values[0]) : null;
  const advertisers = option === '--advertiser' || resume ? values.slice(resume ? 1 : 0).map(name => name.trim()) : [];
  const source = option === '--da-listini' && values.length === 1 && values[0].trim() ? path.resolve(values[0]) : null;
  if ((resume && !recovery) || (option !== undefined && !source && (!advertisers.length || advertisers.some(name => !name || name.startsWith('--')) ||
      new Set(advertisers.map(name => name.toLowerCase())).size !== advertisers.length))) {
    throw new Error('Uso: node aggiorna-archivio-scarpe.cjs <publisher-id> [--advertiser <nome> ... | --da-listini <cartella> | --completa-listini <cartella> <nome> ...]');
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
    if (recovery && !fs.statSync(recovery).isDirectory()) throw new Error('Cartella di recupero non valida.');
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
        if (recovery && fs.readdirSync(staging).some(name => feedExtension.test(name))) {
          preserveWorking = true;
          keepLocalFeeds(staging, recovery);
          preserveWorking = false;
          console.error('Nuovi listini salvati in ' + recovery);
        } else if (fs.readdirSync(staging).some(name => feedExtension.test(name))) {
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
    if (recovery) {
      preserveWorking = true;
      keepLocalFeeds(staging, recovery);
      preserveWorking = false;
      fs.rmSync(staging, { recursive: true });
      keepLocalFeeds(recovery, staging);
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
