// Page thumbnail grid used by Organize, Rotate and result previews.
//
// Rendering: cards observe their visibility; a thumbnail is rendered only
// when its card is on (or near) screen, at a modest size, and re-rendered
// only when its source page or rotation changes. Rendered canvases are
// tracked in least-recently-visible order and released when the pixel
// budget is exceeded, so memory stays bounded for very long documents.
//
// Interaction: the grid is a multi-select listbox with a roving tabindex.
// Arrow keys move focus, Space toggles selection, and every drag-and-drop
// action has a keyboard and toolbar equivalent (see page-editor.js).

import { THUMBNAILS } from '../config.js';
import { effectiveRotation } from '../core/page-order.js';
import { h } from './dom.js';
import { icon } from './icons.js';

const DRAG_THRESHOLD = 6;
const AUTOSCROLL_EDGE = 60;

export function createPageGrid({
  previewDocument = null,
  pageSizes,
  mode = 'organize',
  label = 'Pages',
  onToggle = () => {},
  onMove = () => {},
  onCommand = () => {},
}) {
  const interactive = mode !== 'preview';
  const list = h('ol', {
    class: 'page-grid',
    role: interactive ? 'listbox' : 'list',
    'aria-label': label,
    'aria-multiselectable': interactive ? 'true' : undefined,
  });
  const cards = new Map();
  const visible = new Set();
  const rendered = new Map(); // key -> pixels, in least-recently-visible order
  let pixelsInUse = 0;
  let pages = [];
  let selection = new Set();
  let focusedKey = null;
  let destroyed = false;
  let previewFailed = !previewDocument;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const key = entry.target.dataset.key;
      const card = cards.get(key);
      if (!card) continue;
      if (entry.isIntersecting) {
        visible.add(key);
        touch(key);
        requestRender(card);
      } else {
        visible.delete(key);
        card.controller?.abort();
      }
    }
    enforceBudget();
  }, { rootMargin: THUMBNAILS.rootMargin });

  // ---- Rendering ------------------------------------------------------------

  function sizeFor(page) {
    const size = pageSizes[page.sourceIndex] ?? { width: 612, height: 792 };
    const quarter = effectiveRotation(page) % 180 !== 0;
    return quarter ? { width: size.height, height: size.width } : size;
  }

  function desiredKey(page) {
    return `${page.sourceIndex}:${effectiveRotation(page)}`;
  }

  function touch(key) {
    if (!rendered.has(key)) return;
    const pixels = rendered.get(key);
    rendered.delete(key);
    rendered.set(key, pixels);
  }

  function releaseCanvas(card) {
    if (rendered.has(card.key)) {
      pixelsInUse -= rendered.get(card.key);
      rendered.delete(card.key);
    }
    if (card.canvas) {
      card.canvas.width = 0;
      card.canvas.height = 0;
      card.canvas = null;
    }
    card.renderedKey = null;
  }

  function enforceBudget() {
    for (const [key] of rendered) {
      if (pixelsInUse <= THUMBNAILS.pixelBudget) break;
      if (visible.has(key)) continue;
      const card = cards.get(key);
      if (card) {
        releaseCanvas(card);
        card.thumb.replaceChildren(h('div', { class: 'page-card__placeholder' }));
      }
    }
  }

  function showPlaceholder(card, text) {
    card.thumb.replaceChildren(text
      ? h('div', { class: 'page-card__placeholder page-card__placeholder--error', text })
      : h('div', { class: 'page-card__placeholder' }));
  }

  function applyAspect(card) {
    const { width, height } = sizeFor(card.page);
    card.thumb.style.aspectRatio = `${width} / ${height}`;
    const landscape = width >= height;
    card.thumb.style.width = landscape ? '100%' : 'auto';
    card.thumb.style.height = landscape ? 'auto' : '100%';
  }

  async function requestRender(card) {
    if (destroyed || !visible.has(card.key)) return;
    const wanted = desiredKey(card.page);
    if (card.renderedKey === wanted || card.pendingKey === wanted) return;
    if (previewFailed) {
      showPlaceholder(card, 'Preview unavailable');
      return;
    }
    card.controller?.abort();
    const controller = new AbortController();
    card.controller = controller;
    card.pendingKey = wanted;
    const dpr = Math.min(window.devicePixelRatio || 1, THUMBNAILS.maxDevicePixelRatio);
    try {
      const canvas = await previewDocument.renderPage(card.page.sourceIndex, {
        rotation: effectiveRotation(card.page),
        maxSide: Math.round(THUMBNAILS.cssWidth * dpr),
        signal: controller.signal,
      });
      if (controller.signal.aborted || destroyed) {
        canvas.width = 0;
        return;
      }
      releaseCanvas(card);
      card.canvas = canvas;
      card.renderedKey = wanted;
      canvas.setAttribute('aria-hidden', 'true');
      card.thumb.replaceChildren(canvas);
      const pixels = canvas.width * canvas.height;
      rendered.set(card.key, pixels);
      pixelsInUse += pixels;
      enforceBudget();
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'RenderingCancelledException') return;
      console.warn('Foldr: thumbnail failed for one page:', error?.name);
      showPlaceholder(card, 'Preview unavailable');
      card.renderedKey = wanted;
    } finally {
      if (card.controller === controller) {
        card.controller = null;
        card.pendingKey = null;
      }
    }
  }

  // ---- Cards ----------------------------------------------------------------

  function createCard(page) {
    const thumb = h('div', { class: 'page-card__thumb' }, h('div', { class: 'page-card__placeholder' }));
    const badge = h('span', { class: 'page-card__badge', hidden: true });
    const title = h('span', { class: 'page-card__label' });
    const sub = h('span', { class: 'page-card__sub' });
    const quick = mode === 'rotate'
      ? h('button', {
        type: 'button',
        class: 'icon-btn page-card__quick',
        tabIndex: -1,
        'aria-hidden': 'true',
        title: 'Rotate clockwise',
        onClick: (event) => {
          event.stopPropagation();
          onCommand('rotate-page', { key: page.key, delta: 90 });
        },
      }, icon('rotateCw'))
      : null;
    const handle = mode === 'organize'
      ? h('span', { class: 'icon-btn page-card__quick page-card__handle', 'aria-hidden': 'true', title: 'Drag to move' }, icon('grip'))
      : null;
    const element = h('li', {
      class: `page-card${interactive ? '' : ' page-card--readonly'}`,
      role: interactive ? 'option' : undefined,
      dataset: { key: page.key },
      tabIndex: interactive ? -1 : undefined,
    },
    h('div', { class: 'page-card__frame' }, thumb, interactive && h('span', { class: 'page-card__check', 'aria-hidden': 'true' }, icon('check')), badge),
    h('div', { class: 'page-card__footer' }, h('div', {}, title, h('br'), sub), quick, handle));

    const card = { key: page.key, page, element, thumb, badge, title, sub, handle, canvas: null, renderedKey: null };
    if (interactive) bindCardEvents(card);
    observer.observe(element);
    return card;
  }

  function describe(page, index) {
    const parts = [`Page ${index + 1} of ${pages.length}`];
    if (page.sourceIndex !== index) parts.push(`originally page ${page.sourceIndex + 1}`);
    if (page.rotation) parts.push(`rotated ${page.rotation}° clockwise`);
    return parts.join(', ');
  }

  function updateCard(card, page, index) {
    const previous = card.page;
    card.page = page;
    card.title.textContent = `Page ${index + 1}`;
    card.sub.textContent = mode === 'preview' ? '' : page.sourceIndex !== index ? `was p. ${page.sourceIndex + 1}` : ' ';
    card.badge.hidden = !page.rotation;
    card.badge.textContent = page.rotation ? `${page.rotation}°` : '';
    if (interactive) {
      card.element.setAttribute('aria-selected', String(selection.has(page.key)));
      card.element.setAttribute('aria-label', describe(page, index));
      card.element.tabIndex = page.key === focusedKey ? 0 : -1;
    }
    if (!previous || effectiveRotation(previous) !== effectiveRotation(page) || card.thumb.style.aspectRatio === '') applyAspect(card);
    if (card.renderedKey !== desiredKey(page)) requestRender(card);
  }

  function update(nextPages, nextSelection = new Set()) {
    pages = nextPages;
    selection = nextSelection;
    if (!pages.some((page) => page.key === focusedKey)) focusedKey = pages[0]?.key ?? null;
    const keep = new Set(pages.map((page) => page.key));
    pages.forEach((page, index) => {
      let card = cards.get(page.key);
      if (!card) {
        card = createCard(page);
        cards.set(page.key, card);
      }
      updateCard(card, page, index);
      const current = list.children[index];
      if (current !== card.element) list.insertBefore(card.element, current ?? null);
    });
    // Detach removed cards but keep them cached so undo is instant.
    for (const [key, card] of cards) {
      if (!keep.has(key) && card.element.isConnected) {
        card.element.remove();
        visible.delete(key);
      }
    }
  }

  // ---- Keyboard ---------------------------------------------------------------

  function indexOfKey(key) {
    return pages.findIndex((page) => page.key === key);
  }

  function columns() {
    const children = [...list.children];
    if (children.length < 2) return 1;
    const top = children[0].offsetTop;
    const count = children.findIndex((child) => child.offsetTop !== top);
    return count === -1 ? children.length : count;
  }

  function focusIndex(index) {
    const page = pages[Math.max(0, Math.min(pages.length - 1, index))];
    if (!page) return;
    focusPage(page.key);
  }

  function focusPage(key) {
    const previous = cards.get(focusedKey);
    if (previous) previous.element.tabIndex = -1;
    focusedKey = key;
    const card = cards.get(key);
    if (!card) return;
    card.element.tabIndex = 0;
    card.element.focus({ preventScroll: false });
    card.element.scrollIntoView({ block: 'nearest' });
  }

  function onKeyDown(event) {
    const card = event.target.closest?.('.page-card');
    if (!card) return;
    const index = indexOfKey(card.dataset.key);
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(), ArrowDown: columns() }[event.key];
    const modifier = event.ctrlKey || event.metaKey;
    if (step !== undefined && event.altKey && mode === 'organize') {
      event.preventDefault();
      onCommand('move-focused', { key: card.dataset.key, delta: step });
      return;
    }
    if (step !== undefined) {
      event.preventDefault();
      focusIndex(index + step);
      if (event.shiftKey) onToggle(pages[Math.max(0, Math.min(pages.length - 1, index + step))].key, { extend: true });
      return;
    }
    switch (event.key) {
      case 'Home': event.preventDefault(); focusIndex(0); break;
      case 'End': event.preventDefault(); focusIndex(pages.length - 1); break;
      case ' ':
      case 'Enter': event.preventDefault(); onToggle(card.dataset.key, { additive: true }); break;
      case 'Delete':
      case 'Backspace': if (mode === 'organize') { event.preventDefault(); onCommand('delete-focused', { key: card.dataset.key }); } break;
      case 'r':
      case 'R': if (!modifier) { event.preventDefault(); onCommand('rotate-focused', { key: card.dataset.key, delta: event.shiftKey ? -90 : 90 }); } break;
      case 'a': if (modifier) { event.preventDefault(); onCommand('select-all'); } break;
      case 'Escape': onCommand('clear-selection'); break;
      default: break;
    }
  }

  // ---- Pointer: click to select, drag to move ----------------------------------

  let drag = null;
  let suppressClick = false;

  function bindCardEvents(card) {
    card.element.addEventListener('click', (event) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      focusedKey = card.key;
      onToggle(card.key, { extend: event.shiftKey, additive: true });
    });
    card.element.addEventListener('focus', () => {
      if (focusedKey !== card.key) {
        const previous = cards.get(focusedKey);
        if (previous) previous.element.tabIndex = -1;
        focusedKey = card.key;
        card.element.tabIndex = 0;
      }
    });
    if (mode !== 'organize') return;
    card.element.addEventListener('pointerdown', (event) => {
      const fromHandle = Boolean(event.target.closest('.page-card__handle'));
      // Touch users scroll by dragging, so on touch only the grip starts a drag.
      if (event.pointerType !== 'mouse' && !fromHandle) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      drag = { key: card.key, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false, element: card.element };
      card.element.setPointerCapture(event.pointerId);
    });
    card.element.addEventListener('pointermove', onPointerMove);
    card.element.addEventListener('pointerup', onPointerUp);
    card.element.addEventListener('pointercancel', cancelDrag);
    card.element.addEventListener('lostpointercapture', () => { if (drag && !drag.finishing) cancelDrag(); });
  }

  function startDrag(event) {
    const card = cards.get(drag.key);
    drag.active = true;
    card.element.classList.add('page-card--dragging');
    const preview = card.canvas ? cloneCanvas(card.canvas) : h('div', { class: 'page-card__placeholder' });
    drag.ghost = h('div', { class: 'drag-ghost', 'aria-hidden': 'true' }, preview, h('div', { class: 'drag-ghost__label', text: card.title.textContent }));
    document.body.append(drag.ghost);
    moveGhost(event);
  }

  function cloneCanvas(source) {
    const copy = document.createElement('canvas');
    copy.width = source.width;
    copy.height = source.height;
    copy.getContext('2d').drawImage(source, 0, 0);
    return copy;
  }

  function moveGhost(event) {
    drag.ghost.style.left = `${event.clientX}px`;
    drag.ghost.style.top = `${event.clientY}px`;
  }

  function clearIndicator() {
    if (drag?.indicator) drag.indicator.classList.remove('page-card--drop-before', 'page-card--drop-after');
    if (drag) drag.indicator = null;
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD) return;
      startDrag(event);
    }
    event.preventDefault();
    moveGhost(event);
    autoScroll(event.clientY);
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.page-card');
    clearIndicator();
    if (!target || !list.contains(target) || target.dataset.key === drag.key) {
      drag.dropIndex = null;
      return;
    }
    const rect = target.getBoundingClientRect();
    const after = event.clientX > rect.left + rect.width / 2;
    target.classList.add(after ? 'page-card--drop-after' : 'page-card--drop-before');
    drag.indicator = target;
    drag.dropIndex = indexOfKey(target.dataset.key) + (after ? 1 : 0);
  }

  function autoScroll(y) {
    if (y < AUTOSCROLL_EDGE + 56) window.scrollBy(0, -12);
    else if (y > window.innerHeight - AUTOSCROLL_EDGE) window.scrollBy(0, 12);
  }

  function onPointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { active, key, dropIndex } = drag;
    drag.finishing = true;
    if (active) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      const from = indexOfKey(key);
      if (dropIndex !== null && dropIndex !== undefined) {
        const to = dropIndex > from ? dropIndex - 1 : dropIndex;
        if (to !== from) onMove(from, to, key);
      }
    }
    cancelDrag();
  }

  function cancelDrag() {
    if (!drag) return;
    clearIndicator();
    drag.ghost?.remove();
    cards.get(drag.key)?.element.classList.remove('page-card--dragging');
    if (drag.element.hasPointerCapture?.(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
    drag = null;
  }

  if (interactive) list.addEventListener('keydown', onKeyDown);

  return {
    element: list,
    update,
    focusPage,
    get focusedKey() { return focusedKey; },
    setPreviewFailed() {
      previewFailed = true;
      for (const card of cards.values()) {
        card.renderedKey = null;
        requestRender(card);
      }
    },
    destroy() {
      destroyed = true;
      cancelDrag();
      observer.disconnect();
      for (const card of cards.values()) {
        card.controller?.abort();
        releaseCanvas(card);
      }
      cards.clear();
      rendered.clear();
      pixelsInUse = 0;
    },
  };
}
