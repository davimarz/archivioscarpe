const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');

const publisherId = process.argv[2] || '';
const account = 'https://ui.awin.com/awin/affiliate/' + publisherId;
const profile = path.join(__dirname, '.awin-profile');
const output = process.env.AWIN_LISTINI_DIR ? path.resolve(process.env.AWIN_LISTINI_DIR) : path.join(__dirname, 'LISTINI');

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

async function addAdvertiser(page, name, setStage, clearPrevious) {
  setStage('Apertura di Seleziona advertiser');
  await openAdvertiserPicker(page);
  if (clearPrevious) {
    setStage('Azzera selezione precedente');
    const clear = page.getByText('Deseleziona tutto', { exact: true }).filter({ visible: true }).last();
    await clear.click({ timeout: 6000 });
  }
  setStage('Ricerca advertiser');
  await fillAdvertiserSearch(page, name);
  console.log(name + ' | scritto in Ricerca advertiser');
  setStage('Attesa della riga del feed');
  const rows = page.getByRole('row').filter({
    has: page.getByRole('cell', { name, exact: true })
  }).filter({ visible: true });
  await rows.first().waitFor({ timeout: 10000 });

  let selected = 0;
  let unavailable = 0;
  let unidentified = 0;
  setStage('Selezione del feed');
  for (const row of await rows.all()) {
    const native = row.locator('input[type="checkbox"]');
    const checkbox = await native.count() === 1 ? native : row.getByRole('checkbox');
    if (await checkbox.count() !== 1) {
      unidentified++;
      continue;
    }
    if (!await checkbox.isChecked()) {
      if (!await checkbox.isEnabled()) {
        unavailable++;
        continue;
      }
      try {
        if (await checkbox.isVisible()) {
          await checkbox.check({ timeout: 4000 });
        } else {
          const label = row.locator('label').filter({ visible: true });
          if (await label.count() === 1) await label.click({ timeout: 4000 });
        }
      } catch {
        // The checked state below determines whether the selection succeeded.
      }
    }
    if (await checkbox.isChecked()) selected++;
  }

  if (!selected) {
    console.log(name + ' | righe con casella disabilitata: ' + unavailable +
      ' | righe senza casella riconosciuta: ' + unidentified);
    throw new Error('Nessun feed selezionabile per questo advertiser');
  }
  setStage('Salva');
  await control(page, 'Salva').click();
  setStage('Verifica dopo Salva');
  await verifySavedAdvertiser(page, name);
  return selected;
}

