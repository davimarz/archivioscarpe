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

async function openAdvertiserPicker(page) {
  const sectionTitles = page.getByText('Advertiser', { exact: true }).filter({ visible: true });
  const selectText = page.getByText('Seleziona advertiser', { exact: true }).filter({ visible: true });
  const searchCaption = page.getByText('Ricerca advertiser', { exact: true })
    .or(page.getByLabel('Ricerca advertiser', { exact: true }))
    .or(page.getByPlaceholder('Ricerca advertiser', { exact: true }))
    .filter({ visible: true }).first();

  await selectText.first().waitFor();
  const titles = await sectionTitles.all();
  let containers = titles;
  let selectButton;
  // Prefer the closest container with both the section title and the action.
  for (let depth = 0; depth < 4 && !selectButton; depth++) {
    containers = containers.map(container => container.locator('..'));
    for (const container of containers) {
      const candidate = container.getByText('Seleziona advertiser', { exact: true }).filter({ visible: true });
      if (await candidate.count() === 1) {
        selectButton = candidate;
        break;
      }
    }
  }
  if (!selectButton && await selectText.count() === 1) selectButton = selectText;
  if (!selectButton) throw new Error('Pulsante del riquadro centrale Advertiser non identificato');
  await selectButton.click();
  try {
    await searchCaption.waitFor({ state: 'visible', timeout: 12000 });
  } catch {
    throw new Error('Dopo il clic non compare la finestra con Ricerca advertiser');
  }
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

async function addAdvertiser(page, name, requestedFormat, batchFormat, clearSelection, setStage) {
  setStage('Apertura di Seleziona advertiser');
  await openAdvertiserPicker(page);
  if (clearSelection) {
    const clear = control(page, 'Deseleziona tutto');
    if (await clear.isVisible() && await clear.isEnabled()) await clear.click();
  }
  setStage('Ricerca advertiser');
  await fillAdvertiserSearch(page, name);
  setStage('Attesa della riga del feed');
  const rows = page.getByRole('row').filter({
    has: page.getByRole('cell', { name, exact: true })
  }).filter({ visible: true });
  await rows.first().waitFor({ timeout: 10000 });

  const feeds = [];
  for (const row of await rows.all()) {
    const checkbox = row.getByRole('checkbox');
    if (await checkbox.count() !== 1) continue;
    // Create-a-Feed lists the format in the third cell, after ID and advertiser.
    const format = (await row.getByRole('cell').nth(2).innerText()).trim().toLowerCase();
    if (format) feeds.push({ format, checkbox });
  }
  if (!feeds.length) throw new Error('Nessun feed selezionabile per questo advertiser');
  const formats = [...new Set(feeds.map(feed => feed.format))];
  const format = batchFormat ?? requestedFormat ?? formats[0];
  const desired = requestedFormat ? [requestedFormat] : formats;
  const deferred = desired.filter(value => value !== format);
  let selected = 0;
  setStage('Selezione del feed');
  if (desired.includes(format)) {
    for (const feed of feeds.filter(feed => feed.format === format)) {
      if (!await feed.checkbox.isEnabled()) continue;
      await feed.checkbox.check();
      selected++;
    }
  }
  setStage('Salva');
  await control(page, 'Salva').click();
  await rows.first().waitFor({ state: 'hidden' });
  if (!selected && !deferred.length) throw new Error('Nessun feed selezionabile per questo advertiser');
  return { format, selected, deferred };
}

async function downloadBatch(page, name, setStage) {
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

  setStage('Formato ZIP');
  const zip = page.getByRole('radio', { name: 'zip', exact: true }).filter({ visible: true });
  if (await zip.count() === 1 && await zip.isEnabled()) await zip.check();

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

function reportFailure(name, stage, error) {
  const safeErrors = [
    'Pagina Awin non disponibile',
    'Campo Ricerca advertiser da identificare',
    'Pulsante del riquadro centrale Advertiser non identificato',
    'Dopo il clic non compare la finestra con Ricerca advertiser',
    'Nessun feed selezionabile per questo advertiser',
    'Formato del download da verificare',
    'File scaricato vuoto'
  ];
  const message = safeErrors.includes(error.message) ? error.message : 'Passaggio non completato nella pagina Awin';
  console.log(name + ' | errore al passaggio «' + stage + '» | ' + message);
  process.exitCode = 1;
}

async function main() {
  if (!/^\d+$/.test(publisherId)) {
    console.error('Uso: node scarica-listini-awin.cjs <publisher-id>');
    process.exitCode = 1;
    return;
  }
  console.log('Scarica listini Awin v7');
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
    let pending = active.map(name => ({ name, format: null }));
    while (pending.length) {
      const deferred = [];
      const selected = new Set();
      let format = null;
      let selectionFailed = false;
      let stage = 'Apertura di Create-a-Feed';
      const setStage = value => { stage = value; };
      await open(page, '/datafeed/step-one');

      for (const entry of pending) {
        try {
          const result = await addAdvertiser(page, entry.name, entry.format, format, selected.size === 0, setStage);
          deferred.push(...result.deferred.map(value => ({ name: entry.name, format: value })));
          if (result.selected) {
            format = result.format;
            selected.add(entry.name);
            console.log(entry.name + ' | selezionato | ' + result.selected + ' feed');
          }
        } catch (error) {
          reportFailure(entry.name, stage, error);
          selectionFailed = true;
          break;
        }
      }

      if (selectionFailed || !selected.size) break;
      const label = 'feed-' + format;
      try {
        setStage('Verifica della selezione salvata');
        for (const name of selected) {
          await page.getByText(name, { exact: true }).filter({ visible: true }).first().waitFor();
        }
        console.log('Download del gruppo ' + format + ': ' + [...selected].join(', '));
        await downloadBatch(page, label, setStage);
        completed++;
      } catch (error) {
        reportFailure(label, stage, error);
      }
      pending = deferred;
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
