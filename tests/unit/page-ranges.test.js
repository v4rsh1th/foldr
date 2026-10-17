import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePageList, parseRangeGroups, chunkPages, formatPageLabel, formatGroupsInput, PageRangeError,
} from '../../public/js/core/page-ranges.js';

test('parses single pages and inclusive ranges in written order', () => {
  assert.deepEqual(parsePageList('1, 3, 5-8', 10), [1, 3, 5, 6, 7, 8]);
  assert.deepEqual(parsePageList('8, 2', 10), [8, 2]);
});

test('tolerates whitespace and dash variants', () => {
  assert.deepEqual(parsePageList('  2 -4 ,6  ', 10), [2, 3, 4, 6]);
  assert.deepEqual(parsePageList('1–3', 5), [1, 2, 3]);
});

test('descending ranges yield pages in reverse order', () => {
  assert.deepEqual(parsePageList('5-3', 5), [5, 4, 3]);
});

test('rejects page zero', () => {
  assert.throws(() => parsePageList('0', 5), { name: 'PageRangeError', message: /start at 1/ });
  assert.throws(() => parsePageList('0-3', 5), PageRangeError);
});

test('rejects negative numbers', () => {
  assert.throws(() => parsePageList('-3', 5), { message: /negative/ });
});

test('rejects invalid syntax without evaluating it', () => {
  for (const input of ['abc', '1-2-3', '1..3', '2+2', '1;2', 'alert(1)', '3-', '1, two']) {
    assert.throws(() => parsePageList(input, 10), PageRangeError, input);
  }
});

test('rejects empty input and empty entries', () => {
  assert.throws(() => parsePageList('', 5), { message: /at least one/ });
  assert.throws(() => parsePageList('   ', 5), PageRangeError);
  assert.throws(() => parsePageList('1,,2', 5), { message: /empty entry/ });
  assert.throws(() => parsePageList('1,', 5), { message: /empty entry/ });
});

test('rejects pages beyond the document', () => {
  assert.throws(() => parsePageList('4', 3), { message: /Page 4 doesn’t exist\. This document has 3 pages/ });
  assert.throws(() => parsePageList('2-9', 3), PageRangeError);
  assert.throws(() => parsePageList('99999999999999', 3), PageRangeError);
  assert.throws(() => parsePageList('2', 1), { message: /has 1 page\./ });
});

test('duplicate pages are rejected by default and kept when allowed', () => {
  assert.throws(() => parsePageList('1, 2, 1', 5), { message: /Page 1 is included more than once/ });
  assert.throws(() => parsePageList('1-3, 2', 5), { message: /Page 2/ });
  assert.deepEqual(parsePageList('1, 2, 1', 5, { allowDuplicates: true }), [1, 2, 1]);
});

test('range groups produce one group per item and may overlap', () => {
  const groups = parseRangeGroups('1-5, 6-10, 11', 12);
  assert.deepEqual(groups.map((g) => g.pages.length), [5, 5, 1]);
  assert.deepEqual(groups.map((g) => g.label), ['1-5', '6-10', '11']);
  assert.deepEqual(parseRangeGroups('1-3, 2-4', 4).map((g) => g.pages), [[1, 2, 3], [2, 3, 4]]);
  assert.throws(() => parseRangeGroups('1-5, 6-20', 12), PageRangeError);
});

test('chunkPages splits evenly with a shorter final chunk', () => {
  assert.deepEqual(chunkPages(7, 3).map((g) => g.label), ['1-3', '4-6', '7']);
  assert.equal(chunkPages(4, 10).length, 1);
  assert.throws(() => chunkPages(4, 0), PageRangeError);
  assert.equal(formatGroupsInput(chunkPages(7, 3)), '1-3, 4-6, 7');
});

test('formatPageLabel compresses runs', () => {
  assert.equal(formatPageLabel([1, 2, 3, 5, 8, 7, 6]), '1-3_5_8-6');
  assert.equal(formatPageLabel([4]), '4');
  assert.equal(formatPageLabel([1, 3, 5]), '1_3_5');
});

test('rejects invalid page counts', () => {
  assert.throws(() => parsePageList('1', 0), TypeError);
});
