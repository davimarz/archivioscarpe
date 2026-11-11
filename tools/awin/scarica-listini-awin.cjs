const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline/promises');

const publisherId = process.argv[2] || '';
const account = 'https://ui.awin.com/awin/affiliate/' + publisherId;
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

function pickerSearch(page) {
  return page.getByText('Ricerca advertiser', { exact: true })
    .or(page.getByLabel('Ricerca advertiser', { exact: true }))
    .or(page.getByPlaceholder('Ricerca advertiser', { exact: true }))
    .filter({ visible: true }).first();
}

async function openAdvertiserPicker(page) {
  const search = pickerSearch(page);
  if (await search.isVisible()) return;
  const label = 'Seleziona advertiser';
  const actions = page.getByRole('button', { name: label, exact: true })
    .or(page.getByRole('link', { name: label, exact: true }))
    .filter({ visible: true });
  const text = page.getByText(label, { exact: true }).filter({ visible: true });

  try {
    await actions.or(text).first().waitFor({ timeout: 8000 });
    const actionCount = await actions.count();
    if (actionCount === 1) await actions.click({ timeout: 5000 });
    else if (await text.count() === 1) await text.click({ timeout: 5000 });
    await search.waitFor({ timeout: 5000 });
    return;
  } catch {
    // The user can open the picker if the current Awin layout differs.
  }

  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question('Nella finestra Awin, clicca il pulsante centrale Seleziona advertiser. Quando vedi Ricerca advertiser, premi Invio qui (Q per fermarti): ');
    if (answer.trim().toLowerCase() === 'q') throw new Error('Operazione interrotta');
  } finally {
    terminal.close();
  }
  try {
    await search.waitFor({ timeout: 12000 });
  } catch {
    throw new Error('Dopo il clic non compare la finestra con Ricerca advertiser');
  }
}

async function fillAdvertiserSearch(page, name) {
  const label = 'Ricerca advertiser';
  const named = page.getByLabel(label, { exact: true })
    .or(page.getByPlaceholder(label, { exact: true })).filter({ visible: true }).first();
  if (await named.isVisible()) {
    await named.fill(name);
    return;
  }

  const caption = page.getByText(label, { exact: true }).filter({ visible: true }).first();
  await caption.waitFor();
  const adjacent = caption.locator('xpath=following::input[not(@type) or @type="text" or @type="search"][1]')
    .filter({ visible: true });
  if (await adjacent.isVisible() && await adjacent.isEditable()) {
    await adjacent.fill(name);
    return;
  }

  // Create-a-Feed focuses its search input as soon as the picker opens.
  const focused = page.locator('input:focus:not([type]), input[type="text"]:focus, input[type="search"]:focus')
    .filter({ visible: true });
  if (await focused.count() === 1 && await focused.isEditable()) {
    await focused.fill(name);
    return;
  }
  throw new Error('Campo Ricerca advertiser da identificare');
}

async function verifySavedAdvertiser(page, name) {
  // Outside the picker, Step 1 may render the advertiser and feed in one card.
  await pickerSearch(page).waitFor({ state: 'hidden' });
  const saved = page.getByText(name, { exact: false }).filter({ visible: true });
  try {
    await saved.first().waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    throw new Error('Il nome non compare nel riepilogo Step 1 dopo Salva');
  }
}

