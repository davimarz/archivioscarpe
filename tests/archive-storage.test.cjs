const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const html = fs.readFileSync('index.html', 'utf8');
const functions = ['saveToStorage', 'saveShoe', 'saveEditedShoe'].map(name =>
  html.match(new RegExp('    function ' + name + '\\([\\s\\S]*?\\n    }'))[0]).join('\n');

test('a failed add or edit keeps the draft and the last saved archive', () => {
  const original = { id: 'old', brand: 'Prima' };
  const values = { addBrand: 'Marca', addModel: 'Modello', addColors: 'Blu', editShoeId: 'old',
    editShoeBrand: 'Nuova', editShoeModel: 'Modello', editShoeColors: 'Blu' };
  const elements = {};
  let serialized = JSON.stringify([original]);
  let fail = true;
  let resets = 0, closed = 0, notices = 0;
  const context = vm.createContext({
    shoes: [original], collectionNames: [], editingImages: ['foto'], imagesByMode: { add: 'foto' }, addExtraImages: [],
    document: { getElementById: id => elements[id] ??= {
      value: values[id] || '', reset: () => resets++, classList: { add() {}, remove() {} }
    }},
    localStorage: {
      getItem: () => serialized,
      setItem: (key, value) => {
        if (key !== 'kicks_archive_v17') return;
        if (fail) throw new Error('QuotaExceededError');
        serialized = value;
      }
    },
    console: { error() {} }, alert: () => notices++, saveAutomaticSnapshot() {},
    renderArchive() {}, normalizeSku() {}, readShoePurchaseFields: () => ({}),
    getAddDuplicates: () => [], updateAddDuplicateNotice() {}, renderPhotoThumbnails() {},
    parseCollectionNames: () => [], saveCollectionNames() {}, showToast() {}, switchTab() {},
    closeEditShoeModal: () => closed++
  });
  vm.runInContext(functions, context);
  const event = { preventDefault() {} };
  context.saveShoe(event);
  context.saveEditedShoe(event);
  assert.equal(context.shoes[0], original);
  assert.equal(context.shoes.length, 1);
  assert.equal(context.imagesByMode.add, 'foto');
  assert.equal(JSON.parse(serialized)[0].brand, 'Prima');
  assert.deepEqual([resets, closed, notices], [0, 0, 2]);
  fail = false;
  context.saveEditedShoe(event);
  context.saveShoe(event);
  assert.deepEqual(JSON.parse(serialized).map(shoe => shoe.brand), ['Marca', 'Nuova']);
  assert.deepEqual([resets, closed], [1, 1]);
});