async function visibleAwinUrls(page) {
  return page.evaluate(() => {
    const values = [];
    const visible = element => element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility === 'visible';
    for (const element of document.querySelectorAll('textarea, input, a[href]')) {
      if (visible(element)) values.push(element.value || element.getAttribute('href') || '');
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeValue.includes('awin.com') && visible(node.parentElement)) {
        values.push(node.nodeValue);
      }
    }
    return values.flatMap(value => value.match(/https:\/\/(?:productdata|ui)\.awin\.com\/[^\s"'<>]+/gi) || []);
  }).catch(() => []);
}

function isExportUrl(value) {
    try {
      const parsed = new URL(value);
      if (parsed.origin === 'https://productdata.awin.com') {
        return parsed.pathname.startsWith('/datafeed/download/');
      }
      if (parsed.origin !== 'https://ui.awin.com') return false;
      const prefix = '/productdata-darwin-download/publisher/' + publisherId + '/';
      return parsed.pathname.startsWith(prefix) &&
        /^[^/]+\/\d+\/feed\/[A-Z0-9,]+\.(?:(?:csv|jsonl|ndjson)(?:\.gz)?|zip)$/i.test(parsed.pathname.slice(prefix.length));
    } catch {
      return false;
    }
}

async function generatedExportUrl(page) {
  return (await visibleAwinUrls(page)).find(isExportUrl);
}

function readCsvRows(csv) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && char === ',') {
      row.push(field);
      field = '';
    } else if (!quoted && (char === '\r' || char === '\n')) {
      if (char === '\r' && csv[index + 1] === '\n') index++;
      rows.push([...row, field]);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('CSV della lista Awin non valido');
  if (row.length || field) rows.push([...row, field]);
  return rows;
}

function usesListedFeedFallback(name) {
  return ['onestreet', 'voghion global'].includes(name.trim().toLowerCase());
}

async function findListedFeed(page, listUrl, name) {
  if (!listUrl) throw new Error('Link Scarica lista Feed non trovato nella pagina Awin');
  const response = await page.request.get(listUrl, { timeout: 45000, maxRedirects: 0 });
  try {
    if (!response.ok()) {
      console.log(name + ' | lista feed Awin: HTTP ' + response.status());
      throw new Error('Impossibile leggere la lista feed Awin');
    }
    const [header = [], ...rows] = readCsvRows(await response.text());
    const columns = header.map(value => value.trim().toLowerCase());
    const advertiser = columns.indexOf('advertiser name');
    const membership = columns.indexOf('membership status');
    const url = columns.indexOf('url');
    if ([advertiser, membership, url].includes(-1)) {
      throw new Error('Colonne della lista feed Awin non riconosciute');
    }
    const matches = rows.filter(row => row[advertiser]?.trim().toLowerCase() === name.toLowerCase() &&
      row[membership]?.trim().toLowerCase() === 'active');
    const links = [...new Set(matches.map(row => row[url]?.trim()).filter(Boolean))].filter(isExportUrl);
    if (links.length !== 1) {
      console.log(name + ' | righe attive nella lista: ' + matches.length + ' | link di download compatibili: ' + links.length);
      throw new Error('La lista Awin non identifica un solo link di download per questo advertiser');
    }
    return links[0];
  } finally {
    await response.dispose();
  }
}

async function getFeedListUrl(page) {
  const prefix = 'https://ui.awin.com/productdata-darwin-download/publisher/' + publisherId + '/';
  return (await visibleAwinUrls(page)).find(value =>
    value.startsWith(prefix) && /^[a-z0-9_-]+\/\d+\/feedList$/i.test(value.slice(prefix.length))
  );
}

function exportExtension(bytes, type) {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'zip';
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gz';
  const firstLine = bytes.subarray(0, 262144).toString('utf8').trimStart().split(/\r?\n/, 1)[0];
  if (/^</.test(firstLine)) return null;
  if (firstLine.startsWith('{')) {
    try {
      const record = JSON.parse(firstLine);
      const product = record.product_basic ?? record.product ?? record;
      if (product && (product.id || product.offerId || product.gtin || product.title || product.product_name)) {
        return 'jsonl';
      }
    } catch {
      return null;
    }
    return null;
  }
  const isFeedHeader = /(?:^|[,;|\t])"?(?:id|product_name|aw_product_id|title)"?(?:[,;|\t]|$)/i.test(firstLine) &&
    /(?:^|[,;|\t])"?(?:price|search_price|store_price|link|aw_deep_link|availability)"?(?:[,;|\t]|$)/i.test(firstLine);
  return firstLine && (/^text\/csv\b/i.test(type) || isFeedHeader) ? 'csv' : null;
}

async function fetchGeneratedExport(page, name, url) {
  if (!url) throw new Error('Awin non ha avviato il download e non mostra un URL di esportazione utilizzabile');
  console.log(name + ' | uso il link di esportazione generato da Create-a-Feed');
  let response;
  try {
    response = await page.request.get(url, { timeout: 120000, maxRedirects: 5 });
  } catch {
    throw new Error('Richiesta del file Awin non completata');
  }
  try {
    if (!response.ok()) {
      console.log(name + ' | risposta del server Awin: HTTP ' + response.status());
      throw new Error('Awin non ha restituito un file di listino valido');
    }
    const bytes = await response.body();
    const type = response.headers()['content-type'] ?? '';
    const extension = exportExtension(bytes, type);
    if (!extension) throw new Error('Awin non ha restituito un file di listino valido');
    return {
      suggestedFilename: () => 'listino.' + extension,
      saveAs: filename => fs.writeFile(filename, bytes)
    };
  } finally {
    await response.dispose();
  }
}

function enhancedUiExportUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.origin !== 'https://productdata.awin.com') return null;
  const parts = url.pathname.split('/');
  const key = parts[parts.indexOf('apikey') + 1];
  const feedIds = parts[parts.indexOf('fid') + 1];
  if (!parts.includes('apikey') || !parts.includes('fid') ||
      !/^[a-z0-9_-]+$/i.test(key ?? '') ||
      !/^F\d+(?:,F\d+)*$/i.test(feedIds ?? '')) return null;
  return 'https://ui.awin.com/productdata-darwin-download/publisher/' +
    publisherId + '/' + key + '/1/feed/' + feedIds + '.csv.gz';
}

