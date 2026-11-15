const assert = require('node:assert/strict');
const { test } = require('node:test');
const { openAwinCatalog } = require('../assets/catalogo.js');

function server(text, etags = ['"1"']) {
  const bytes = Buffer.from(text);
  let calls = 0;
  return async (_url, { headers }) => {
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
    const start = Number(a);
    const end = Math.min(Number(b), bytes.length - 1);
    return new Response(bytes.subarray(start, end + 1), { status: 206, headers: {
      'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
      ETag: etags[Math.min(calls++, etags.length - 1)]
    }});
  };
}

test('reads across byte ranges and only fetches the next block on demand', async () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: i, name: 'Città \"}{\" 👟', data: { i } }));
  const fetch = server(JSON.stringify(items));
  let calls = 0;
  const reader = openAwinCatalog('/catalog', (...args) => { calls++; return fetch(...args); }, 31);
  const actual = await reader.next();
  assert.equal(calls, 1);
  assert.equal(reader.ended, false);
  while (!reader.ended) actual.push(...await reader.next());
  assert.deepEqual(actual, items);
});

test('does not combine blocks from two revisions', async () => {
  const reader = openAwinCatalog('/catalog', server('[{"name":"Modello"}]', ['"1"', '"2"']), 8);
  await reader.next();
  await assert.rejects(() => reader.next(), /Catalogo cambiato/);
});

test('accepts the full response when a host ignores the first range', async () => {
  const reader = openAwinCatalog('/catalog', async () => new Response('[{"name":"Modello"}]'));
  assert.deepEqual(await reader.next(), [{ name: 'Modello' }]);
  assert.equal(reader.ended, true);
});

test('mixed pages draw two per band and keep their position independently of the filters', () => {
  const { nextPromotionPage } = require('../assets/catalogo.js');
  const bands = { low: ['L1','L2','L3','L4','L5','L6'], mid: ['M1','M2','M3','M4'], high: ['H1','H2','H3','H4'] };
  const start = { low: 0, mid: 0, high: 0 };
  const first = nextPromotionPage(bands, start, 'all', false);
  assert.deepEqual(first.items, ['L1','L2','M1','M2','H1','H2']);
  assert.deepEqual(nextPromotionPage(bands, start, 'low', true).items, bands.low);
  const second = nextPromotionPage(bands, first.positions, 'all', true);
  assert.deepEqual(second.items, ['L3','L4','M3','M4','H3','H4']);
  const third = nextPromotionPage(bands, second.positions, 'all', true);
  assert.deepEqual(third.items, ['L5','L6']);
  assert.equal(third.hasMore, false);
  assert.equal(nextPromotionPage({ ...bands, high: [] }, start, 'all', false), null);
});

test('direct promotion links select the expected band and campaign labels are bounded', () => {
  const { promotionBandFromHash, promotionRoutes, instagramCampaign } = require('../assets/catalogo.js');
  for (const [band, hash] of Object.entries(promotionRoutes)) assert.equal(promotionBandFromHash(hash), band);
  assert.equal(promotionBandFromHash('#promozioni/sconosciuta'), undefined);
  assert.equal(instagramCampaign(' Scarpe_Sotto-50 '), 'scarpe_sotto-50');
  assert.equal(instagramCampaign('nome@example.com'), '');
  assert.equal(instagramCampaign('x'.repeat(49)), '');
});

test('indexed loading reaches every price band without reading the offers in between', async () => {
  const { openIndexedAwinCatalog } = require('../assets/catalogo.js');
  const { catalogIndex } = require('../tools/awin/indicizza-catalogo-awin.cjs');
  const sample = ['49,50', '50,00', '150,00', '150,01'].map(price =>
    ({ price, name: 'Città', filler: 'x'.repeat(2000) }));
  const content = JSON.stringify(sample) + '\n';
  const index = catalogIndex(sample, content);
  const fetchRange = server(content);
  const requests = [];
  const reader = openIndexedAwinCatalog('/catalog', '/index', (url, options) => {
    if (url === '/index') return Promise.resolve(Response.json(index));
    requests.push(options.headers.Range);
    return fetchRange(url, options);
  });
  assert.deepEqual(await reader.next(['high']), [sample[3]]);
  assert.ok(reader.ended(['high']));
  assert.ok(!reader.ended(['low']));
  assert.deepEqual(await reader.next(['low', 'mid']), sample.slice(0, 3));
  assert.equal(requests[0], 'bytes=0-1023');
  assert.equal(requests.length, 4);
  assert.ok(reader.ended());
});
