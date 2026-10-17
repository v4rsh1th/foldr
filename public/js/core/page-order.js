// Pure page-arrangement model shared by Organize and Rotate.
//
// A page entry is { key, sourceIndex, baseRotation, rotation }:
//  - sourceIndex: 0-based index of the page in the source PDF
//  - baseRotation: the page's existing /Rotate value (0, 90, 180, 270)
//  - rotation: the user's additional clockwise rotation (0, 90, 180, 270)
//
// Previews render at effectiveRotation(page) and export writes exactly that
// value as the page's absolute /Rotate. Because the user delta is only ever
// added once, at a single place, the existing rotation is never applied twice.
//
// All functions return new arrays and never mutate their inputs.

export function normalizeRotation(degrees) {
  if (!Number.isFinite(degrees) || degrees % 90 !== 0) {
    throw new RangeError(`Rotation must be a multiple of 90 degrees, got ${degrees}`);
  }
  return ((degrees % 360) + 360) % 360;
}

export function effectiveRotation(page) {
  return normalizeRotation(page.baseRotation + page.rotation);
}

/** Builds the initial arrangement from per-page info ({ rotation }). */
export function createPages(pageInfos) {
  return pageInfos.map((info, index) => ({
    key: `p${index}`,
    sourceIndex: index,
    baseRotation: normalizeRotation(info?.rotation ?? 0),
    rotation: 0,
  }));
}

function clampIndex(index, length) {
  return Math.max(0, Math.min(length - 1, index));
}

/** Moves one page from `fromIndex` to `toIndex` (indices in the current order). */
export function movePage(pages, fromIndex, toIndex) {
  if (fromIndex < 0 || fromIndex >= pages.length) return pages;
  const target = clampIndex(toIndex, pages.length);
  if (target === fromIndex) return pages;
  const next = pages.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * Moves the selected pages as a block while keeping their relative order.
 * `direction`: 'start' | 'end' | -1 (one step earlier) | 1 (one step later).
 */
export function moveSelection(pages, selectedKeys, direction) {
  const selected = new Set(selectedKeys);
  if (selected.size === 0) return pages;
  const chosen = pages.filter((page) => selected.has(page.key));
  const others = pages.filter((page) => !selected.has(page.key));
  if (direction === 'start') return [...chosen, ...others];
  if (direction === 'end') return [...others, ...chosen];
  if (direction !== -1 && direction !== 1) throw new RangeError(`Unknown direction ${direction}`);

  // Step each selected page past one unselected neighbour. Iterate from the
  // side we are moving towards so adjacent selected pages move together.
  const next = pages.slice();
  const indices = next.map((page, index) => (selected.has(page.key) ? index : -1)).filter((i) => i >= 0);
  if (direction === 1) indices.reverse();
  let boundary = direction === -1 ? 0 : next.length - 1;
  for (const index of indices) {
    const target = index + direction;
    const blocked = direction === -1 ? target < boundary : target > boundary;
    if (blocked || selected.has(next[target].key)) {
      // Already packed against the edge or another blocked selected page.
      boundary = index - direction;
      continue;
    }
    [next[index], next[target]] = [next[target], next[index]];
  }
  return next;
}

export function deletePages(pages, keys) {
  const remove = new Set(keys);
  return pages.filter((page) => !remove.has(page.key));
}

/** Adds `delta` degrees (±90, 180…) to the selected pages, or all if keys is null. */
export function rotatePages(pages, keys, delta) {
  const targets = keys ? new Set(keys) : null;
  return pages.map((page) =>
    !targets || targets.has(page.key)
      ? { ...page, rotation: normalizeRotation(page.rotation + delta) }
      : page,
  );
}

export function resetRotation(pages, keys = null) {
  const targets = keys ? new Set(keys) : null;
  return pages.map((page) =>
    (!targets || targets.has(page.key)) && page.rotation !== 0 ? { ...page, rotation: 0 } : page,
  );
}

export function hasRotationChanges(pages) {
  return pages.some((page) => page.rotation !== 0);
}

/** True if the arrangement differs from the untouched source document. */
export function isModified(pages, originalCount) {
  if (pages.length !== originalCount) return true;
  return pages.some((page, index) => page.sourceIndex !== index || page.rotation !== 0);
}

/** The instructions the PDF worker needs: source page and absolute rotation, in order. */
export function toExportPlan(pages) {
  if (pages.length === 0) throw new RangeError('A PDF needs at least one page.');
  return pages.map((page) => ({ sourceIndex: page.sourceIndex, rotation: effectiveRotation(page) }));
}

/** Small undo/redo stack of immutable states. */
export function createHistory(initial, limit = 100) {
  let past = [];
  let present = initial;
  let future = [];
  return {
    get state() { return present; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    push(next) {
      if (next === present) return present;
      past.push(present);
      if (past.length > limit) past = past.slice(past.length - limit);
      present = next;
      future = [];
      return present;
    },
    undo() {
      if (!past.length) return present;
      future.push(present);
      present = past.pop();
      return present;
    },
    redo() {
      if (!future.length) return present;
      past.push(present);
      present = future.pop();
      return present;
    },
    reset(next) {
      past = [];
      future = [];
      present = next;
      return present;
    },
  };
}
