const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const catalog = require('../assets/catalogo.js');

test('promotion variants of the same model share a duplicate key', () => {
  const beige = catalog.promotionProductKeys({
    name: 'Nike Air Vapormax Flyknit W - Scarpe Sneakers - Donna - Beige',
    brand: 'Nike', model: 'Air Vapormax Flyknit W', color: 'Beige', size: '37',
  });
  const white = catalog.promotionProductKeys({
    name: 'Nike Air Vapormax Flyknit W - Scarpe Sneakers - Donna - Bianco',
    brand: 'Nike', model: 'Air Vapormax Flyknit W', color: 'Bianco', size: '38.5',
  });
  assert.ok(beige.some(key => white.includes(key)));
});

test('admin keeps current Awin data when the comparison period fails', () => {
  const html = fs.readFileSync('admin/index.html', 'utf8');
  assert.match(html, /Promise\.allSettled\(\[fetchAwin\(range\),fetchAwin/);
  assert.match(html, /if\(nowResult\.status==='rejected'\)throw nowResult\.reason/);
  assert.match(html, /exportAwin" disabled/);
});

test('public settings do not expose the personal telephone number', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.doesNotMatch(html, /tel:\+393295363457|329\s*5363457/);
});
