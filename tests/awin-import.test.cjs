const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

test('imports only valid reference prices and caps identifiable variants by seller and price', () => {
  const root = mkdtempSync(join(tmpdir(), 'archivio-feed-'));
  try {
    const feeds = join(root, 'LISTINI');
    mkdirSync(feeds);
    const header = 'product_name,brand_name,model_number,colour,size,search_price,currency,merchant_category,product_price_old,rrp_price,aw_deep_link,aw_image_url';
    const rows = [['Rosso', '42', 90], ['Bianco', '43', 90], ['Blu', '44', 90], ['Nero', '48', 100]];
    writeFileSync(join(feeds, 'Negozio.csv'), [header, ...rows.map(([color, size, price], id) =>
      ['Scarpe Esempio', 'Marca', 'MOD-21', color, size, price, 'EUR', 'Scarpe', 95, 120,
        'https://www.awin1.com/pclick.php?a=3150312&p=' + id, 'https://example.test/foto.jpg'].join(','))].join('\n'));
    execFileSync(process.execPath, ['tools/awin/importa-listini-awin.cjs', root, feeds, '3150312']);
    const cards = JSON.parse(readFileSync(join(root, 'catalogo-awin.json')));
    assert.equal(cards.length, 3);
    const variants = cards.filter(card => card.price === '90,00');
    assert.equal(variants.length, 2);
    assert.equal(new Set(variants.map(card => card.size)).size, 2);
    for (const card of variants) {
      assert.equal(card.model, 'MOD-21');
      assert.equal(card.colorCount, 3);
      assert.equal(card.sizeCount, 3);
      assert.equal(card.originalPrice, '95,00');
      assert.equal(card.referencePrice, '120,00');
    }
    assert.equal(cards.find(card => card.price === '100,00').originalPrice, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('selects the lowest discounted product price across retailers', () => {
  const root = mkdtempSync(join(tmpdir(), 'archivio-best-price-'));
  try {
    const feeds = join(root, 'LISTINI');
    mkdirSync(feeds);
    const header = 'product_name,product_gtin,colour,size,sale_price,search_price,currency,merchant_category,delivery_cost,aw_deep_link,aw_image_url';
    for (const [merchant, sale, price, shipping] of [['A', 55, 60, 0], ['B', 49, 90, 15]]) {
      const row = ['Scarpe Esempio', '1234567890123', 'Blu', '42', sale, price, 'EUR', 'Scarpe', shipping,
        'https://www.awin1.com/pclick.php?a=3150312&p=' + merchant, 'https://example.test/foto.jpg'];
      writeFileSync(join(feeds, merchant + '.csv'), header + '\n' + row.join(','));
    }
    execFileSync(process.execPath, ['tools/awin/importa-listini-awin.cjs', root, feeds, '3150312']);
    const cards = JSON.parse(readFileSync(join(root, 'catalogo-awin.json')));
    assert.deepEqual(cards.map(({ merchant, price }) => [merchant, price]), [['B', '49,00']]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
