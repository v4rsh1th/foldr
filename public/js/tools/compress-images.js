// Compress images: re-encodes photos and images at a chosen quality, can
// scale them down and convert them to JPEG or WebP. Each image is handled
// on its own; one that wouldn't get smaller is kept exactly as it was, so
// the result is never larger than the original.

import { LIMITS } from '../config.js';
import { PdfWorkerClient } from '../worker-client.js';
import { createExportManager } from '../export-manager.js';
import { sanitizeFilename } from '../core/filenames.js';
import { describeSizeChange, formatBytes, pluralize } from '../core/format.js';
import {
  IMAGE_ACCEPT, IMAGE_MAX_SIDES, compressedImageName, extensionForType, imageTypeOf, isCompressibleImage,
} from '../core/image-compress.js';
import { h, uid } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { createDropZone } from '../ui/drop-zone.js';
import { createResultPanel } from '../ui/result-panel.js';
import { announce, toast } from '../ui/notifications.js';
import { createToolHeader, createStatusArea, createActionBar, alertBox, toolById } from './tool-shell.js';

const LEVELS = [
  { id: 'light', title: 'Light', description: 'Hardly any visible change. Saves the least space.' },
  { id: 'balanced', title: 'Balanced', description: 'Looks the same at normal viewing sizes. Good for sharing, email and the web.' },
  { id: 'strong', title: 'Strong', description: 'The smallest files. Fine detail may look soft or blocky up close.' },
];

const SIZES = IMAGE_MAX_SIDES.map((side) => ({
  id: String(side),
  label: side ? `Up to ${side} px${{ 3840: ' (4K)', 1920: ' (Full HD)' }[side] ?? ''}` : 'Keep original dimensions',
}));

const FORMATS = [
  { id: 'keep', label: 'Same as original' },
  { id: 'jpeg', label: 'JPEG (works everywhere)' },
  { id: 'webp', label: 'WebP (smaller, modern browsers and apps)' },
];

const isCancelled = (error) => error?.code === 'cancelled';

function originalExtension(entry) {
  return /\.[a-z0-9]{1,5}$/i.exec(entry.name)?.[0] ?? extensionForType(entry.type);
}

const dimensions = (width, height) => `${width} × ${height}`;