async function addAdvertiser(page, name, requestedFormat, batchFormat, clearSelection, setStage) {
  setStage('Apertura di Seleziona advertiser');
  await openAdvertiserPicker(page);
  if (clearSelection) {
    setStage('Preparazione di un gruppo di formato diverso');
    const clear = control(page, 'Deseleziona tutto');
    if (await clear.isVisible()) await clear.click();
  }
  setStage('Ricerca advertiser');
  await fillAdvertiserSearch(page, name);
  console.log(name + ' | scritto in Ricerca advertiser');
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
  await pickerSearch(page).waitFor({ state: 'hidden' });
  if (selected) {
    setStage('Verifica dopo Salva');
    await verifySavedAdvertiser(page, name);
  }
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

function inspectPersonalAdvertisers(waitForRows) {
  const normalize = text => (text ?? '').replace(/\s+/g, ' ').trim();
  const visible = element => element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== 'hidden';
  const titlePattern = /^Advertiser personali(?:\s*\(\s*\d+\s*\))?$/i;
  const heading = [...document.querySelectorAll('body *')].find(element =>
    titlePattern.test(normalize(element.textContent)) && visible(element) &&
    ![...element.children].some(child => titlePattern.test(normalize(child.textContent)) && visible(child))
  );
  if (!heading) return waitForRows ? null : { issue: 'Titolo «Advertiser personali» non visibile.' };

  const tableSelector = 'table, [role="table"], [role="grid"]';
  let table;
  for (let section = heading.parentElement; section && !table; section = section.parentElement) {
    table = [...section.querySelectorAll(tableSelector)].find(candidate => {
      if (!visible(candidate) || !(heading.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        return false;
      }
      const headers = [...candidate.querySelectorAll('th, [role="columnheader"]')];
      if (headers.some(header => /^advertiser$/i.test(normalize(header.innerText)))) return true;
      // Some layouts render the header as ordinary cells.
      const firstRow = candidate.querySelector('tr, [role="row"]');
      const firstCell = firstRow?.querySelector('td, [role="cell"], [role="gridcell"]');
      return /^advertiser$/i.test(normalize(firstCell?.innerText));
    });
  }
  if (!table) return waitForRows ? null : { issue: 'Titolo trovato, ma la tabella sottostante con colonna «Advertiser» non è visibile.' };

  const names = [];
  for (const row of table.querySelectorAll('tr, [role="row"]')) {
    if (!visible(row)) continue;
    const cells = [...row.children].filter(cell => cell.matches('td, [role="cell"], [role="gridcell"]'));
    if (cells.length < 2) continue;
    const name = normalize(cells[0].innerText);
    if (name && !/^advertiser$/i.test(name)) names.push(name);
  }
  if (!names.length) return waitForRows ? null : { issue: 'Tabella trovata, ma la prima colonna non contiene righe visibili.' };
  const count = normalize(heading.textContent).match(/\(\s*(\d+)\s*\)/);
  return { names: [...new Set(names)], total: count ? Number(count[1]) : null };
}

async function readJoinedAdvertisers(page) {
  try {
    const ready = await page.waitForFunction(inspectPersonalAdvertisers, true, { timeout: 30000, polling: 250 });
    const result = await ready.jsonValue();
    if (result.total > result.names.length) {
      console.log('Advertiser personali: ' + result.names.length + ' nomi visibili su ' + result.total + '. Questa esecuzione legge la pagina corrente.');
    }
    return result.names;
  } catch {
    const result = await page.evaluate(inspectPersonalAdvertisers, false);
    if (result.names?.length) return result.names;
    console.error(result.issue);
    return [];
  }
}

function reportFailure(name, stage, error) {
  const safeErrors = [
    'Pagina Awin non disponibile',
    'Campo Ricerca advertiser da identificare',
    'Operazione interrotta',
    'Dopo il clic non compare la finestra con Ricerca advertiser',
    'Nessun feed selezionabile per questo advertiser',
    'Il nome non compare nel riepilogo Step 1 dopo Salva',
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
  console.log('Scarica listini Awin v12');
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
    const active = await readJoinedAdvertisers(page);
    if (!active.length) {
      console.error('Nessun download eseguito.');
      process.exitCode = 1;
      return;
    }
    console.log('Advertiser personali rilevati: ' + active.join(', '));
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
          const result = await addAdvertiser(page, entry.name, entry.format, format, completed > 0 && selected.size === 0, setStage);
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
          await verifySavedAdvertiser(page, name);
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