function observeBrowserDownload(page) {
  const context = page.context();
  const watched = new Set();
  let resolveDownload;
  const received = new Promise(resolve => { resolveDownload = resolve; });
  const onDownload = download => resolveDownload(download);
  const watch = tab => {
    if (watched.has(tab)) return;
    watched.add(tab);
    tab.on('download', onDownload);
  };
  context.on('page', watch);
  watch(page);
  return {
    async wait(milliseconds) {
      let timer;
      try {
        return await Promise.race([received, new Promise(resolve => {
          timer = setTimeout(() => resolve(null), milliseconds);
        })]);
      } finally {
        clearTimeout(timer);
      }
    },
    tabs: () => [...watched],
    stop() {
      context.off('page', watch);
      for (const tab of watched) tab.off('download', onDownload);
    }
  };
}

const comparisonColumns = [
  'aw_deep_link', 'merchant_deep_link', 'product_name', 'description', 'merchant_name',
  'merchant_id', 'data_feed_id', 'aw_product_id', 'merchant_product_id', 'parent_product_id',
  'product_GTIN', 'ean', 'upc', 'mpn', 'brand_name', 'product_model', 'model_number',
  'colour', 'size', 'category', 'category_name', 'merchant_category',
  'merchant_product_category_path', 'product_type', 'search_price', 'store_price',
  'display_price', 'product_price_old', 'rrp_price', 'saving', 'savings_percent',
  'currency', 'delivery_cost', 'in_stock', 'stock_status', 'size_stock_status',
  'merchant_image_url', 'aw_image_url', 'last_updated', 'commission_group',
  'category_id', 'language', 'brand_id', 'condition', 'product_short_description',
  'merchant_product_second_category', 'merchant_product_third_category',
  'valid_from', 'valid_to', 'is_for_sale', 'stock_quantity', 'size_stock_amount',
  'delivery_restrictions', 'delivery_time', 'large_image'
];

async function columnCheckbox(page, field) {
  const labelled = page.getByRole('checkbox', { name: field, exact: true })
    .or(page.getByLabel(field, { exact: true }).and(page.locator('input[type="checkbox"]')))
    .filter({ visible: true });
  if (await labelled.count() === 1) return labelled;

  // The selected-column summary repeats names, so only use a nearby input.
  const captions = page.getByText(field, { exact: true }).filter({ visible: true });
  for (const caption of await captions.all()) {
    const nearby = caption.locator('xpath=ancestor-or-self::*[count(.//input[@type="checkbox"])=1][1]')
      .locator('input[type="checkbox"]').filter({ visible: true });
    if (await nearby.count() === 1) return nearby;
  }
  return null;
}

async function selectComparisonColumns(page, name) {
  const recommended = await columnCheckbox(page, 'Consigliato');
  if (recommended && await recommended.isEnabled() && !await recommended.isChecked()) {
    await recommended.check({ timeout: 2500 }).catch(() => {});
  }
  let included = 0;
  const skipped = [];
  for (const field of comparisonColumns) {
    const checkbox = await columnCheckbox(page, field);
    if (!checkbox) continue;
    try {
      if (!await checkbox.isChecked() && await checkbox.isEnabled()) {
        await checkbox.check({ timeout: 2500 });
      }
      if (await checkbox.isChecked()) included++;
      else skipped.push(field);
    } catch {
      skipped.push(field);
    }
  }
  console.log(name + (included ? ' | colonne di confronto incluse: ' + included :
    ' | colonne non configurabili: uso il tracciato fornito da Awin'));
  if (skipped.length) console.log(name + ' | campi individuati ma non selezionati: ' + skipped.join(', '));
}

