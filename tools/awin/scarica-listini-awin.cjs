const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline/promises');

const publisherId = process.argv[2] || '';
const account = 'https://ui.awin.com/awin/affiliate/' + publisherId;
const advertisers = ['Cisalfa Sport IT', 'Marco Cerullo', 'Voghion Global', 'OneStreet'];
const profile = path.join(__dirname, '.awin-profile');
const output = path.join(__dirname, 'listini-' + new Date().toISOString().replace(/[:.]/g, '-'));

function control(page, name) {
  return page.getByRole('button', { name, exact: true })
    .or(page.getByRole('link', { name, exact: true }))
    .or(page.getByText(name, { exact: true }))
    .filter({ visible: true }).first();
}

async function open(page, route) {
  const response = await page.goto(account + route, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new Error('Pagina Awin non disponibile');
}

async function fillAdvertiserSearch(page, name) {
  const label = 'Ricerca advertiser';
  const named = page.getByLabel(label, { exact: true })
    .or(page.getByPlaceholder(label, { exact: true })).filter({ visible: true }).first();
  const caption = page.getByText(label, { exact: true }).filter({ visible: true }).first();
  await named.or(caption).first().waitFor();
  if (await named.isVisible()) {
    await named.fill(name);
    return;
  }

  // Awin may render the caption as plain text without linking it to the input.
  let container = caption;
  for (let depth = 0; depth < 5; depth++) {
    container = container.locator('..');
    const inputs = container.locator('input:not([type]), input[type="text"], input[type="search"]')
      .filter({ visible: true });
    const count = await inputs.count();
    if (count === 1 && await inputs.isEditable()) {
      await inputs.fill(name);
      return;
    }
    if (count > 1) break;
  }
  throw new Error('Campo Ricerca advertiser da identificare');
}

async function saveFeed(page, name, setStage) {
  setStage("Apertura di Create-a-Feed");
  await open(page, '/datafeed/step-one');
  setStage('Apertura di Seleziona advertiser');
  await control(page, 'Seleziona advertiser').click();
  const clear = control(page, 'Deseleziona tutto');
  if (await clear.isVisible()) await clear.click();
  setStage('Ricerca advertiser');
  await fillAdvertiserSearch(page, name);
  setStage('Attesa della riga del feed');
  const row = page.getByRole('row').filter({
    has: page.getByRole('cell', { name, exact: true })
  }).filter({ visible: true }).first();
  await row.waitFor({ timeout: 10000 });
  const boxes = page.getByRole('row').filter({
    has: page.getByRole('cell', { name, exact: true })
  }).filter({ visible: true }).getByRole('checkbox');
  if (await boxes.count() !== 1) throw new Error('Più feed da scegliere per questo advertiser');
  setStage('Selezione del feed');
  await boxes.check();
  setStage('Salva');
  await control(page, 'Salva').click();
  setStage('Successivo');
  await control(page, 'Successivo').click();

  setStage('Selezione delle colonne');
  const columns = page.getByRole('checkbox', { name: 'Seleziona tutti', exact: true })
    .filter({ visible: true });
  if (await columns.count() === 1) await columns.check();
  for (const field of ['size', 'category']) {
    const checkbox = page.getByRole('checkbox', { name: field, exact: true }).filter({ visible: true });
    if (await checkbox.count() === 1 && await checkbox.isEnabled()) await checkbox.check();
  }

  setStage('Scarica feed di prodotto');
  const button = control(page, 'Scarica feed di prodotto');
  await button.waitFor();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    button.click()
  ]);
  setStage('Verifica del nome del file');
  const original = path.basename(download.suggestedFilename());
  if (!/\.(csv|tsv|gz|gzip|zip|jsonl?|xml)$/i.test(original)) {
    throw new Error('Formato del download da verificare');
  }
  const filename = name.replace(/[^a-z0-9]+/gi, '-') + '-' + original.replace(/[^a-z0-9._-]/gi, '_');
  const destination = path.join(output, filename);
  setStage('Salvataggio del file');
  const temporary = path.join(__dirname, path.basename(output) + '-' + filename + '.part');
  let file;
  try {
    await download.saveAs(temporary);
    file = await fs.stat(temporary);
    if (!file.size) throw new Error('File scaricato vuoto');
    await fs.mkdir(output, { recursive: true });
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    await fs.rmdir(output).catch(() => {});
    throw error;
  }
  console.log(name + ' | scaricato | ' + file.size + ' byte | ' + filename);
}

async function readJoinedAdvertisers(page) {
  const entries = advertisers.map(name =>
    page.getByText(name, { exact: true }).filter({ visible: true })
  );
  const anyEntry = entries.reduce((combined, entry) => combined.or(entry)).first();
  await anyEntry.waitFor({ state: 'visible', timeout: 30000 });
  const found = await Promise.all(entries.map(entry => entry.first().isVisible()));
  return advertisers.filter((name, index) => found[index]);
}

async function main() {
  if (!/^\d+$/.test(publisherId)) {
    console.error('Uso: node scarica-listini-awin.cjs <publisher-id>');
    process.exitCode = 1;
    return;
  }
  console.log('Scarica listini Awin v5');
  const browser = await chromium.launchPersistentContext(profile, { headless: false, acceptDownloads: true });
  try {
    const page = browser.pages()[0] ?? await browser.newPage();
    page.setDefaultTimeout(12000);
    await open(page, '/merchant-directory/index/tab/active/page/1');
    const joinedTab = control(page, 'Iscritto');
    if (!await joinedTab.isVisible()) {
      const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        await terminal.question('Accedi ad Awin nella finestra aperta, poi premi Invio qui: ');
      } finally {
        terminal.close();
      }
      await open(page, '/merchant-directory/index/tab/active/page/1');
    }
    await joinedTab.waitFor();
    let active;
    try {
      active = await readJoinedAdvertisers(page);
    } catch {
      console.log('La scheda Iscritto è visibile, ma non ho identificato i nomi dei programmi entro 30 secondi.');
      const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        await terminal.question('Controlla che la tabella sia visibile. Premi Invio per rileggere la pagina: ');
      } finally {
        terminal.close();
      }
      try {
        active = await readJoinedAdvertisers(page);
      } catch {
        console.error('Nessun programma riconosciuto nella scheda Iscritto. Nessun download eseguito.');
        process.exitCode = 1;
        return;
      }
    }
    console.log('Programmi riconosciuti: ' + active.join(', '));
    for (const name of advertisers.filter(name => !active.includes(name))) {
      console.log(name + ' | non rilevato nella pagina dei programmi iscritti');
    }
    let completed = 0;
    for (const name of active) {
      let stage = 'Avvio';
      try {
        await saveFeed(page, name, value => { stage = value; });
        completed++;
      } catch (error) {
        const safeErrors = [
          'Pagina Awin non disponibile',
          'Campo Ricerca advertiser da identificare',
          'Più feed da scegliere per questo advertiser',
          'Formato del download da verificare',
          'File scaricato vuoto'
        ];
        const message = safeErrors.includes(error.message) ? error.message : 'Passaggio non completato nella pagina Awin';
        console.log(name + ' | errore al passaggio «' + stage + '» | ' + message);
        process.exitCode = 1;
      }
    }
    if (completed) console.log('Cartella dei listini (' + completed + '): ' + output);
    else console.log('Nessun listino salvato.');
  } finally {
    await browser.close();
  }
}
main().catch(() => {
  console.error('Impossibile aprire la scheda Iscritto. Controlla che il profilo Playwright sia libero e che Awin sia raggiungibile.');
  process.exitCode = 1;
});
