import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPages, movePage, moveSelection, deletePages, rotatePages, resetRotation,
  effectiveRotation, normalizeRotation, isModified, toExportPlan, createHistory, hasRotationChanges,
} from '../../public/js/core/page-order.js';

const four = () => createPages([{}, {}, {}, {}]);
const order = (pages) => pages.map((page) => page.sourceIndex + 1);

test('createPages records base rotation and starts unmodified', () => {
  const pages = createPages([{ rotation: 0 }, { rotation: 90 }, { rotation: -90 }]);
  assert.deepEqual(pages.map((p) => p.baseRotation), [0, 90, 270]);
  assert.equal(isModified(pages, 3), false);
});

test('reordering to 3, 1, 4, 2 exports exactly that order', () => {
  let pages = four();
  pages = movePage(pages, 2, 0); // 3 1 2 4
  pages = movePage(pages, 3, 2); // 3 1 4 2
  assert.deepEqual(order(pages), [3, 1, 4, 2]);
  assert.deepEqual(toExportPlan(pages).map((p) => p.sourceIndex), [2, 0, 3, 1]);
  assert.equal(isModified(pages, 4), true);
});

test('movePage clamps and ignores invalid moves', () => {
  const pages = four();
  assert.deepEqual(order(movePage(pages, 0, 99)), [2, 3, 4, 1]);
  assert.equal(movePage(pages, 1, 1), pages);
  assert.equal(movePage(pages, 9, 0), pages);
});

test('moveSelection moves blocks while preserving relative order', () => {
  const pages = four();
  const keys = [pages[1].key, pages[3].key];
  assert.deepEqual(order(moveSelection(pages, keys, 'start')), [2, 4, 1, 3]);
  assert.deepEqual(order(moveSelection(pages, keys, 'end')), [1, 3, 2, 4]);
  assert.deepEqual(order(moveSelection(pages, keys, -1)), [2, 1, 4, 3]);
  assert.deepEqual(order(moveSelection(pages, keys, 1)), [1, 3, 2, 4]);
  // Already at the edge: no change.
  assert.deepEqual(order(moveSelection(pages, [pages[0].key, pages[1].key], -1)), [1, 2, 3, 4]);
  assert.deepEqual(order(moveSelection(pages, [pages[3].key], 1)), [1, 2, 3, 4]);
});

test('deletePages removes pages and combined reorder + delete exports correctly', () => {
  let pages = four();
  pages = movePage(pages, 3, 0); // 4 1 2 3
  pages = deletePages(pages, [pages[2].key]); // remove source page 2
  assert.deepEqual(order(pages), [4, 1, 3]);
  assert.deepEqual(toExportPlan(pages).map((p) => p.sourceIndex), [3, 0, 2]);
});

test('toExportPlan refuses an empty document', () => {
  const pages = four();
  assert.throws(() => toExportPlan(deletePages(pages, pages.map((p) => p.key))), RangeError);
});

test('rotation adds to the existing rotation exactly once', () => {
  let pages = createPages([{ rotation: 90 }, { rotation: 0 }]);
  pages = rotatePages(pages, [pages[0].key], 90);
  assert.equal(effectiveRotation(pages[0]), 180);
  assert.equal(pages[0].rotation, 90);
  pages = rotatePages(pages, null, -90);
  assert.deepEqual(pages.map(effectiveRotation), [90, 270]);
  assert.deepEqual(toExportPlan(pages).map((p) => p.rotation), [90, 270]);
});

test('four clockwise rotations return to the original', () => {
  let pages = createPages([{ rotation: 270 }]);
  for (let i = 0; i < 4; i += 1) pages = rotatePages(pages, null, 90);
  assert.equal(effectiveRotation(pages[0]), 270);
  assert.equal(hasRotationChanges(pages), false);
});

test('resetRotation clears user rotation only', () => {
  let pages = createPages([{ rotation: 90 }, { rotation: 0 }]);
  pages = rotatePages(pages, null, 90);
  pages = resetRotation(pages, [pages[0].key]);
  assert.deepEqual(pages.map(effectiveRotation), [90, 90]);
  pages = resetRotation(pages);
  assert.equal(hasRotationChanges(pages), false);
});

test('normalizeRotation rejects non-quarter turns', () => {
  assert.equal(normalizeRotation(-450), 270);
  assert.throws(() => normalizeRotation(45), RangeError);
});

test('operations do not mutate their input', () => {
  const pages = Object.freeze(four().map(Object.freeze));
  movePage(pages, 0, 2);
  rotatePages(pages, null, 90);
  deletePages(pages, [pages[0].key]);
  moveSelection(pages, [pages[0].key], 1);
});

test('history supports undo and redo', () => {
  const history = createHistory('a');
  history.push('b');
  history.push('c');
  assert.equal(history.undo(), 'b');
  assert.equal(history.canRedo, true);
  assert.equal(history.redo(), 'c');
  history.undo();
  history.push('d');
  assert.equal(history.canRedo, false);
  assert.equal(history.undo(), 'b');
  history.reset('z');
  assert.equal(history.canUndo, false);
});
