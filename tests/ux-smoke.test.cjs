// Run with: node tests/ux-smoke.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync('index.html', 'utf8');
const cases = [
  ['Empty archive distinguishes filters', /id="emptyArchiveTitle"/.test(html) && /filteredEmpty \? 'Nessuna scarpa corrisponde ai filtri'/.test(html)],
  ['Empty state can clear filters', /emptyAction\.onclick = filteredEmpty \? resetArchiveFilters/.test(html)],
  ['Mobile safe bottom spacing', /padding-bottom:calc\(125px \+ env\(safe-area-inset-bottom\)\)/.test(html)],
  ['Empty action remains above mobile navigation', /#emptyArchiveMsg:not\(\.hidden\) #emptyArchiveAction/.test(html) && /bottom:calc\(91px \+ env\(safe-area-inset-bottom\)\)/.test(html)],
  ['Search and photo have separate panels', /id="checkTextPanel"/.test(html) && /id="checkPhotoPanel"/.test(html)],
  ['AI status near upload actions', /id="addAiStatus"/.test(html) && /id="checkAiStatus"/.test(html)],
  ['Duplicate warning shows existing item', /dataset\.duplicateShoe/.test(html) && /openShoeGallery\(duplicateButton\.dataset\.duplicateShoe\)/.test(html)],
  ['Desktop responsive grid', /max-width:1080px/.test(html)],
  ['Mobile categories wrap', /category-pills/.test(html) && /flex-wrap:wrap/.test(html)],
  ['Form labels associated with fields', ['addBrand','addModel','addCategory','addColors','addNotes'].every(id => html.includes('for="'+id+'"'))],
  ['Required fields explained', /\* Campi obbligatori/.test(html)],
  ['Category buttons announce pressed state', /setAttribute\('aria-pressed','true'\)/.test(html) && /setAttribute\('aria-pressed','false'\)/.test(html)],
  ['Readable helper text', /\.help-text \{ font-size:12px/.test(html)],
  ['Backup emphasizes export and warns replacement', /il ripristino sostituisce l'archivio attuale/.test(html) && /bg-amber-500 text-slate-950 text-xs font-bold"><i class="fa-solid fa-download/.test(html)]
];
for (const [name, ok] of cases) { assert.ok(ok, name); process.stdout.write('PASS ' + name + '\n'); }
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
for (const [, script] of scripts) new Function(script);
console.log('PASS inline JavaScript syntax (' + scripts.length + ' blocks)');
