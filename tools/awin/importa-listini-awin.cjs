const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { execFileSync } = require('node:child_process');

const [repo, directory, publisher, ...options] = process.argv.slice(2);
const catalogFile = 'catalogo-awin.json';
const trackedFiles = ['index.html', 'sw.js', catalogFile];
const sourceExtension = /\.(?:csv|tsv|jsonl|ndjson)(?:\.gz)?$|\.gz$/i;
const shoeTerms = /\b(?:scarpe|scarpa|calzature|sneakers?|shoes?|footwear|baskets?|chaussures?|stivaletti|stivali|sandali|mocassini|boots?|sandals?|ciabatte)\b/i;

function* csvRows(text, separator) {
  let row = [];
  let start = 0;
  let record = 1;
  const isBoundary = c => c === separator || c === '\r' || c === '\n' || c === undefined;
  const skipPadding = position => {
    while (text[position] === ' ' || (separator !== '\t' && text[position] === '\t')) position++;
    return position;
  };
  while (start < text.length) {
    let end = start;
    const quoteStart = skipPadding(start);
    if (text[quoteStart] === '"') {
      let quoteEnd = text.indexOf('"', quoteStart + 1);
      while (quoteEnd !== -1) {
        if (text[quoteEnd + 1] === '"') {
          quoteEnd = text.indexOf('"', quoteEnd + 2);
          continue;
        }
        if (isBoundary(text[skipPadding(quoteEnd + 1)])) break;
        // An unescaped quote followed by text is part of the field.
        quoteEnd = text.indexOf('"', quoteEnd + 1);
      }
      if (quoteEnd === -1) throw new Error('record CSV ' + record + ': virgolette non chiuse');
      row.push(text.slice(quoteStart + 1, quoteEnd).replaceAll('""', '"'));
      end = skipPadding(quoteEnd + 1);
    } else {
      while (!isBoundary(text[end])) end++;
      row.push(text.slice(start, end));
    }
    if (text[end] === separator) {
      start = end + 1;
      if (start === text.length) row.push('');
      continue;
    }
    if (!isBoundary(text[end])) {
      throw new Error('record CSV ' + record + ': carattere inatteso dopo le virgolette');
    }
    if (row.some(Boolean)) yield row;
    record++;
    row = [];
    start = end + (text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1);
  }
  if (row.some(Boolean)) yield row;
}

function detectCsvSeparator(header) {
  for (const separator of [',', ';', '|', '\t']) {
    try {
      const fields = csvRows(header, separator).next().value ?? [];
      const normalized = fields.map(field => field.trim().toLowerCase());
      if (normalized.some(field => field === 'product_name' || field === 'title') &&
          normalized.some(field => ['search_price', 'store_price', 'price', 'display_price', 'sale_price'].includes(field))) {
        return separator;
      }
    } catch {
      // Other delimiters can make a quoted header appear invalid.
    }
  }
  throw new Error('intestazione CSV prodotti non riconosciuta');
}

function* records(filename, reportInvalid) {
  let bytes = fs.readFileSync(filename);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8';
  const text = bytes.toString(encoding).trimStart().replace(/^sep=[,;|\t]\r?\n/i, '');
  if (text.startsWith('{')) {
    for (let start = 0; start < text.length;) {
      const nextLine = text.indexOf('\n', start);
      const end = nextLine < 0 ? text.length : nextLine;
      const line = text.slice(start, end).trim();
      start = end + 1;
      if (!line) continue;
      const record = JSON.parse(line);
      if (!record || record.error) throw new Error('il feed JSONL segnala un errore');
      yield Object.assign({}, ...Object.values(record).filter(value => value && typeof value === 'object' && !Array.isArray(value)), record);
    }
    return;
  }
  const firstLine = text.split(/\r?\n/, 1)[0];
  const separator = detectCsvSeparator(firstLine);
  const rows = csvRows(text, separator);
  const headers = (rows.next().value ?? []).map(field => field.trim().toLowerCase());
  if (headers.length < 2 || !headers.some(field => /^(product_name|title)$/.test(field))) {
    throw new Error('intestazione CSV prodotti non riconosciuta');
  }
  let record = 1;
  for (const row of rows) {
    record++;
    if (row.length !== headers.length) {
      reportInvalid(record, row.length, headers.length);
      continue;
    }
    yield Object.fromEntries(headers.map((field, index) => [field, row[index]]));
  }
}

const clean = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const pick = (...values) => values.map(clean).find(Boolean) || '';
const normalize = value => clean(value).toLowerCase().replace(/\s+/g, ' ');

function cents(value, currency) {
  const raw = typeof value === 'object' && value ? pick(value.amount, value.value) : clean(value);
  const unit = typeof value === 'object' && value ? pick(value.currency, value.currency_code, value.currencyCode, currency) : clean(currency);
  if (unit && !/^(EUR|€)$/i.test(unit)) return null;
  const match = raw.match(/^(?:EUR\s*|€\s*)?(\d+(?:[.,]\d{1,2})?)\s*(?:EUR|€)?$/i);
  if (!match || (!unit && !/EUR|€/i.test(raw))) return null;
  const result = Math.round(Number(match[1].replace(',', '.')) * 100);
  return Number.isSafeInteger(result) ? result : null;
}

