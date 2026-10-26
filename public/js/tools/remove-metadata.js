// Remove metadata: strips EXIF (including GPS location), XMP, IPTC and other
// hidden details from photos without re-encoding them, so the pictures are
// unchanged. An image with nothing to remove is handed back as it was.

import { LIMITS } from '../config.js';
import { PdfWorkerClient } from '../worker-client.js';
import { createExportManager } from '../export-manager.js';
import { sanitizeFilename } from '../core/filenames.js';
import { formatBytes, pluralize } from '../core/format.js';
import { IMAGE_ACCEPT, extensionForType, imageTypeOf } from '../core/image-compress.js';
import { METADATA_LABELS, canStripMetadata } from '../core/image-metadata.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { createDropZone } from '../ui/drop-zone.js';
import { createResultPanel } from '../ui/result-panel.js';
import { announce, toast } from '../ui/notifications.js';
import { createToolHeader, createStatusArea, createActionBar, alertBox, toolById } from './tool-shell.js';

const isCancelled = (error) => error?.code === 'cancelled';

function originalExtension(entry) {
  return /\.[a-z0-9]{1,5}$/i.exec(entry.name)?.[0] ?? extensionForType(entry.type);
}

export function mount({ container, initialFiles = [] }) {
  const tool = toolById('remove-metadata');
  const header = createToolHeader(tool);
  const client = new PdfWorkerClient(new URL('../workers/image-worker.js', import.meta.url), { name: 'foldr-images' });

  let entries = [];
  let exportManager = null;
  let hasResult = false;
  let downloaded = true;
  let nextId = 1;

  const dropZone = createDropZone({
    multiple: true,
    accept: IMAGE_ACCEPT,
    title: 'Choose photos',
    hint: 'or drag and drop them here. JPEG, PNG and WebP.',
    buttonLabel: 'Select photos',
    onFiles: (list) => onFiles(list),
  });
  const listSlot = h('div');
  const explainer = alertBox({
    tone: 'info',
    message: 'Removes camera details, dates, GPS location, captions, editing history and comments. The pictures aren’t re-encoded, so they look exactly the same. Colour profiles and the photo’s orientation are kept, so colours and rotation don’t change.',
  });

  const actionBar = createActionBar({ label: 'Remove metadata', icon: 'eraser', onClick: runStrip });
  const status = createStatusArea({ client, onBusyChange: render });
  const inputSection = h('section', { class: 'tool-section' }, dropZone.element, listSlot, explainer, actionBar.element);
  container.append(h('div', { class: 'tool' }, header.element, inputSection, status.element));

  // ---- Choosing images -------------------------------------------------------

  function onFiles(list) {
    if (status.busy) return;
    if (hasResult) backToOptions();
    const files = [...list];
    const images = files.filter(canStripMetadata);
    if (images.length < files.length) {
      const heic = files.some((file) => ['image/heic', 'image/heif'].includes(imageTypeOf(file)));
      const message = heic
        ? 'Metadata can be removed from JPEG, PNG and WebP images. For HEIC photos, use Compress Images and convert them to JPEG, which drops their metadata.'
        : 'Metadata can be removed from JPEG, PNG and WebP images only.';
      toast(images.length ? `${message} The other files were skipped.` : message, { type: images.length ? 'info' : 'error' });
    }
    const room = LIMITS.maxFiles - entries.length;
    if (images.length > room) {
      toast(`Foldr can clean up to ${LIMITS.maxFiles} images at once, so ${pluralize(images.length - Math.max(0, room), 'image')} weren’t added.`, { type: 'error' });
    }
    const added = images.slice(0, Math.max(0, room)).map((file) => ({
      id: `m${nextId++}`,
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
    dropZone.setDisabled(busy);
    listSlot.replaceChildren(renderList(busy));
    actionBar.element.hidden = count === 0;
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    actionBar.update({
      enabled: count > 0 && !busy,
      text: count ? `${pluralize(count, 'image')} · ${formatBytes(total)}` : '',
    });
  }

  // ---- Removing metadata -------------------------------------------------------

  async function runStrip() {
    const list = entries.slice();
    if (!list.length) return;
    await status.run({
      phases: ['process', 'download'],
      task: async (onProgress) => {
        const results = [];
        for (const [index, entry] of list.entries()) {
          onProgress({ phase: 'process', label: `Cleaning image ${index + 1} of ${list.length}`, done: index, total: list.length });
          try {
            results.push({ entry, outcome: await client.request('stripMetadata', { blob: entry.file }) });
          } catch (error) {
            if (isCancelled(error)) throw error;
            results.push({ entry, error: error?.code ? error.message : 'Metadata couldn’t be removed from this image.' });
          }
        }
        onProgress({ phase: 'process', label: 'Cleaning images', done: list.length, total: list.length });
        return results;
      },
      onSuccess: showResult,
    });
  }

  function outputFor(manager, { entry, outcome }) {
    const extension = originalExtension(entry);
    const cleaned = outcome.removed.length > 0;
    const blob = cleaned ? outcome.blob : entry.file;
    const found = outcome.removed.map((key) => METADATA_LABELS[key]).join(', ');
    return manager.createOutput({
      blob,
      name: sanitizeFilename(entry.name, { extension }),
      extension,
      extra: {
        cleaned,
        location: outcome.removed.includes('location'),
        originalSize: entry.size,
        meta: cleaned
          ? `Removed: ${found} · ${formatBytes(entry.size)} → ${formatBytes(blob.size)}`
          : `${formatBytes(entry.size)} · No metadata found, kept as it was`,
      },
    });
  }

  function showResult(results) {
    exportManager?.dispose();
    exportManager = createExportManager();
    const succeeded = results.filter((result) => result.outcome);
    const failed = results.filter((result) => result.error);
    const outputs = succeeded.map((result) => outputFor(exportManager, result));
    const cleanedCount = outputs.filter((output) => output.cleaned).length;
    const locationCount = outputs.filter((output) => output.location).length;
    const before = outputs.reduce((sum, output) => sum + output.originalSize, 0);
    const after = outputs.reduce((sum, output) => sum + output.size, 0);
    hasResult = true;
    // If nothing was removed, there's nothing new to lose by leaving.
    downloaded = cleanedCount === 0;

    const failures = failed.length > 0 && alertBox({
      tone: outputs.length ? 'warning' : 'error',
      title: `Metadata couldn’t be removed from ${pluralize(failed.length, 'image')}`,
      message: failed.map(({ entry, error }) => `${entry.name}: ${error}`).join(' '),
    });
    const backButton = h('button', { type: 'button', class: 'btn btn--ghost', onClick: backToOptions }, icon('back'), 'Back to images');
    inputSection.hidden = true;

    if (!outputs.length) {
      status.show(h('section', { class: 'panel stack' }, failures, h('div', { class: 'cluster' }, backButton)));
      announce('No images could be cleaned.');
      return;
    }

    const content = h('div', { class: 'stack' },
      locationCount > 0 && alertBox({
        tone: 'success',
        message: `GPS location was removed from ${pluralize(locationCount, 'image')}. Share the downloaded ${locationCount === 1 ? 'copy' : 'copies'}, not the original${locationCount === 1 ? '' : 's'}.`,
      }),
      cleanedCount > 0 && cleanedCount < outputs.length && alertBox({
        tone: 'info',
        message: `${pluralize(outputs.length - cleanedCount, 'image')} had no metadata, so ${outputs.length - cleanedCount === 1 ? 'it was' : 'they were'} kept exactly as ${outputs.length - cleanedCount === 1 ? 'it was' : 'they were'}.`,
      }),
      failures,
    );

    const title = cleanedCount ? `Metadata removed from ${pluralize(cleanedCount, 'image')}` : 'No metadata found';
    const panel = createResultPanel({
      title,
      subtitle: `${pluralize(outputs.length, 'image')} · ${formatBytes(before)} → ${formatBytes(after)}`,
      outputs,
      exportManager,
      zipName: 'images-without-metadata',
      tone: cleanedCount ? 'success' : 'warning',
      content,
      onStartOver: startOver,
      startOverLabel: 'Clean other images',
      onDownloaded: () => { downloaded = true; },
    });
    panel.element.lastElementChild.prepend(backButton);
    status.show(panel.element);
    panel.focus();
    announce(title);
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