const feedExtensions = ['.csv.gz', '.tsv.gz', '.jsonl.gz', '.ndjson.gz', '.xml.gz',
  '.csv', '.tsv', '.jsonl', '.ndjson', '.json', '.xml', '.gz', '.gzip', '.zip'];

function advertiserFilename(name) {
  let filename = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '');
  if (!filename) throw new Error('Nome advertiser non valido per il salvataggio');
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(filename)) filename = '_' + filename;
  return filename;
}

async function storeAdvertiserFeed(temporary, name, extension) {
  const basename = advertiserFilename(name);
  const filename = basename + extension;
  await fs.mkdir(output, { recursive: true });
  await fs.rename(temporary, path.join(output, filename));
  for (const oldExtension of feedExtensions) {
    if (oldExtension === extension) continue;
    try {
      await fs.rm(path.join(output, basename + oldExtension), { force: true });
    } catch {
      console.warn(name + ' | un precedente file con estensione ' + oldExtension + ' non è stato rimosso');
    }
  }
  return filename;
}

async function downloadBatch(page, name, setStage, listUrl) {
  setStage('Successivo');
  await control(page, 'Successivo').click();
  console.log(name + ' | premuto Successivo');

  setStage('Attesa della pagina di esportazione');
  const button = control(page, 'Scarica feed di prodotto');
  await button.waitFor({ state: 'visible' });
  if (name.trim().toLowerCase() === 'onestreet') {
    console.log(name + ' | download diretto con le impostazioni Awin');
  } else {
    setStage('Selezione delle colonne di confronto');
    await selectComparisonColumns(page, name);
  }
  setStage('Scarica feed di prodotto');
  const exportUrl = await generatedExportUrl(page);
  const observer = observeBrowserDownload(page);
  let download;
  try {
    try {
      await button.click({ timeout: 12000 });
      console.log(name + ' | clic su Scarica feed di prodotto');
    } catch {
      console.log(name + ' | pulsante di download non azionabile');
    }
    setStage('Attesa del file');
    console.log(name + ' | attendo il file da Awin, anche se si apre una nuova scheda');
    download = await observer.wait(45000);
  } finally {
    observer.stop();
  }
  let exportFile = download;
  if (!exportFile) {
    let url = exportUrl;
    for (const tab of observer.tabs()) {
      url = (await generatedExportUrl(tab)) || url;
      if (url) break;
    }
    try {
      exportFile = await fetchGeneratedExport(page, name, url);
    } catch (error) {
      const enhancedUrl = enhancedUiExportUrl(url);
      if (enhancedUrl) {
        try {
          console.log(name + ' | provo il percorso Awin per i feed Enhanced');
          exportFile = await fetchGeneratedExport(page, name, enhancedUrl);
        } catch (enhancedError) {
          if (!usesListedFeedFallback(name)) throw enhancedError;
        }
      } else if (!usesListedFeedFallback(name)) {
        throw error;
      }
      if (!exportFile) {
        setStage('Recupero tramite Scarica lista Feed');
        console.log(name + ' | cerco il link nella lista ufficiale Awin');
        const listedUrl = await findListedFeed(page, listUrl, name);
        exportFile = await fetchGeneratedExport(page, name, enhancedUiExportUrl(listedUrl) || listedUrl);
      }
    }
  }
  setStage('Verifica del nome del file');
  const original = path.basename(exportFile.suggestedFilename()).toLowerCase();
  const extension = feedExtensions.find(value => original.endsWith(value));
  if (!extension) throw new Error('Formato del download da verificare');
  setStage('Salvataggio del file');
  const temporary = path.join(__dirname, 'awin-' + randomUUID() + '.part');
  try {
    await exportFile.saveAs(temporary);
    const file = await fs.stat(temporary);
    if (!file.size) throw new Error('File scaricato vuoto');
    const filename = await storeAdvertiserFeed(temporary, name, extension);
    console.log(name + ' | scaricato | ' + file.size + ' byte | ' + filename);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
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

async function readAdvertiserPage(page) {
  try {
    const ready = await page.waitForFunction(inspectPersonalAdvertisers, true, { timeout: 30000, polling: 250 });
    return await ready.jsonValue();
  } catch {
    const result = await page.evaluate(inspectPersonalAdvertisers, false);
    if (result.names?.length) return result;
    console.error(result.issue);
    return { names: [], total: null };
  }
}

async function readJoinedAdvertisers(page) {
  const first = await readAdvertiserPage(page);
  const names = new Set(first.names);
  for (let pageNumber = 2; names.size && first.total > names.size; pageNumber++) {
    await open(page, '/merchant-directory/index/tab/active/page/' + pageNumber);
    const current = await readAdvertiserPage(page);
    const before = names.size;
    for (const name of current.names) names.add(name);
    if (names.size === before) {
      console.error('Impossibile leggere tutti gli advertiser: ' + names.size + ' di ' + first.total + '.');
      return [];
    }
  }
  return [...names];
}

function reportFailure(name, stage, error) {
  const safeErrors = [
    'Pagina Awin non disponibile',
    'Campo Ricerca advertiser da identificare',
    'Step 1 contiene ancora altri advertiser',
    'Dopo il clic non compare la finestra con Ricerca advertiser',
    'Nessun feed selezionabile per questo advertiser',
    'Awin non ha avviato il download e non mostra un URL di esportazione utilizzabile',
    'Awin non ha restituito un file di listino valido',
    'Richiesta del file Awin non completata',
    'Il nome non compare nel riepilogo Step 1 dopo Salva',
    'Formato del download da verificare',
    'File scaricato vuoto',
    'Nome advertiser non valido per il salvataggio',
    'Link Scarica lista Feed non trovato nella pagina Awin',
    'Impossibile leggere la lista feed Awin',
    'Colonne della lista feed Awin non riconosciute',
    'La lista Awin non identifica un solo link di download per questo advertiser'
  ];
  const message = safeErrors.includes(error.message) ? error.message : 'Passaggio non completato nella pagina Awin';
  console.log(name + ' | errore al passaggio «' + stage + '» | ' + message);
  process.exitCode = 1;
}

async function validateEnhancedFile(filename, advertiserId) {
  const lines = readline.createInterface({ input: createReadStream(filename), crlfDelay: Infinity });
  let products = 0;
  let advertiserName;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (!record || typeof record !== 'object' || record.error) {
        throw new Error('Awin ha segnalato un errore nel listino');
      }
      if (record.meta?.advertiser_id != null && String(record.meta.advertiser_id) !== advertiserId) {
        throw new Error('Il listino appartiene a un altro advertiser');
      }
      if (record.meta?.advertiser_name) advertiserName ??= record.meta.advertiser_name;
      if (record.product_basic?.id || record.product_details || record.id) products++;
    }
  } finally {
    lines.close();
  }
  if (!products) throw new Error('Nessun prodotto nel listino JSONL');
  if (!advertiserName) throw new Error('Nome advertiser assente dal listino Enhanced');
  return { products, advertiserName };
}

