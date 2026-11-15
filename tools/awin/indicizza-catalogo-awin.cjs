const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function catalogIndex(items, content) {
  if (content !== JSON.stringify(items) + '\n') throw new Error('Formato del catalogo non indicizzabile');
  const bytes = Buffer.from(content);
  const ranges = { low: [], mid: [], high: [] };
  let offset = 1;
  let start = 1;
  let lastBand;
  function finish(end) {
    if (lastBand) ranges[lastBand].push([start, end]);
  }
  for (const item of items) {
    const amount = Number(String(item.price).replace(',', '.'));
    const band = amount < 50 ? 'low' : amount <= 150 ? 'mid' : 'high';
    if (band !== lastBand || offset - start >= 16384) {
      finish(offset - 1);
      start = offset;
      lastBand = band;
    }
    offset += Buffer.byteLength(JSON.stringify(item)) + 1;
  }
  finish(offset - 1);
  return {
    size: bytes.length,
    head: createHash('sha256').update(bytes.subarray(0, 1024)).digest('hex'),
    ranges
  };
}

if (require.main === module) {
  const directory = process.argv[2] || '.';
  const content = fs.readFileSync(path.join(directory, 'catalogo-awin.json'), 'utf8');
  const index = catalogIndex(JSON.parse(content), content);
  fs.writeFileSync(path.join(directory, 'catalogo-awin-indice.json'), JSON.stringify(index) + '\n');
}
module.exports = { catalogIndex };