export function mount({ container, initialFiles = [] }) {
  const tool = toolById('compress-images');
  const header = createToolHeader(tool);
  const client = new PdfWorkerClient(new URL('../workers/image-worker.js', import.meta.url), { name: 'foldr-images' });
  const supported = typeof OffscreenCanvas === 'function' && typeof OffscreenCanvas.prototype.convertToBlob === 'function';

  let entries = [];
  let level = 'balanced';
  let maxSide = '0';
  let format = 'keep';
  let webp = true;
  let exportManager = null;
  let hasResult = false;
  let downloaded = true;
  let nextId = 1;

  const notice = h('div', { class: 'stack' });
  const dropZone = createDropZone({
    multiple: true,
    accept: IMAGE_ACCEPT,
    title: 'Choose images',
    hint: 'or drag and drop them here. JPEG, PNG, WebP and other photos.',
    buttonLabel: 'Select images',
    onFiles: (list) => onFiles(list),
  });
  const listSlot = h('div');

  const levelName = uid('image-level');
  const levelInputs = LEVELS.map((option) => h('input', { type: 'radio', name: levelName, value: option.id, checked: option.id === level }));
  const levelGroup = h('fieldset', { class: 'choice-group' },
    h('legend', { text: 'Compression level' }),
    LEVELS.map((option, index) => h('label', { class: 'choice' },
      levelInputs[index],
      h('span', { class: 'choice__title', text: option.title }),
      h('span', { class: 'choice__desc', text: option.description }),
    )),
  );
  levelGroup.addEventListener('change', (event) => {
    level = event.target.value;
    render();
  });
  const select = (label, options, value, onChange) => {
    const id = uid('image-select');
    const element = h('select', { id, class: 'input', onChange: (event) => { onChange(event.target.value); render(); } },
      options.map((option) => h('option', { value: option.id, text: option.label, selected: option.id === value })));
    return { element, field: h('div', { class: 'field' }, h('label', { class: 'field__label', for: id, text: label }), element) };
  };
  const sizeSelect = select('Dimensions', SIZES, maxSide, (value) => { maxSide = value; });
  const formatSelect = select('Format', FORMATS, format, (value) => { format = value; });
  const optionNotice = h('div', { class: 'stack' });
  const options = h('section', { class: 'panel stack', 'aria-label': 'Compression options' },
    levelGroup,
    h('div', { class: 'option-fields' }, sizeSelect.field, formatSelect.field),
    optionNotice,
  );

  const actionBar = createActionBar({ label: 'Compress images', icon: 'compress', onClick: runCompress });
  const status = createStatusArea({ client, onBusyChange: render });
  const inputSection = h('section', { class: 'tool-section' }, notice, dropZone.element, listSlot, options, actionBar.element);
  container.append(h('div', { class: 'tool' }, header.element, inputSection, status.element));

  client.request('capabilities').then((caps) => {
    webp = caps.webp;
    render();
  }).catch(() => {});

  // ---- Choosing images -------------------------------------------------------

  function onFiles(list) {
    if (status.busy) return;
    if (hasResult) backToOptions();
    const files = [...list];
    const images = files.filter(isCompressibleImage);
    if (images.length < files.length) {
      toast(images.length
        ? 'Only photos and images can be compressed here (not GIFs or SVGs), so the other files were skipped.'
        : 'Choose JPEG, PNG or WebP images. To make a PDF smaller, use Compress PDF.', { type: images.length ? 'info' : 'error' });
    }
    const room = LIMITS.maxFiles - entries.length;
    if (images.length > room) {
      toast(`Foldr can compress up to ${LIMITS.maxFiles} images at once, so ${pluralize(images.length - Math.max(0, room), 'image')} weren’t added.`, { type: 'error' });
    }
    const added = images.slice(0, Math.max(0, room)).map((file) => ({
      id: `i${nextId++}`,
      file,
      name: file.name || 'image',
      size: file.size,
      type: imageTypeOf(file),
      thumbUrl: URL.createObjectURL(file),
    }));
    if (!added.length) return;
    entries.push(...added);
    render();
  }

  function remove(id) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) return;
    URL.revokeObjectURL(entry.thumbUrl);
    entries = entries.filter((item) => item !== entry);
    render();
  }

  function clearEntries() {
    entries.forEach((entry) => URL.revokeObjectURL(entry.thumbUrl));
    entries = [];
  }

  function renderList(disabled) {
    if (!entries.length) return '';
    return h('ol', { class: 'file-list', 'aria-label': 'Selected images' },
      entries.map((entry) => {
        const nameId = `${entry.id}-name`;
        return h('li', { class: 'file-item' },
          h('img', { class: 'file-item__thumb', src: entry.thumbUrl, alt: '', loading: 'lazy', decoding: 'async' }),
          h('div', { class: 'file-item__body' },
            h('p', { class: 'file-item__name', id: nameId, title: entry.name, text: entry.name }),
            h('p', { class: 'file-item__meta' }, h('span', { text: formatBytes(entry.size) })),
          ),
          h('div', { class: 'file-item__actions' },
            h('button', { type: 'button', class: 'icon-btn icon-btn--danger', 'aria-label': 'Remove image', title: 'Remove', 'aria-describedby': nameId, disabled, onClick: () => remove(entry.id) }, icon('trash')),
          ),
        );
      }));
  }

  function render() {
    const busy = status.busy;
    const count = entries.length;
    dropZone.setCompact(count > 0);
    dropZone.setDisabled(busy || !supported);
    listSlot.replaceChildren(renderList(busy));
    options.hidden = count === 0;
    for (const input of levelInputs) input.disabled = busy;
    sizeSelect.element.disabled = busy;
    formatSelect.element.disabled = busy;
    formatSelect.element.querySelector('option[value="webp"]').disabled = !webp;
    if (format === 'webp' && !webp) {
      format = 'keep';
      formatSelect.element.value = format;
    }

    const notices = [];
    const pngOnly = format === 'keep' && maxSide === '0' && entries.some((entry) => entry.type === 'image/png');
    if (pngOnly) {
      notices.push(alertBox({ tone: 'info', message: 'PNG is a lossless format, so the compression level doesn’t change PNG images. To make them smaller, convert them to WebP or JPEG, or reduce their dimensions.' }));
    }
    if (format === 'jpeg' && entries.some((entry) => entry.type !== 'image/jpeg')) {
      notices.push(alertBox({ tone: 'info', message: 'JPEG doesn’t support transparency, so transparent areas will become white.' }));
    }
    if (!webp) notices.push(alertBox({ tone: 'info', message: 'This browser can’t create WebP images, so that format isn’t available.' }));
    optionNotice.replaceChildren(...notices);

    actionBar.element.hidden = count === 0;
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    actionBar.update({
      enabled: count > 0 && !busy && supported,
      text: count ? `${pluralize(count, 'image')} · ${formatBytes(total)}` : '',
      buttonLabel: count === 1 ? 'Compress image' : 'Compress images',
    });
  }

  // ---- Compressing ---------------------------------------------------------------

  async function runCompress() {
    const list = entries.slice();
    if (!list.length) return;
    const chosen = { level, maxSide: Number(maxSide), format };
    await status.run({
      phases: ['process', 'download'],
      task: async (onProgress) => {
        const results = [];
        for (const [index, entry] of list.entries()) {
          onProgress({ phase: 'process', label: `Compressing image ${index + 1} of ${list.length}`, done: index, total: list.length });
          try {
            const outcome = await client.request('compress', { blob: entry.file, inputType: entry.type, ...chosen });
            results.push({ entry, outcome });
          } catch (error) {
            if (isCancelled(error)) throw error;
            results.push({ entry, error: error?.code ? error.message : 'This image couldn’t be compressed.' });
          }
        }
        onProgress({ phase: 'process', label: 'Compressing images', done: list.length, total: list.length });
        return results;
      },
      onSuccess: (results) => showResult(results, chosen.format),
    });
  }

  function outputFor(manager, { entry, outcome }) {
    const { kept, width, height, sourceWidth, sourceHeight } = outcome;
    if (kept) {
      const extension = originalExtension(entry);
      return manager.createOutput({
        blob: entry.file,
        name: sanitizeFilename(entry.name, { extension }),
        extension,
        extra: { kept, originalSize: entry.size, meta: `${dimensions(width, height)} · ${formatBytes(entry.size)} · Already compact, kept as it was` },
      });
    }
    const extension = extensionForType(outcome.type);
    const resized = width !== sourceWidth || height !== sourceHeight;
    const change = describeSizeChange(entry.size, outcome.blob.size);
    return manager.createOutput({
      blob: outcome.blob,
      name: sanitizeFilename(compressedImageName(entry.name, outcome.type), { extension }),
      extension,
      extra: {
        kept,
        originalSize: entry.size,
        meta: [
          resized ? `${dimensions(sourceWidth, sourceHeight)} → ${dimensions(width, height)}` : dimensions(width, height),
          `${formatBytes(entry.size)} → ${formatBytes(outcome.blob.size)} (${change.label})`,
        ].join(' · '),
      },
    });
  }

  function showResult(results, chosenFormat) {
    exportManager?.dispose();
    exportManager = createExportManager();
    const succeeded = results.filter((result) => result.outcome);
    const failed = results.filter((result) => result.error);
    const outputs = succeeded.map((result) => outputFor(exportManager, result));
    const before = outputs.reduce((sum, output) => sum + output.originalSize, 0);
    const after = outputs.reduce((sum, output) => sum + output.size, 0);
    const change = describeSizeChange(before, after);
    const smaller = change.direction === 'smaller';
    const larger = change.direction === 'larger';
    const keptCount = outputs.filter((output) => output.kept).length;
    const formatName = { jpeg: 'JPEG', webp: 'WebP' }[chosenFormat];
    hasResult = true;
    // If every image was kept as it was, there's nothing new to lose by leaving.
    downloaded = keptCount === outputs.length;

    const failures = failed.length > 0 && alertBox({
      tone: outputs.length ? 'warning' : 'error',
      title: `${pluralize(failed.length, 'image')} couldn’t be compressed`,
      message: failed.map(({ entry, error }) => `${entry.name}: ${error}`).join(' '),
    });
    const backButton = h('button', { type: 'button', class: 'btn btn--ghost', onClick: backToOptions }, icon('back'), 'Try other settings');
    inputSection.hidden = true;

    if (!outputs.length) {
      status.show(h('section', { class: 'panel stack' }, failures, h('div', { class: 'cluster' }, backButton)));
      announce('No images could be compressed.');
      return;
    }

    const stat = (label, value, tone) => h('div', { class: 'stat' },
      h('p', { class: 'stat__label', text: label }),
      h('p', { class: `stat__value${tone ? ` stat__value--${tone}` : ''}`, text: value }));
    const content = h('div', { class: 'stack' },
      h('div', { class: 'stats' },
        stat('Original', formatBytes(before)),
        stat('Result', formatBytes(after)),
        stat(smaller ? 'Saved' : 'Change', change.direction === 'same' ? 'No change' : `${smaller ? '−' : '+'}${formatBytes(change.absoluteDelta)} (${change.label})`, smaller ? 'good' : 'bad'),
      ),
      larger && formatName && alertBox({
        tone: 'warning',
        message: `${formatName} stores these images less efficiently than their original format, so the result is larger. Choose “Same as original” to keep any image that wouldn’t get smaller.`,
      }),
      keptCount > 0 && alertBox({
        tone: smaller ? 'info' : 'warning',
        message: `${pluralize(keptCount, 'image')} wouldn’t get any smaller with these settings, so ${keptCount === 1 ? 'it was' : 'they were'} kept exactly as ${keptCount === 1 ? 'it was' : 'they were'}.${smaller ? '' : ' Try a stronger level, smaller dimensions or WebP.'}`,
      }),
      failures,
    );

    let title = 'These images couldn’t be made smaller';
    if (smaller) title = `Reduced by ${change.label.replace('−', '')}`;
    else if (larger && formatName) title = `Converted to ${formatName}`;
    const panel = createResultPanel({
      title,
      subtitle: `${pluralize(outputs.length, 'image')} · ${formatBytes(before)} → ${formatBytes(after)}`,
      outputs,
      exportManager,
      zipName: 'compressed-images',
      tone: smaller ? 'success' : 'warning',
      content,
      onStartOver: startOver,
      startOverLabel: 'Compress other images',
      onDownloaded: () => { downloaded = true; },
    });
    panel.element.lastElementChild.prepend(backButton);
    status.show(panel.element);
    panel.focus();
    announce(smaller ? `Compressed: ${change.label}` : title);
  }

  function backToOptions() {
    exportManager?.dispose();
    exportManager = null;
    hasResult = false;
    downloaded = true;
    status.clear();
    inputSection.hidden = false;
    render();
  }

  function startOver() {
    backToOptions();
    clearEntries();
    render();
  }

  if (!supported) {
    notice.replaceChildren(alertBox({ tone: 'error', title: 'Image compression isn’t supported in this browser', message: 'Update your browser, or use a recent version of Chrome, Edge, Firefox or Safari.' }));
  }
  render();
  if (initialFiles.length) onFiles(initialFiles);

  return {
    focus: header.focus,
    onFiles,
    isDirty: () => status.busy || (hasResult && !downloaded),
    unmount() {
      client.cancel();
      exportManager?.dispose();
      clearEntries();
    },
  };
}