async function downloadEnhanced(targets) {
  const token = process.env.AWIN_API_TOKEN?.trim();
  delete process.env.AWIN_API_TOKEN;
  if (!token) throw new Error('Imposta AWIN_API_TOKEN per usare il download Enhanced');
  if (!targets.length || targets.length > 5 || targets.some(value => !/^\d+:[a-z]{2}_[A-Z]{2}$/.test(value))) {
    throw new Error('Usa da uno a cinque argomenti nel formato ID_ADVERTISER:lingua_PAESE');
  }
  let saved = 0;
  for (const target of new Set(targets)) {
    const [id, locale] = target.split(':');
    const filename = id + '-retail-' + locale + '.jsonl';
    const temporary = path.join(__dirname, 'awin-' + randomUUID() + '.part');
    try {
      const url = 'https://api.awin.com/publishers/' + publisherId + '/awinfeeds/download/' + filename;
      const response = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token },
        redirect: 'error',
        signal: AbortSignal.timeout(180000)
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        console.log(target + ' | API Awin: HTTP ' + response.status);
        process.exitCode = 1;
        continue;
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
      const { products, advertiserName } = await validateEnhancedFile(temporary, id);
      const savedFilename = await storeAdvertiserFeed(temporary, advertiserName, '.jsonl');
      console.log(target + ' | salvato | ' + products + ' prodotti | ' + savedFilename);
      saved++;
    } catch {
      console.log(target + ' | download interrotto o listino JSONL non valido');
      process.exitCode = 1;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  console.log('Listini Enhanced salvati: ' + saved + ' di ' + new Set(targets).size);
  if (saved) console.log('Cartella dei listini: ' + output);
}

async function readWindowsCredential() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return null;
  const credentialPath = path.join(process.env.LOCALAPPDATA, 'AwinPlaywright', 'login.xml');
  try {
    await fs.access(credentialPath);
  } catch {
    return null;
  }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$file = Join-Path $env:LOCALAPPDATA 'AwinPlaywright\\login.xml'",
    "$credential = Import-Clixml -LiteralPath $file",
    "if ($credential -isnot [System.Management.Automation.PSCredential]) { throw 'Credenziale non valida' }",
    "$json = @{ email = $credential.UserName; password = $credential.GetNetworkCredential().Password } | ConvertTo-Json -Compress",
    "[Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))"
  ].join('; ');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 16384
  });
  return JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8'));
}

