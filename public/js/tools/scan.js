// Scan document: photograph pages with the camera (or import photos), and
// Foldr finds each page's edges, straightens it, removes shadows and
// sharpens the text, then makes a PDF to download or share.
//
// Photos stay as captured. Previews are rendered from a smaller working
// copy; the PDF is rendered from the full-resolution photos only when it's
// made, so changing the filter or the crop is instant and lossless.

import { SCAN } from '../config.js';
import { PdfWorkerClient } from '../worker-client.js';
import { createExportManager } from '../export-manager.js';
import { defaultOutputName } from '../core/filenames.js';
import { formatBytes, pluralize } from '../core/format.js';
import { FULL_QUAD } from '../core/scan-geometry.js';
import { h, uid } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { createResultPanel } from '../ui/result-panel.js';
import { announce, toast } from '../ui/notifications.js';
import { cameraSupported, openCamera } from '../ui/camera.js';
import { editCrop } from '../ui/crop-editor.js';
import { createToolHeader, createStatusArea, createActionBar, alertBox, toolById } from './tool-shell.js';

const FILTERS = [
  { id: 'auto', title: 'Document', description: 'Removes shadows, whitens the paper and sharpens text. Keeps colour.' },
  { id: 'bw', title: 'Black & white', description: 'The crispest text and the smallest file. Best for printed pages and forms.' },
  { id: 'gray', title: 'Greyscale', description: 'Evenly lit, without colour. Good for pencil, handwriting and pictures.' },
  { id: 'original', title: 'Original', description: 'Cropped and straightened only, with no clean-up.' },
];

const PAGE_SIZES = [
  { id: 'auto', label: 'Fit to page (same shape as the scan)' },
  { id: 'a4', label: 'A4' },
  { id: 'letter', label: 'US Letter' },
];

const QUALITIES = [
  { id: 'high', label: 'High (300 ppi)' },
  { id: 'standard', label: 'Standard (200 ppi, smaller file)' },
];

// A4's long side, in inches: the longest edge any page is rendered for.
const LONG_EDGE_INCHES = 11.69;

export const IMAGE_ACCEPT = 'image/*';

const isImage = (file) => file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test(file.name);

function pickImages({ capture = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: IMAGE_ACCEPT, multiple: !capture, class: 'visually-hidden', tabIndex: -1, 'aria-hidden': 'true' });
    if (capture) input.setAttribute('capture', 'environment');
    const done = (files) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done([...input.files]), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    document.body.append(input);
    input.click();
  });
}

function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

const isCancelled = (error) => error?.code === 'cancelled';

