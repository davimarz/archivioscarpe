const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { catalogIndex } = require('./indicizza-catalogo-awin.cjs');

const [repo, directory, publisher, ...options] = process.argv.slice(2);
const catalogFile = 'catalogo-awin.json';
const indexFile = 'catalogo-awin-indice.json';
const reportFile = 'catalogo-awin-report.json';
const trackedFiles = [catalogFile, indexFile, reportFile];
const sourceExtension = /\.(?:csv|tsv|jsonl|ndjson)(?:\.gz)?$|\.gz$/i;
const isFootwear = require('../../assets/footwear.js');

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

const catalogColor = /^(?:(?:bianc[oa]|ner[oa]|ross[oa]|verd[ei]|blu|azzurr[oa]|grigi[oa]|giall[oa]|arancione|rosa|viol[ao]|marrone|beige|bordeaux|celeste|argento|oro|navy|cream|black|white|red|green|blue|grey|gray|yellow|orange|pink|purple|brown)(?:\s+(?:chiaro|scuro|light|dark))?)(?:\s*[/+]\s*(?:bianc[oa]|ner[oa]|ross[oa]|verd[ei]|blu|azzurr[oa]|grigi[oa]|giall[oa]|arancione|rosa|viol[ao]|marrone|beige|black|white|red|green|blue|grey|gray))*$|^(?:color mix|multicolor(?:e)?|multicolour)$/i;

function catalogVariant(record, name) {
  const brand = pick(record.brand_name, record.brand);
  const size = pick(record['fashion:size'], record.size);
  const explicitColor = pick(record.colour, record.color);
  const parts = name.split(/\s+[-–—|]\s+/);
  const details = new Set([normalize(explicitColor), normalize(size), normalize('taglia ' + size), normalize('eu ' + size)]);
  const colors = parts.slice(1).filter(part => catalogColor.test(normalize(part)));
  const family = parts.filter((part, index) =>
    index === 0 || (!catalogColor.test(normalize(part)) && !details.has(normalize(part)))
  ).join(' - ');
  const color = explicitColor || colors.join(' / ');
  const modelWords = normalize(parts[0]).replace(normalize(brand), '').match(/[\p{L}\p{N}]+/gu) ?? [];
  const model = pick(record.model_number, record.product_model, record.mpn);
  const group = pick(record.item_group_id, model);
  const familyKey = brand && (group || modelWords.length >= 2) ? JSON.stringify([normalize(brand), normalize(group || family)]) : null;
  return { brand, model, color, size, family: familyKey };
}

function cardRank(card) {
  return createHash('sha256').update([card.url, card.name, card.color, card.size].join('\0'))
    .digest('hex').slice(0, 16);
}