function isAwinLoginUrl(value) {
  const url = new URL(value);
  if (url.origin === 'https://id.awin.com') {
    return /^\/u\/login(?:\/|$)/i.test(url.pathname);
  }
  return url.origin === 'https://ui.awin.com' &&
    /^\/(?:login(?:\/|$)|idp\/[^/]+\/awin\/login(?:\/|$))/i.test(url.pathname);
}

async function validateLoginAction(button, withPassword) {
  return button.evaluate((element, protectedPassword) => {
    const form = element.form ?? element.closest('form');
    const action = new URL(element.getAttribute('formaction') || form?.getAttribute('action') ||
      location.href, location.href);
    const allowedOrigins = ['https://ui.awin.com', 'https://id.awin.com'];
    if (!allowedOrigins.includes(location.origin) || action.origin !== location.origin) return false;
    if (!protectedPassword || !form || element.type === 'button') return true;
    const method = element.getAttribute('formmethod') || form.getAttribute('method');
    return method?.toLowerCase() === 'post';
  }, withPassword);
}

async function submitSavedLogin(page) {
  if (!isAwinLoginUrl(page.url())) return 'Pagina di accesso Awin non riconosciuta.';
  const credential = await readWindowsCredential();
  if (!credential?.email || !credential?.password) return 'Credenziale Windows non configurata.';

  const password = page.locator('input[type="password"]').filter({ visible: true });
  const email = page.locator('input[type="email"], input[autocomplete="username"], input[name="email"], input[name="username"], input[name="identifier"]').filter({ visible: true });
  const continueButton = page.getByRole('button', { name: /^(continua|continue|avanti|next)$/i }).filter({ visible: true });
  const loginButtons = page.getByRole('button', { name: /^(accedi|login|log in|sign in|entra)$/i }).filter({ visible: true });
  await password.or(email).first().waitFor({ timeout: 8000 });

  if (await password.count() === 0) {
    await continueButton.first().waitFor({ timeout: 5000 });
    if (await email.count() !== 1 || await continueButton.count() !== 1 ||
        !isAwinLoginUrl(page.url()) || !await validateLoginAction(continueButton, false)) {
      return 'Schermata email o pulsante Continua non riconosciuto.';
    }
    await email.fill(credential.email);
    await continueButton.click();
    console.log('Awin | email inserita, premuto Continua.');
    try {
      await password.first().waitFor({ timeout: 10000 });
    } catch {
      return 'Awin non ha mostrato il campo password dopo Continua.';
    }
  } else if (await email.count() === 1 && isAwinLoginUrl(page.url())) {
    await email.fill(credential.email);
  }

  await loginButtons.or(continueButton).first().waitFor({ timeout: 5000 });
  const loginButton = await loginButtons.count() ? loginButtons : continueButton;
  if (await password.count() !== 1 || await loginButton.count() !== 1 ||
      !isAwinLoginUrl(page.url()) || !await validateLoginAction(loginButton, true)) {
    return 'Schermata password o pulsante Accedi non riconosciuto.';
  }
  await password.fill(credential.password);
  if (!isAwinLoginUrl(page.url()) || !await validateLoginAction(loginButton, true)) {
    return 'Destinazione del login Awin non riconosciuta.';
  }
  await loginButton.click();
  return null;
}

