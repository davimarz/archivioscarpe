const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('an incomplete download is recoverable and an explicit list can proceed to import', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awin-recovery-'));
  try {
    const script = path.join(dir, 'aggiorna.cjs');
    const mock = path.join(dir, 'mock.cjs');
    fs.copyFileSync('tools/awin/aggiorna-archivio-scarpe.cjs', script);
    fs.writeFileSync(mock, `
      const children = require('node:child_process');
      const run = children.spawnSync;
      children.spawnSync = (cmd, ...args) => cmd === 'git' ? {status: 1} : run(cmd, ...args);
      global.fetch = async () => new Response(\`
async function readJoinedAdvertisers(page) {
  return [];
}
        const fs = require('node:fs');
        const path = require('node:path');
        const names = process.argv.slice(3);
        for (const name of names.length ? names : ['Cisalfa Sport IT', 'OneStreet']) {
          fs.writeFileSync(path.join(process.env.AWIN_LISTINI_DIR, name + '.csv.gz'), 'feed');
        }
        if (!names.length) process.exitCode = 1;
      \`);
    `);
    const run = (...args) => spawnSync(process.execPath, ['--require', mock, script, '3150312', ...args], {
      encoding: 'utf8'
    });
    const partial = run();
    assert.equal(partial.status, 1);
    assert.match(partial.stderr, /Listini parziali conservati: 2/);
    assert.doesNotMatch(partial.stdout, /2\/3/);
    const recoveries = path.join(dir, 'LISTINI-PARZIALI');
    const retained = path.join(recoveries, fs.readdirSync(recoveries)[0]);
    assert.deepEqual(fs.readdirSync(retained).sort(), ['Cisalfa Sport IT.csv.gz', 'OneStreet.csv.gz']);
    assert.equal(fs.existsSync(path.join(dir, 'LISTINI')), false);

    const fromFiles = run('--da-listini', retained);
    assert.match(fromFiles.stdout, /2\/3 Aggiornamento catalogo/);

    const completed = run('--completa-listini', retained, 'Marco Cerullo');
    assert.match(completed.stdout, /Listini aggiornati: 3/);
    assert.match(completed.stdout, /2\/3 Aggiornamento catalogo/);
    assert.deepEqual(fs.readdirSync(retained).sort(),
      ['Cisalfa Sport IT.csv.gz', 'Marco Cerullo.csv.gz', 'OneStreet.csv.gz']);

    const selected = run('--advertiser', 'Cisalfa Sport IT', 'OneStreet');
    assert.match(selected.stdout, /Listini aggiornati: 2/);
    assert.match(selected.stdout, /2\/3 Aggiornamento catalogo/);
    assert.doesNotMatch(selected.stdout, /3\/3/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('waits for the eleventh advertiser after clicking the paginator', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync('tools/awin/aggiorna-archivio-scarpe.cjs', 'utf8');
  const block = source.match(/^async function readJoinedAdvertisers\(page\) \{[\s\S]*?^\}/m)[0];
  const first = Array.from({ length: 10 }, (_, i) => 'Negozio ' + i);
  let clicks = 0, reads = 0;
  const locator = {
    filter: () => locator, or: () => locator, count: async () => 1, click: async () => { clicks++; }
  };
  const page = {
    getByText: label => String(label).includes('Risultati per pagina') ? {filter: () => ({count: async () => 0})} : locator, getByRole: () => locator, isClosed: () => false,
    evaluate: async () => ({ names: ++reads === 1 ? first : ['Undicesimo'] })
  };
  const read = vm.runInNewContext(block + ';readJoinedAdvertisers', {
    readAdvertiserPage: async () => ({ names: first, total: 11 }),
    inspectPersonalAdvertisers() {}, console: { log() {} }, setTimeout: resolve => resolve()
  });
  assert.deepEqual(Array.from(await read(page)), [...first, 'Undicesimo']);
  assert.equal(clicks, 1);
  assert.equal(reads, 2);
});

test('resumes once the user reveals the missing advertiser in Awin', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync('tools/awin/aggiorna-archivio-scarpe.cjs', 'utf8');
  const block = source.match(/^async function readJoinedAdvertisers\(page\) \{[\s\S]*?^\}/m)[0];
  const first = Array.from({ length: 10 }, (_, i) => 'Negozio ' + i);
  const locator = { filter: () => locator, or: () => locator, count: async () => 0 };
  let now = 0, manual = false, navigations = 0;
  const page = {
    getByText: () => locator, getByRole: () => locator, isClosed: () => false,
    evaluate: async () => ({ names: manual ? [...first, 'Undicesimo'] : first })
  };
  const read = vm.runInNewContext(block + ';readJoinedAdvertisers', {
    readAdvertiserPage: async () => ({ names: first, total: 11 }),
    inspectPersonalAdvertisers() {},
    open: async () => { navigations++; },
    console: { log(message) { if (message.includes('2 minuti')) manual = true; } },
    Date: { now: () => now },
    setTimeout(resolve, delay) { now += delay; resolve(); }
  });
  assert.deepEqual(Array.from(await read(page)), [...first, 'Undicesimo']);
  assert.equal(navigations, 0);
  assert.equal(manual, true);
});

test('shows all eleven advertisers using the results-per-page menu', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync('tools/awin/aggiorna-archivio-scarpe.cjs', 'utf8');
  const block = source.match(/^async function readJoinedAdvertisers\(page\) \{[\s\S]*?^\}/m)[0];
  const first = Array.from({ length: 10 }, (_, i) => 'Negozio ' + i);
  let menu = false, expanded = false;
  const control = (count, click) => ({ count: async () => count(), click: async () => click(), filter() { return this; } });
  const current = control(() => 1, () => { menu = true; });
  const label = { ...control(() => 1, () => {}), locator: () => ({ getByText: () => current }) };
  const page = {
    getByText(value) {
      if (String(value).includes('Risultati per pagina')) return label;
      return control(() => Number(menu && value === '25'), () => { expanded = true; });
    },
    getByRole: () => ({ ...control(() => 0, () => {}), or() { return this; } }),
    isClosed: () => false,
    evaluate: async () => ({ names: expanded ? [...first, 'Undicesimo'] : first })
  };
  const read = vm.runInNewContext(block + ';readJoinedAdvertisers', {
    readAdvertiserPage: async () => ({ names: first, total: 11 }),
    inspectPersonalAdvertisers() {}, console: { log() {} }
  });
  assert.deepEqual(Array.from(await read(page)), [...first, 'Undicesimo']);
  assert.equal(expanded, true);
});
