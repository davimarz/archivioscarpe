'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const products = JSON.parse(fs.readFileSync(path.join(root, 'catalogo-awin.json'), 'utf8'));
const report = JSON.parse(fs.readFileSync(path.join(root, 'catalogo-awin-report.json'), 'utf8'));
const issues = [];
const parsePrice = value => {
  const raw = String(value ?? '').trim().replace(/[^\d,.]/g, '');
  return Number(raw.replace(/\./g, '').replace(',', '.'));
};
if (!Array.isArray(products) || !products.length) issues.push('Catalogo assente o vuoto');
else {
  let invalid = 0, missingImage = 0, suspicious = 0;
  for (const product of products) {
    const price = parsePrice(product.price);
    if (!product.name || !product.merchant || !/^https:\/\//.test(product.url || '') ||
        !Number.isFinite(price) || price <= 0) invalid++;
    if (!/^https:\/\//.test(product.image || '')) missingImage++;
    const old = parsePrice(product.originalPrice);
    if (Number.isFinite(old) && old > 0 && (old <= price || old / price > 20)) suspicious++;
  }
  if (invalid) issues.push(invalid + ' prodotti con nome, negozio, link o prezzo non validi');
  if (missingImage) issues.push(missingImage + ' prodotti senza URL immagine valido');
  if (suspicious) issues.push(suspicious + ' prezzi precedenti incoerenti o da verificare');
  if (report.publishedOffers !== products.length) issues.push('Conteggio catalogo diverso dal report');
}
const updated = Date.parse(report.updatedAt);
if (!Number.isFinite(updated) || Date.now() - updated > 72 * 60 * 60 * 1000) {
  issues.push('Catalogo non aggiornato da oltre 72 ore');
}
console.log('Catalogo: ' + (Array.isArray(products) ? products.length : 0) + ' prodotti; ultimo aggiornamento: ' + report.updatedAt);
for (const issue of issues) console.error('ATTENZIONE: ' + issue);
if (issues.length) process.exitCode = 1;