export function mount({ container, client, initialFiles = [] }) {
  const tool = toolById('scan');
  const header = createToolHeader(tool);
  // One worker for previews, another for the final render, so cancelling
  // the PDF never interrupts previews.
  const imageClient = new PdfWorkerClient(new URL('../workers/scan-worker.js', import.meta.url), { name: 'foldr-scan' });
  const exportClient = new PdfWorkerClient(new URL('../workers/scan-worker.js', import.meta.url), { name: 'foldr-scan-export' });
  const supported = typeof OffscreenCanvas === 'function' && typeof OffscreenCanvas.prototype.convertToBlob === 'function';

  let pages = [];
  let filter = 'auto';
  let pageSize = 'auto';
  let quality = 'high';
  let exportManager = null;
  let hasResult = false;
  let saved = true;
  let disposed = false;
  let nextId = 1;
  let prepareChain = Promise.resolve();
  let previewsRunning = false;

  // ---- Capture -------------------------------------------------------------

  const notice = h('div', { class: 'stack' });
  const cameraButton = h('button', { type: 'button', class: 'btn btn--primary btn--large', onClick: startCamera }, icon('camera'), h('span', { text: cameraSupported() ? 'Open camera' : 'Take photo' }));
  const importButton = h('button', { type: 'button', class: 'btn btn--secondary btn--large', onClick: importPhotos }, icon('image'), h('span', { text: 'Import photos' }));
  const captureTitle = h('p', { class: 'drop-zone__title' });
  const captureHint = h('p', { class: 'drop-zone__hint' });
  const capture = h('section', { class: 'drop-zone scan-capture', 'aria-label': 'Add pages' },
    h('div', { class: 'drop-zone__icon' }, icon('scan')),
    h('div', {}, captureTitle, captureHint),
    h('div', { class: 'cluster scan-capture__buttons' }, cameraButton, importButton),
  );

  // ---- Pages ---------------------------------------------------------------

  const grid = h('ol', { class: 'scan-grid', 'aria-label': 'Scanned pages' });
  const pagesSection = h('section', { class: 'stack', 'aria-labelledby': uid('scan-pages') });
  const pagesHeading = h('h2', { id: pagesSection.getAttribute('aria-labelledby'), class: 'tool-section__title' });
  pagesSection.append(pagesHeading, grid);

  // ---- Options -------------------------------------------------------------

  const filterName = uid('scan-filter');
  const filterInputs = FILTERS.map((option) => h('input', { type: 'radio', name: filterName, value: option.id, checked: option.id === filter }));
  const filterGroup = h('fieldset', { class: 'choice-group scan-filters' },
    h('legend', { text: 'Look' }),
    FILTERS.map((option, index) => h('label', { class: 'choice' },
      filterInputs[index],
      h('span', { class: 'choice__title', text: option.title }),
      h('span', { class: 'choice__desc', text: option.description }),
    )),
  );
  filterGroup.addEventListener('change', (event) => {
    filter = event.target.value;
    saved = !pages.length;
    renderPages();
    pumpPreviews();
  });
  const select = (label, options, value, onChange) => {
    const id = uid('scan-select');
    const element = h('select', { id, class: 'input', onChange: (event) => onChange(event.target.value) },
      options.map((option) => h('option', { value: option.id, text: option.label, selected: option.id === value })));
    return { element, field: h('div', { class: 'field' }, h('label', { class: 'field__label', for: id, text: label }), element) };
  };
  const sizeSelect = select('Page size', PAGE_SIZES, pageSize, (value) => { pageSize = value; });
  const qualitySelect = select('Quality', QUALITIES, quality, (value) => { quality = value; });
  const options = h('section', { class: 'panel stack', 'aria-label': 'Scan options' },
    filterGroup,
    h('div', { class: 'scan-fields' }, sizeSelect.field, qualitySelect.field),
  );

  const actionBar = createActionBar({ label: 'Create PDF', icon: 'file', onClick: createPdf });
  const status = createStatusArea({
    client: { cancel: () => { exportClient.cancel(); client.cancel(); } },
    onBusyChange: () => renderPages(),
  });
  const inputSection = h('section', { class: 'tool-section' }, notice, capture, pagesSection, options, actionBar.element);
  container.append(h('div', { class: 'tool' }, header.element, inputSection, status.element));

  function render() {
    const busy = status.busy;
    const count = pages.length;
    const preparing = pages.filter((page) => page.status === 'preparing').length;
    const ready = pages.filter((page) => page.status === 'ready').length;
    capture.classList.toggle('drop-zone--compact', count > 0);
    cameraButton.classList.toggle('btn--large', count === 0);
    importButton.classList.toggle('btn--large', count === 0);
    captureTitle.textContent = count ? 'Add more pages' : 'Scan a document';
    captureHint.textContent = count
      ? 'Take more photos or import them. New pages go at the end.'
      : 'Photograph each page, or import photos you’ve already taken. Foldr finds the edges, straightens the page and makes the text crisp.';
    cameraButton.disabled = busy || !supported;
    importButton.disabled = busy || !supported;
    pagesSection.hidden = count === 0;
    pagesHeading.textContent = pluralize(count, 'page');
    options.hidden = count === 0;
    for (const input of filterInputs) input.disabled = busy;
    sizeSelect.element.disabled = busy;
    qualitySelect.element.disabled = busy;
    actionBar.element.hidden = count === 0;
    let text = '';
    if (preparing) text = `Processing ${pluralize(preparing, 'photo')}…`;
    else if (ready) text = pluralize(ready, 'page');
    actionBar.update({ enabled: ready > 0 && !preparing && !busy, text });
  }

  function renderPages() {
    grid.replaceChildren(...pages.map((page, index) => pageCard(page, index)));
    render();
  }

  function pageCard(page, index) {
    const label = `Page ${index + 1}`;
    let thumb;
    if (page.status === 'error') {
      thumb = h('div', { class: 'page-card__placeholder page-card__placeholder--error', text: page.error });
    } else if (page.previewUrl) {
      thumb = h('img', { src: page.previewUrl, alt: `${label} preview`, class: page.previewKey === previewKeyOf(page) ? '' : 'scan-card__stale' });
    } else {
      thumb = h('div', { class: 'page-card__placeholder', role: 'img', 'aria-label': `${label}, processing` });
    }
    const usable = page.status === 'ready';
    const action = (iconName, text, onClick, disabled = false) => h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': `${text} (${label})`, title: text, disabled: disabled || status.busy, onClick,
    }, icon(iconName));
    return h('li', { class: 'scan-card', dataset: { pageId: page.id } },
      h('button', { type: 'button', class: 'scan-card__thumb', 'aria-label': `Adjust corners of ${label}`, disabled: !usable, onClick: () => adjust(page) }, thumb),
      h('div', { class: 'scan-card__footer' },
        h('span', { class: 'page-card__label', text: label }),
        usable && !page.detected && h('span', { class: 'scan-card__badge', text: 'Check crop' }),
      ),
      h('div', { class: 'scan-card__actions' },
        action('crop', 'Adjust corners', () => adjust(page), !usable),
        action('rotateCw', 'Rotate clockwise', () => rotate(page), !usable),
        action('arrowLeft', 'Move earlier', () => move(page, -1), index === 0),
        action('arrowRight', 'Move later', () => move(page, 1), index === pages.length - 1),
        action('trash', 'Delete page', () => remove(page)),
      ),
    );
  }

  function focusCardButton(page, label) {
    grid.querySelector(`[data-page-id="${page.id}"] [title="${label}"]`)?.focus();
  }

  // ---- Adding pages --------------------------------------------------------

  function addImages(files) {
    if (status.busy || disposed) return;
    if (hasResult) backToPages();
    const images = files.filter(isImage);
    if (images.length < files.length) {
      toast(images.length ? 'Only photos can be scanned, so the other files were skipped.' : 'Only photos (JPEG, PNG, WebP) can be scanned. To work with a PDF, choose another tool.', { type: images.length ? 'info' : 'error' });
    }
    const room = SCAN.maxPages - pages.length;
    if (images.length > room) {
      toast(`A scan can have up to ${SCAN.maxPages} pages, so ${pluralize(images.length - Math.max(0, room), 'photo')} weren’t added.`, { type: 'error' });
    }
    const added = images.slice(0, Math.max(0, room)).map((file) => ({
      id: `p${nextId++}`,
      blob: file,
      proxy: null,
      proxyUrl: null,
      width: 0,
      height: 0,
      quad: FULL_QUAD,
      autoQuad: null,
      detected: false,
      rotation: 0,
      previewUrl: null,
      previewKey: null,
      status: 'preparing',
      error: '',
    }));
    if (!added.length) return;
    pages.push(...added);
    saved = false;
    notice.replaceChildren();
    renderPages();
    for (const page of added) prepareChain = prepareChain.then(() => prepare(page));
  }

  async function prepare(page) {
    if (disposed || !pages.includes(page)) return;
    try {
      const { width, height, quad, proxy } = await imageClient.request('prepare', { blob: page.blob });
      if (disposed) return;
      Object.assign(page, { width, height, proxy, proxyUrl: URL.createObjectURL(proxy), autoQuad: quad, detected: Boolean(quad), quad: quad ?? FULL_QUAD, status: 'ready' });
    } catch (error) {
      if (disposed) return;
      Object.assign(page, { status: 'error', error: isCancelled(error) ? 'Not processed' : error.message ?? 'This photo couldn’t be processed.' });
    }
    if (!pages.includes(page)) return;
    renderPages();
    pumpPreviews();
  }

  const previewKeyOf = (page) => `${filter}|${page.rotation}|${page.quad.flat().join(',')}`;

  /** Renders out-of-date previews one at a time, newest settings first. */
  async function pumpPreviews() {
    if (previewsRunning) return;
    previewsRunning = true;
    try {
      for (;;) {
        const page = pages.find((p) => p.status === 'ready' && p.previewKey !== previewKeyOf(p) && !p.previewFailed?.[previewKeyOf(p)]);
        if (!page || disposed) break;
        const key = previewKeyOf(page);
        try {
          const { blob } = await imageClient.request('preview', {
            blob: page.proxy, quad: page.quad, rotation: page.rotation, filter, maxSide: SCAN.previewSide,
          });
          if (disposed) break;
          if (page.previewUrl) URL.revokeObjectURL(page.previewUrl);
          page.previewUrl = URL.createObjectURL(blob);
          page.previewKey = key;
        } catch (error) {
          if (disposed) break;
          page.previewFailed = { [key]: true };
          if (!isCancelled(error)) console.info('Foldr: preview failed:', error?.code);
        }
        if (pages.includes(page)) {
          const card = grid.querySelector(`[data-page-id="${page.id}"]`);
          const focused = card?.contains(document.activeElement) ? document.activeElement.getAttribute('title') : null;
          card?.replaceWith(pageCard(page, pages.indexOf(page)));
          if (focused) focusCardButton(page, focused);
        }
      }
    } finally {
      previewsRunning = false;
    }
  }

  async function startCamera() {
    if (!cameraSupported()) {
      addImages(await pickImages({ capture: true }));
      return;
    }
    notice.replaceChildren();
    try {
      await openCamera({ initialCount: pages.length, onCapture: (blob) => addImages([new File([blob], `scan-${nextId}.jpg`, { type: blob.type || 'image/jpeg' })]) });
    } catch (error) {
      if (error?.code !== 'camera') throw error;
      const fallback = h('button', { type: 'button', class: 'btn btn--secondary', onClick: async () => addImages(await pickImages({ capture: true })) }, icon('camera'), 'Use the camera app');
      notice.replaceChildren(alertBox({ tone: 'warning', title: 'Camera unavailable', message: error.message, actions: [fallback] }));
      return;
    }
    if (pages.length) {
      announce(`${pluralize(pages.length, 'page')} scanned`);
      pagesHeading.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    cameraButton.focus();
  }

  async function importPhotos() {
    addImages(await pickImages());
  }

  // ---- Page actions --------------------------------------------------------

  function changed() {
    saved = false;
    renderPages();
    pumpPreviews();
  }

  async function adjust(page) {
    if (page.status !== 'ready' || status.busy) return;
    const quad = await editCrop({
      imageUrl: page.proxyUrl,
      width: page.width,
      height: page.height,
      quad: page.quad,
      autoQuad: page.autoQuad,
      pageLabel: `page ${pages.indexOf(page) + 1}`,
    });
    if (quad && pages.includes(page)) {
      page.quad = quad;
      page.detected = true;
      changed();
      announce('Corners updated');
    }
    focusCardButton(page, 'Adjust corners');
  }

  function rotate(page) {
    page.rotation = (page.rotation + 90) % 360;
    changed();
    focusCardButton(page, 'Rotate clockwise');
    announce(`Page ${pages.indexOf(page) + 1} rotated to ${page.rotation} degrees`);
  }

  function move(page, delta) {
    const from = pages.indexOf(page);
    const to = from + delta;
    if (to < 0 || to >= pages.length) return;
    pages.splice(from, 1);
    pages.splice(to, 0, page);
    changed();
    // Keep focus on the same button unless the page reached the end it moved towards.
    const canMoveAgain = delta < 0 ? to > 0 : to < pages.length - 1;
    focusCardButton(page, canMoveAgain ? (delta < 0 ? 'Move earlier' : 'Move later') : 'Rotate clockwise');
    announce(`Moved to position ${to + 1} of ${pages.length}`);
  }

  function release(page) {
    if (page.proxyUrl) URL.revokeObjectURL(page.proxyUrl);
    if (page.previewUrl) URL.revokeObjectURL(page.previewUrl);
  }

  function remove(page) {
    const index = pages.indexOf(page);
    pages.splice(index, 1);
    release(page);
    saved = pages.length === 0;
    renderPages();
    const next = pages[Math.min(index, pages.length - 1)];
    if (next) focusCardButton(next, 'Delete page');
    else cameraButton.focus();
    announce(`Page ${index + 1} deleted`);
  }

  // ---- Making the PDF --------------------------------------------------------

  async function createPdf() {
    const list = pages.filter((page) => page.status === 'ready');
    if (!list.length) return;
    const settings = SCAN.quality[quality];
    const maxSide = Math.round(settings.ppi * LONG_EDGE_INCHES);
    const chosen = { filter, pageSize };
    const stamp = timestamp();
    await status.run({
      phases: ['process', 'write', 'verify'],
      task: async (onProgress) => {
        const rendered = [];
        for (const [index, page] of list.entries()) {
          onProgress({ phase: 'process', label: 'Enhancing pages', done: index, total: list.length });
          rendered.push(await exportClient.request('page', {
            blob: page.blob,
            quad: page.quad,
            rotation: page.rotation,
            filter: chosen.filter,
            maxSide,
            // A finer grid for black and white gives smoother letter edges.
            upscale: chosen.filter === 'bw' ? 1.5 : 1,
            jpegQuality: settings.jpegQuality,
          }));
        }
        onProgress({ phase: 'process', label: 'Enhancing pages', done: list.length, total: list.length });
        return client.request('scan', { pages: rendered, pageSize: chosen.pageSize, title: `Scan ${stamp.slice(0, 10)}` }, {
          transfer: rendered.map((page) => page.bytes),
          onProgress,
        });
      },
      onSuccess: ({ buffer, pageCount }) => showResult(buffer, pageCount, stamp),
    });
  }

  function showResult(buffer, pageCount, stamp) {
    exportManager?.dispose();
    exportManager = createExportManager();
    const output = exportManager.createOutput({ buffer, name: defaultOutputName('scan', null, stamp), pageCount });
    hasResult = true;
    const panel = createResultPanel({
      title: 'Your scan is ready',
      subtitle: `${pluralize(pageCount, 'page')} · ${formatBytes(output.size)}`,
      outputs: [output],
      exportManager,
      share: true,
      onStartOver: startOver,
      startOverLabel: 'New scan',
      onDownloaded: () => { saved = true; },
    });
    panel.element.lastElementChild.prepend(h('button', { type: 'button', class: 'btn btn--ghost', onClick: backToPages }, icon('back'), 'Back to pages'));
    inputSection.hidden = true;
    status.show(panel.element);
    panel.focus();
    announce(`Scan ready: ${pluralize(pageCount, 'page')}`);
  }

  function backToPages() {
    exportManager?.dispose();
    exportManager = null;
    hasResult = false;
    status.clear();
    inputSection.hidden = false;
    render();
  }

  function clearPages() {
    pages.forEach(release);
    pages = [];
    saved = true;
    renderPages();
  }

  function startOver() {
    backToPages();
    clearPages();
    cameraButton.focus();
  }

  if (!supported) {
    notice.replaceChildren(alertBox({ tone: 'error', title: 'Scanning isn’t supported in this browser', message: 'Update your browser, or use a recent version of Chrome, Edge, Firefox or Safari.' }));
  }
  renderPages();
  if (initialFiles.length) addImages(initialFiles);

  return {
    focus: header.focus,
    onFiles: addImages,
    isDirty: () => status.busy || (pages.length > 0 && !saved),
    unmount() {
      disposed = true;
      if (status.busy) client.cancel();
      imageClient.cancel();
      exportClient.cancel();
      exportManager?.dispose();
      clearPages();
    },
  };
}
