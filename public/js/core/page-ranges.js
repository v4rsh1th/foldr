// Strict page-range parsing. Input is never evaluated; it is tokenised with
// fixed regular expressions and every page is checked against the document.
//
// Syntax: comma-separated items, each either a page ("7") or an inclusive
// range ("3-9"). Descending ranges ("9-3") are allowed and yield pages in the
// order written. En/em dashes are accepted as range separators.
//
// Duplicate behaviour:
//  - parsePageList (extract mode) rejects a page that appears more than once,
//    because a repeated page is almost always a typo. Pass
//    { allowDuplicates: true } to keep repeats in the order written.
//  - parseRangeGroups (split-by-ranges mode) allows groups to overlap, since
//    each group is written to its own file.

export class PageRangeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PageRangeError';
  }
}

const PAGE_PATTERN = /^(\d+)$/;
const RANGE_PATTERN = /^(\d+)\s*-\s*(\d+)$/;
const MAX_DIGITS = 9;

function normalise(input) {
  return String(input ?? '').replace(/[‒-―−]/g, '-').trim();
}

function toPageNumber(text, item, pageCount) {
  if (text.length > MAX_DIGITS) {
    throw new PageRangeError(`“${item}” is outside this document, which has ${describeCount(pageCount)}.`);
  }
  const page = Number.parseInt(text, 10);
  if (page === 0) throw new PageRangeError('Page numbers start at 1, so “0” isn’t a valid page.');
  if (page > pageCount) {
    throw new PageRangeError(`Page ${page} doesn’t exist. This document has ${describeCount(pageCount)}.`);
  }
  return page;
}

function describeCount(pageCount) {
  return pageCount === 1 ? '1 page' : `${pageCount} pages`;
}

function parseItem(item, pageCount) {
  const single = PAGE_PATTERN.exec(item);
  if (single) {
    return [toPageNumber(single[1], item, pageCount)];
  }
  const range = RANGE_PATTERN.exec(item);
  if (range) {
    const start = toPageNumber(range[1], item, pageCount);
    const end = toPageNumber(range[2], item, pageCount);
    const step = start <= end ? 1 : -1;
    const pages = [];
    for (let page = start; page !== end + step; page += step) pages.push(page);
    return pages;
  }
  if (/^-\s*\d+/.test(item)) {
    throw new PageRangeError(`“${item}” isn’t valid. Page numbers can’t be negative.`);
  }
  throw new PageRangeError(`“${item}” isn’t a page number or range. Use a format like 1, 3, 5-8.`);
}

function splitItems(input) {
  const text = normalise(input);
  if (!text) throw new PageRangeError('Enter at least one page number or range, for example 1-3.');
  const items = text.split(',').map((item) => item.trim());
  if (items.some((item) => item === '')) {
    throw new PageRangeError('There’s an empty entry between commas. Remove the extra comma.');
  }
  return items;
}

function assertPageCount(pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new TypeError('pageCount must be a positive integer');
  }
}

/** Parses "1, 3, 5-8" into [1, 3, 5, 6, 7, 8] (1-based, in written order). */
export function parsePageList(input, pageCount, { allowDuplicates = false } = {}) {
  assertPageCount(pageCount);
  const pages = [];
  const seen = new Set();
  for (const item of splitItems(input)) {
    for (const page of parseItem(item, pageCount)) {
      if (!allowDuplicates && seen.has(page)) {
        throw new PageRangeError(`Page ${page} is included more than once.`);
      }
      seen.add(page);
      pages.push(page);
    }
  }
  return pages;
}

/** Parses "1-5, 6-10, 11" into one group per comma-separated item. */
export function parseRangeGroups(input, pageCount) {
  assertPageCount(pageCount);
  return splitItems(input).map((item) => {
    const pages = parseItem(item, pageCount);
    return { pages, label: formatPageLabel(pages) };
  });
}

/** Groups of `size` consecutive pages: 1-size, size+1-2*size, … */
export function chunkPages(pageCount, size) {
  assertPageCount(pageCount);
  if (!Number.isInteger(size) || size < 1) {
    throw new PageRangeError('Enter a whole number of pages per file, 1 or more.');
  }
  const groups = [];
  for (let start = 1; start <= pageCount; start += size) {
    const end = Math.min(start + size - 1, pageCount);
    const pages = [];
    for (let page = start; page <= end; page += 1) pages.push(page);
    groups.push({ pages, label: formatPageLabel(pages) });
  }
  return groups;
}

/** Formats a range-group list back into input syntax: "1-5, 6-10". */
export function formatGroupsInput(groups) {
  return groups.map((group) => formatPageLabel(group.pages, ', ')).join(', ');
}

/**
 * Compresses a page list into runs: [1,2,3,5,8,7,6] -> "1-3_5_8-6".
 * Used for filenames and labels. `separator` joins the runs.
 */
export function formatPageLabel(pages, separator = '_') {
  const runs = [];
  let index = 0;
  while (index < pages.length) {
    const start = pages[index];
    let end = start;
    let step = 0;
    let next = index + 1;
    if (next < pages.length && Math.abs(pages[next] - start) === 1) {
      step = pages[next] - start;
      while (next < pages.length && pages[next] - end === step) {
        end = pages[next];
        next += 1;
      }
    }
    runs.push(start === end ? `${start}` : `${start}-${end}`);
    index = start === end ? index + 1 : next;
  }
  return runs.join(separator);
}
