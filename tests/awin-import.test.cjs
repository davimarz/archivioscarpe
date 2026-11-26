const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

test('keeps one offer per brand and model with a valid previous price', () => {
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
    assert.equal(cards.length, 1);
    for (const card of cards) {
      assert.equal(card.price, '90,00');
      assert.equal(card.model, 'MOD-21');
      assert.equal(card.originalPrice, '95,00');
      assert.equal(card.referencePrice, '120,00');
    }
    assert.ok(cards.every(card => card.originalPrice === '95,00'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compares brand and model between sellers, adding shipping when available', () => {
  const root = mkdtempSync(join(tmpdir(), 'archivio-best-price-'));
  try {
    const feeds = join(root, 'LISTINI');
    mkdirSync(feeds);
    const header = 'product_name,brand_name,model_number,product_gtin,colour,size,sale_price,product_price_old,currency,merchant_category,delivery_cost,aw_deep_link,aw_image_url';
    for (const [merchant, sale, price, shipping] of [['A', 55, 60, 0], ['B', 49, 90, 15], ['C', 58, 90, '']]) {
      const row = ['Scarpe Esempio', 'Marca', 'MOD-21', '123456789012' + merchant.charCodeAt(0) % 10, 'Blu', '42', sale, price, 'EUR', 'Scarpe', shipping,
        'https://www.awin1.com/pclick.php?a=3150312&p=' + merchant, 'https://example.test/foto.jpg'];
      writeFileSync(join(feeds, merchant + '.csv'), header + '\n' + row.join(','));
    }
    execFileSync(process.execPath, ['tools/awin/importa-listini-awin.cjs', root, feeds, '3150312']);
    const cards = JSON.parse(readFileSync(join(root, 'catalogo-awin.json')));
    assert.deepEqual(cards.map(({ merchant, price }) => [merchant, price]), [['A', '55,00']]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('excludes RRP-only offers even for Marco Cerullo', () => {
  const root = mkdtempSync(join(tmpdir(), 'archivio-marco-cerullo-'));
  try {
    const feeds = join(root, 'LISTINI');
    mkdirSync(feeds);
    const header = 'product_name,brand_name,model_number,search_price,currency,merchant_category,rrp_price,aw_deep_link,aw_image_url';
    const row = ['BLAUER - Sneakers Donna Taupe', 'Blauer', '15047-36', 60, 'EUR', 'Scarpe', 119,
      'https://www.awin1.com/pclick.php?a=3150312&p=1', 'https://example.test/blauer.jpg'];
    writeFileSync(join(feeds, 'Marco Cerullo.csv'), header + '\n' + row.join(','));
    assert.throws(
      () => execFileSync(process.execPath, ['tools/awin/importa-listini-awin.cjs', root, feeds, '3150312'], {stdio: 'pipe'}),
      /Il catalogo generato non contiene offerte/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
