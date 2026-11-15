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

    const selected = run('--advertiser', 'Cisalfa Sport IT', 'OneStreet');
    assert.match(selected.stdout, /Listini aggiornati: 2/);
    assert.match(selected.stdout, /2\/3 Aggiornamento catalogo/);
    assert.doesNotMatch(selected.stdout, /3\/3/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