async function main() {
  if (!/^\d+$/.test(publisherId)) {
    console.error('Uso: node scarica-listini-awin.cjs <publisher-id>');
    process.exitCode = 1;
    return;
  }
  console.log('Scarica listini Awin v32');
  if (process.argv[3] === '--enhanced') {
    try {
      await downloadEnhanced(process.argv.slice(4));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
    return;
  }
  const browser = await chromium.launchPersistentContext(profile, { headless: false, acceptDownloads: true });
  try {
    const page = browser.pages()[0] ?? await browser.newPage();
    page.setDefaultTimeout(12000);
    await open(page, '/merchant-directory/index/tab/active/page/1');
    if (!isAwinLoginUrl(page.url())) {
      const personalHeading = page.getByText(/^Advertiser personali(?:\s*\(\s*\d+\s*\))?$/i)
        .filter({ visible: true }).first();
      await Promise.any([
        personalHeading.waitFor({ timeout: 8000 }),
        page.waitForURL(url => isAwinLoginUrl(url.href), { timeout: 8000 })
      ]).catch(() => {});
    }
    if (isAwinLoginUrl(page.url())) {
      console.log('Awin | pagina di autenticazione riconosciuta su ' + new URL(page.url()).hostname + '.');
      const loginIssue = await submitSavedLogin(page).catch(() => 'Accesso automatico non completato.');
      if (loginIssue) {
        console.error('Awin | ' + loginIssue);
        process.exitCode = 1;
        return;
      }
      console.log('Awin | password inserita, premuto Accedi. Attendo la tabella Advertiser personali.');
    }
    const active = await readJoinedAdvertisers(page);
    if (!active.length) {
      console.error('Nessun download eseguito.');
      process.exitCode = 1;
      return;
    }
    console.log('Advertiser personali rilevati: ' + active.join(', '));
    const requested = process.argv.slice(3).map(name => name.trim().toLowerCase());
    const targets = requested.length ? active.filter(name => requested.includes(name.toLowerCase())) : active;
    if (requested.some(name => !targets.some(target => target.toLowerCase() === name))) {
      console.error('Almeno un advertiser richiesto non compare in Advertiser personali.');
      process.exitCode = 1;
      return;
    }
    let completed = 0;
    for (const name of targets) {
      let stage = 'Apertura di Create-a-Feed';
      const setStage = value => { stage = value; };
      try {
        await open(page, '/datafeed/step-one');
        const listUrl = usesListedFeedFallback(name) ? await getFeedListUrl(page) : undefined;
        const others = active.filter(advertiser => advertiser !== name);
        const otherCards = () => Promise.all(others.map(advertiser =>
          page.getByText(advertiser, { exact: false }).filter({ visible: true }).first().isVisible()
        ));
        const clearPrevious = (await otherCards()).some(Boolean);
        const count = await addAdvertiser(page, name, setStage, clearPrevious);
        setStage('Verifica della selezione singola');
        if ((await otherCards()).some(Boolean)) {
          throw new Error('Step 1 contiene ancora altri advertiser');
        }
        console.log(name + ' | selezionato | ' + count + ' feed');
        await downloadBatch(page, name, setStage, listUrl);
        completed++;
      } catch (error) {
        reportFailure(name, stage, error);
      }
    }
    console.log('Listini salvati: ' + completed + ' di ' + targets.length);
    if (completed) console.log('Cartella dei listini: ' + output);
  } finally {
    await browser.close();
  }
}
main().catch(() => {
  console.error('Impossibile aprire la scheda Iscritto. Controlla che il profilo Playwright sia libero e che Awin sia raggiungibile.');
  process.exitCode = 1;
});