function limitCatalogVariants(products) {
  const groups = new Map();
  for (const item of products) {
    const key = item.family ? JSON.stringify([item.merchant, item.current, item.family]) : item;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const visible = [];
  for (const group of groups.values()) {
    const colors = new Set(group.map(item => normalize(item.color)).filter(Boolean));
    const sizes = new Set(group.map(item => normalize(item.size)).filter(Boolean));
    const ranked = group.length === 1 ? group : group.map(item => ({ item, rank: cardRank(item) }))
      .sort((a, b) => a.rank.localeCompare(b.rank)).map(entry => entry.item);
    const colorFrequency = new Map(), sizeFrequency = new Map(), pairFrequency = new Map();
    let knownPairs = 0;
    const increment = (map, key) => map.set(key, (map.get(key) || 0) + 1);
    for (const item of ranked) {
      if (!item.color || !item.size) continue;
      const color = normalize(item.color), size = normalize(item.size);
      increment(colorFrequency, color);
      increment(sizeFrequency, size);
      increment(pairFrequency, JSON.stringify([color, size]));
      knownPairs++;
    }
    const first = ranked.find(item => {
      if (!item.color || !item.size) return false;
      const color = normalize(item.color), size = normalize(item.size);
      return knownPairs - colorFrequency.get(color) - sizeFrequency.get(size) +
        pairFrequency.get(JSON.stringify([color, size])) > 0;
    }) || ranked[0];
    const diversity = item => Number(Boolean(item.color && first.color && normalize(item.color) !== normalize(first.color))) +
      Number(Boolean(item.size && first.size && normalize(item.size) !== normalize(first.size)));
    const second = ranked.filter(item => item !== first).reduce((best, item) =>
      !best || diversity(item) > diversity(best) ? item : best, null);
    for (const item of second ? [first, second] : [first]) {
      const { family, key, current, shipping, auditSignature, ...card } = item;
      for (const field of ['brand', 'model', 'color', 'size']) if (!card[field]) delete card[field];
      if (colors.size > 1) card.colorCount = colors.size;
      if (sizes.size > 1) card.sizeCount = sizes.size;
      visible.push(card);
    }
  }
  return visible;
}

function offer(record, merchant) {
  const name = pick(record.product_name, record.title);
  const category = [record.merchant_category, record.merchant_product_category_path, record.category_name, record.product_type, record.google_product_category].map(clean).join(' ');
  if (!isFootwear(name, category) && !isFootwear(name, record.google_product_category)) return null;
  const availability = normalize(pick(record.availability, record.in_stock, record.stock_status));
  if (/^(?:0|no|false|out[ _-]?of[ _-]?stock|unavailable|esaurito|non disponibile|pre[ _-]?order)$/.test(availability)) return null;
  const currency = pick(record.currency, record.currency_code) ||
    (/^(?:EUR\s*|€\s*)\d|\d\s*(?:EUR|€)$/i.test(clean(record.product_price_old)) ? 'EUR' : '');
  const current = [record.sale_price, record.search_price, record.store_price, record.price, record.display_price]
    .map(value => cents(value, currency)).find(value => value > 0);
  const image = https(pick(record.merchant_image_url, record.aw_image_url, record.image_link));
  const url = trackingLink(record, merchant);
  if (!name || !current || !image || !url) return null;
  const rawGtin = pick(record.product_gtin, record.productgtin, record.ean, record.upc, record.gtin);
  const gtin = /^(?:\d{8}|\d{12,14})$/.test(rawGtin) && !/^0+$/.test(rawGtin) ? rawGtin.padStart(14, '0') : '';
  const originalPrice = [record.product_price_old, record.original_price, record.originalprice, record.previous_price,
    record.price_before_discount,
    ...(cents(record.sale_price, currency) === current ? [record.price] : [])
  ].map(value => cents(value, currency)).find(value => value > current);
  const referencePrice = [record.rrp_price, record.rrp, record.recommended_retail_price]
    .map(value => cents(value, currency)).find(value => value > current);
  const euro = value => (value / 100).toFixed(2).replace('.', ',');
  const variant = [record.brand_name || record.brand, record.mpn || record.model_number,
    record.colour || record.color, record['fashion:size'] || record.size].map(normalize);
  const key = gtin ? 'gtin:' + JSON.stringify([gtin, ...variant.slice(2)])
    : variant.every(Boolean) ? 'variant:' + JSON.stringify(variant) : 'offer:' + url;
  const shipping = cents(record.delivery_cost, currency);
  return { key, current, shipping, name, footwear: true, price: euro(current),
    image: image.href, url, merchant, ...catalogVariant(record, name),
    ...(gtin && { gtin }), ...(originalPrice && { originalPrice: euro(originalPrice) }),
    ...(referencePrice && referencePrice !== originalPrice && { referencePrice: euro(referencePrice) }) };
}

function cheapestOffers(offers) {
  const bestByProduct = new Map();
  for (const item of offers) {
    const merchantKey = JSON.stringify([normalize(item.merchant), item.key]);
    const best = bestByProduct.get(merchantKey);
    const total = item.current + (item.shipping ?? Infinity);
    const bestTotal = best ? best.current + (best.shipping ?? Infinity) : Infinity;
    if (!best || total < bestTotal || (total === bestTotal && item.current < best.current)) {
      bestByProduct.set(merchantKey, item);
    }
  }
  return [...bestByProduct.values()];
}

function printGroupingAudit(offers, products) {
  const merchants = new Map();
  const retained = new Map();
  for (const product of products) retained.set(product.merchant, (retained.get(product.merchant) || 0) + 1);
  for (const offer of offers) {
    if (!merchants.has(offer.merchant)) merchants.set(offer.merchant, new Map());
    const keys = merchants.get(offer.merchant);
    if (!keys.has(offer.key)) keys.set(offer.key, { count: 0, signatures: new Set() });
    const group = keys.get(offer.key);
    group.count++;
    group.signatures.add(offer.auditSignature);
  }
  for (const [merchant, keys] of merchants) {
    console.log(merchant + ' | chiavi proprie: ' + keys.size + ' | rimaste nel catalogo: ' + (retained.get(merchant) || 0));
    const types = new Map();
    for (const [key, group] of keys) {
      const type = key.slice(0, key.indexOf(':'));
      if (!types.has(type)) types.set(type, { rows: 0, keys: 0, mixed: 0, max: 0 });
      const stats = types.get(type);
      stats.rows += group.count;
      stats.keys++;
      if (group.signatures.size > 1) stats.mixed++;
      stats.max = Math.max(stats.max, group.signatures.size);
    }
    for (const [type, stats] of types) {
      console.log('  ' + type + ' | righe: ' + stats.rows + ' | chiavi: ' + stats.keys +
        ' | chiavi con nome, colore o taglia diversi: ' + stats.mixed +
        ' | massimo combinazioni per chiave: ' + stats.max);
    }
  }
}

function main() {
  if (!repo || !directory || !/^\d+$/.test(publisher || '') || options.some(option => !['--pubblica', '--analizza'].includes(option)) || options.length > 1) {
    throw new Error('Uso: node importa-listini-awin.cjs <repo> <LISTINI> <publisher-id> [--pubblica|--analizza]');
  }
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  const publish = options.includes('--pubblica');
  const audit = options.includes('--analizza');
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
  const feedStats = [];
  for (const { name } of feeds) {
    const merchant = name.replace(sourceExtension, '');
    let rowCount = 0, offerCount = 0, skipped = 0, missingPrice = 0, unexpectedCurrency = 0;
    const reportInvalid = (record, columns, expected) => {
      skipped++;
      if (skipped <= 5) console.warn(name + ' | record CSV ' + record +
        ' saltato: ' + columns + ' colonne, attese ' + expected);
    };
    try {
      for (const record of records(path.join(directory, name), reportInvalid)) {
        rowCount++;
        const prices = [record.sale_price, record.search_price, record.store_price, record.price, record.display_price];
        const unit = pick(record.currency, record.currency_code);
        if (prices.every(value => value == null || clean(value) === '')) missingPrice++;
        if (unit && !/^(EUR|€)$/i.test(unit)) unexpectedCurrency++;
        const item = offer(record, merchant);
        if (!item) continue;
        if (audit) item.auditSignature = JSON.stringify([
          item.name, pick(record.colour, record.color), pick(record['fashion:size'], record.size)
        ].map(normalize));
        allOffers.push(item);
        offerCount++;
      }
    } catch (error) {
      throw new Error(name + ': ' + error.message);
    }
    if (!offerCount) throw new Error(merchant + ': nessuna calzatura in EUR con prezzo, immagine e link affiliato utilizzabile');
    console.log(merchant + ' | ' + offerCount + ' offerte utilizzabili su ' + (rowCount + skipped) + ' righe' +
      (skipped ? ' | ' + skipped + ' record CSV saltati' : ''));
    console.log(merchant + ' | prezzi mancanti: ' + missingPrice + ' | valuta inattesa: ' + unexpectedCurrency);
    feedStats.push({ merchant, rows: rowCount + skipped, usable: offerCount, skipped, missingPrice, unexpectedCurrency });
  }
  const discountedOffers = allOffers.filter(item => {
    const original = cents(item.originalPrice, 'EUR');
    if (!(original > item.current)) return false;
    const discount = Math.round((original - item.current) / original * 100);
    return discount >= 1 && discount <= 99;
  });
  const cheapest = cheapestOffers(discountedOffers);
  const band = card => {
    const price = Number(card.price.replace(',', '.'));
    return price < 50 ? 0 : price <= 150 ? 1 : 2;
  };
  const products = limitCatalogVariants(cheapest)
    .map(card => ({ card, band: band(card), rank: cardRank(card) }))
    .sort((a, b) => a.band - b.band || a.rank.localeCompare(b.rank))
    .map(entry => entry.card);
  console.log('Catalogo: ' + cheapest.length + ' offerte dopo il confronto, ' + products.length + ' dopo il limite di due varianti.');
  if (audit) {
    printGroupingAudit(allOffers, products);
    return;
  }
  const previousReportPath = path.join(repo, reportFile);
  if (!products.length) throw new Error('Il catalogo generato non contiene offerte.');
  if (fs.existsSync(previousReportPath)) {
    const previous = JSON.parse(fs.readFileSync(previousReportPath, 'utf8'));
    if (previous.discountPricePolicy === 'previous-and-current' && Number.isInteger(previous.publishedOffers) &&
        products.length < previous.publishedOffers * 0.7) {
      throw new Error('Offerte in calo di oltre il 30% (' + previous.publishedOffers + ' → ' +
        products.length + '). Controlla i listini prima di sostituire il catalogo.');
    }
  }
  const previousCatalogPath = path.join(repo, catalogFile);
  if (fs.existsSync(previousCatalogPath)) {
    const oldProducts = JSON.parse(fs.readFileSync(previousCatalogPath, 'utf8'));
    const retained = new Set(allOffers.map(item => normalize(item.merchant)));
    const allowed = new Set(String(process.env.AWIN_RIMUOVI_ADVERTISER || '').split(';').map(normalize).filter(Boolean));
    const missing = new Map(oldProducts.filter(item => item.merchant &&
      !retained.has(normalize(item.merchant)) && !allowed.has(normalize(item.merchant)))
      .map(item => [normalize(item.merchant), item.merchant]));
    if (missing.size) throw new Error('Mancano offerte valide per ' +
      [...missing.values()].join(', ') + '. Verifica che i relativi listini siano inclusi.');
  }
  const content = JSON.stringify(products) + '\n';
  if (Buffer.byteLength(content) > 95 * 1024 * 1024) throw new Error('Catalogo troppo grande per un singolo file GitHub');
  const index = JSON.stringify(catalogIndex(products, content)) + '\n';
  const report = JSON.stringify({
    updatedAt: new Date().toISOString(),
    discountedOnly: true,
    discountPricePolicy: 'previous-and-current',
    feeds: feedStats,
    sourceRows: feedStats.reduce((sum, feed) => sum + feed.rows, 0),
    usableOffers: allOffers.length,
    comparedOffers: cheapest.length,
    publishedOffers: products.length,
  }) + '\n';
  for (const [name, data] of [[catalogFile, content], [indexFile, index], [reportFile, report]]) {
    const output = path.join(repo, name);
    const temp = output + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(temp, data, { flag: 'wx' });
      fs.renameSync(temp, output);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
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