function https(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function trackingLink(record, merchant) {
  for (const value of [record.aw_deep_link, record.awin_deep_link, record.awin_link, record.affiliate_link, record.link]) {
    const url = https(value);
    if (url && /^(?:www\.)?awin1\.com$/i.test(url.hostname) &&
        (url.searchParams.get('a') === publisher || url.searchParams.get('awinaffid') === publisher)) {
      return url.href;
    }
  }
  // The live site already uses this deep-link format for OneStreet.
  const knownAdvertisers = { OneStreet: '128805', 'Voghion Global': '44635' };
  const merchantId = pick(record.merchant_id, record.advertiser_id, knownAdvertisers[merchant]);
  const destination = https(pick(record.merchant_deep_link, record.link));
  if (!/^\d+$/.test(merchantId) || !destination ||
      /^(?:www\.)?awin1\.com$/i.test(destination.hostname)) return '';
  const link = new URL('https://www.awin1.com/cread.php');
  link.search = new URLSearchParams({ awinmid: merchantId, awinaffid: publisher, ued: destination.href });
  return link.href;
}

function offer(record, merchant) {
  const name = pick(record.product_name, record.title);
  const category = [record.merchant_category, record.merchant_product_category_path, record.category_name, record.product_type, record.google_product_category].map(clean).join(' ');
  const merchantSection = clean(record.merchant_category).split('>').map(part => part.trim());
  if (merchant === 'Cisalfa Sport IT' && merchantSection.length > 1) {
    if (!/^scarpe$/i.test(merchantSection[1])) return null;
  } else if (!shoeTerms.test(category) && !shoeTerms.test(name)) {
    return null;
  }
  if (/\b(?:lacci|solette|soletta|calzini|shoe cleaner|shoe care|shoelaces|insoles)\b/i.test(name)) return null;
  const availability = normalize(pick(record.availability, record.in_stock, record.stock_status));
  if (/^(?:0|no|false|out[ _-]?of[ _-]?stock|unavailable|esaurito|non disponibile|pre[ _-]?order)$/.test(availability)) return null;
  const currency = pick(record.currency, record.currency_code);
  const current = [record.sale_price, record.search_price, record.store_price, record.price, record.display_price]
    .map(value => cents(value, currency)).find(value => value > 0);
  const image = https(pick(record.merchant_image_url, record.aw_image_url, record.image_link));
  const url = trackingLink(record, merchant);
  if (!name || !current || !image || !url) return null;
  const gtin = pick(record.product_gtin, record.ean, record.upc, record.gtin);
  const variant = [record.brand_name || record.brand, record.mpn || record.model_number,
    record.colour || record.color, record['fashion:size'] || record.size].map(normalize);
  const key = /^(?:\d{8}|\d{12,14})$/.test(gtin) && !/^0+$/.test(gtin) ? 'gtin:' + gtin.padStart(14, '0')
    : variant.every(Boolean) ? 'variant:' + JSON.stringify(variant) : 'offer:' + url;
  const shipping = cents(record.delivery_cost, currency);
  return { key, current, shipping, name, price: (current / 100).toFixed(2).replace('.', ','),
    image: image.href, url, merchant };
}

function cheapestOffers(offers) {
  const groups = new Map();
  for (const item of offers) {
    if (!groups.has(item.key)) groups.set(item.key, []);
    groups.get(item.key).push(item);
  }
  return [...groups.values()].map(group => {
    const withShipping = group.every(item => item.shipping !== null);
    const total = item => item.current + (withShipping ? item.shipping : 0);
    return group.reduce((best, item) => total(item) < total(best) ? item : best);
  }).sort((a, b) => a.current - b.current || a.name.localeCompare(b.name, 'it'))
    .map(({ key, current, shipping, ...card }) => card);
}

function editSite(index, worker) {
  if (!index.includes('data-awin-import')) {
    const start = index.indexOf('    // Catalogo statico selezionato dal feed Awin Cisalfa:');
    const end = index.indexOf('  </script>', start);
    if (start < 0 || end < 0) throw new Error('sezione offerte di index.html non riconosciuta');
    let block = index.slice(start, end);
    if (!block.includes('const products = [...cheapestByProduct.values()];')) throw new Error('renderer offerte non riconosciuto');
    block = block.replace('    (() => {', '    (async () => { // data-awin-import')
      .replace('      const products = [...cheapestByProduct.values()];', [
        '      let products = [...cheapestByProduct.values()];',
        '      try {',
        "        const response = await fetch('./catalogo-awin.json', { cache: 'no-store' });",
        "        if (!response.ok) throw new Error('Catalogo non disponibile');",
        '        const imported = await response.json();',
        '        if (Array.isArray(imported) && imported.length) products = imported;',
        "      } catch (error) { console.warn('Catalogo Awin di riserva.', error); }"
      ].join('\n'))
      .replace('      let page = 0;', '      const pageCount = Math.ceil(products.length / 2);\n      let page = 0;')
      .replaceAll('products.length / 2', 'pageCount').replace('Math.ceil(pageCount)', 'Math.ceil(products.length / 2)')
      .replace('slot.replaceChildren(createCard(products[start]), createCard(products[(start + 1) % products.length]));',
        'slot.replaceChildren(...products.slice(start, start + 2).map(createCard));');
    index = (index.slice(0, start) + block + index.slice(end))
      .replace('Scarpe da Cisalfa e OneStreet', 'Offerte scarpe dai negozi partner')
      .replace('Prezzi dai cataloghi Awin del 10/11/2026; disponibilità e prezzi effettivi sui siti dei venditori.', 'Prezzi dai listini Awin. Verifica disponibilità e spese di spedizione sul sito del venditore.')
      .replace('./sw.js?v=3', './sw.js?v=4');
  }
  if (!worker.includes("request.cache === 'no-store'")) {
    const original = 'if (!cacheable(request, url)) return;';
    if (!worker.includes(original)) throw new Error('gestione cache in sw.js non riconosciuta');
    worker = worker.replace(original, "if (request.cache === 'no-store' || !cacheable(request, url)) return;");
  }
  return { index, worker };
}

function main() {
  if (!repo || !directory || !/^\d+$/.test(publisher || '') || options.some(option => option !== '--pubblica')) {
    throw new Error('Uso: node importa-listini-awin.cjs <repo> <LISTINI> <publisher-id> [--pubblica]');
  }
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  const publish = options.includes('--pubblica');
  if (publish) {
    const origin = git('remote', 'get-url', 'origin');
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:)davimarz\/archivioscarpe(?:\.git)?$/i.test(origin) || git('branch', '--show-current') !== 'main') {
      throw new Error('Per pubblicare usa il branch main del repository davimarz/archivioscarpe');
    }
    if (git('diff', '--cached', '--name-only')) throw new Error('Git contiene modifiche già preparate');
    git('fetch', 'origin', 'main');
    if (git('rev-parse', 'HEAD') !== git('rev-parse', 'FETCH_HEAD')) {
      throw new Error('main locale e origin/main differiscono. Allineali prima di pubblicare');
    }
  }
  const files = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile());
  const feeds = files.filter(entry => sourceExtension.test(entry.name));
  if (!feeds.length) throw new Error('Nessun listino CSV, CSV gzip o JSONL trovato in LISTINI');
  if (files.some(entry => /\.zip$/i.test(entry.name))) throw new Error('Estrai i listini ZIP in LISTINI prima di avviare l’importazione');
  const allOffers = [];
  for (const { name } of feeds) {
    const merchant = name.replace(sourceExtension, '');
    let rowCount = 0, offerCount = 0, skipped = 0;
    const reportInvalid = (record, columns, expected) => {
      skipped++;
      if (skipped <= 5) console.warn(name + ' | record CSV ' + record +
        ' saltato: ' + columns + ' colonne, attese ' + expected);
    };
    try {
      for (const record of records(path.join(directory, name), reportInvalid)) {
        rowCount++;
        const item = offer(record, merchant);
        if (!item) continue;
        allOffers.push(item);
        offerCount++;
      }
    } catch (error) {
      throw new Error(name + ': ' + error.message);
    }
    if (!offerCount) throw new Error(merchant + ': nessuna calzatura in EUR con prezzo, immagine e link affiliato utilizzabile');
    console.log(merchant + ' | ' + offerCount + ' offerte utilizzabili su ' + (rowCount + skipped) + ' righe' +
      (skipped ? ' | ' + skipped + ' record CSV saltati' : ''));
  }
  const products = cheapestOffers(allOffers);
  const content = JSON.stringify(products) + '\n';
  if (Buffer.byteLength(content) > 95 * 1024 * 1024) throw new Error('Catalogo troppo grande per un singolo file GitHub');
  const indexPath = path.join(repo, 'index.html'), workerPath = path.join(repo, 'sw.js');
  const next = editSite(fs.readFileSync(indexPath, 'utf8'), fs.readFileSync(workerPath, 'utf8'));
  fs.writeFileSync(path.join(repo, catalogFile), content);
  fs.writeFileSync(indexPath, next.index);
  fs.writeFileSync(workerPath, next.worker);
  console.log('Catalogo generato: ' + products.length + ' offerte da ' + feeds.length + ' listini');
  if (!publish) return;
  git('add', '--', ...trackedFiles);
  if (git('diff', '--cached', '--name-only', '--', ...trackedFiles)) {
    git('commit', '-m', 'Aggiorna catalogo offerte Awin', '--', ...trackedFiles);
  }
  git('push', 'origin', 'main');
  console.log('Catalogo inviato a GitHub. Pubblicazione Pages in elaborazione.');
}

try { main(); } catch (error) { console.error('Importazione interrotta: ' + error.message); process.exitCode = 1; }
