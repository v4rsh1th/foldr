import { createFileManager } from '../file-manager.js';
import { createExportManager } from '../export-manager.js';
import { defaultOutputName } from '../core/filenames.js';
import { describeSizeChange, formatBytes, pluralize } from '../core/format.js';
import { assessWorkload } from '../core/validation.js';
import { h, uid } from '../ui/dom.js';
import { createDropZone } from '../ui/drop-zone.js';
import { renderFileList } from '../ui/file-list.js';
import { createResultPanel } from '../ui/result-panel.js';
import { confirmDialog } from '../ui/dialogs.js';
import { announce } from '../ui/notifications.js';
import { createToolHeader, createStatusArea, createActionBar, alertBox, toolById } from './tool-shell.js';

const MODES = [
  {
    id: 'lossless',
    title: 'Lossless',
    description: 'Removes unused and duplicate data and compresses uncompressed content. No quality change. Already-optimized files may not get smaller.',
    lossy: false,
  },
  {
    id: 'balanced',
    title: 'Balanced',
    description: 'Also re-encodes photos (JPEG images) at good quality and reduces them to about 150 ppi. Text and vector graphics are untouched.',
    lossy: true,
  },
  {
    id: 'smaller',
    title: 'Smaller file',
    description: 'Stronger JPEG compression at about 100 ppi, and also converts large lossless images to JPEG. Images may look softer or blocky.',
    lossy: true,
  },
];

const SKIP_REASONS = {
  small: 'too small to be worth changing',
  'lossless-kept': 'lossless images are kept as-is in this mode',
  'no-gain': 'already efficient (re-encoding saved under 10%)',
  'unsupported-color': 'colour format not supported (e.g. CMYK)',
  'unsupported-structure': 'transparency or decoding setup that can’t be re-encoded safely',
  'unsupported-depth': 'not 8-bit images',
  'unsupported-filter': 'image format not supported for re-encoding',
  mask: 'image masks',
  invalid: 'invalid image data',
};

function describeWork(stats) {
  const lines = [];
  const images = stats.images;
  if (images) {
    lines.push(`${pluralize(images.recompressed, 'image')} re-encoded${images.downsampled ? ` (${images.downsampled} downsampled)` : ''}, saving ${formatBytes(images.savedBytes)} of image data.`);
    for (const [reason, count] of Object.entries(images.skipped)) {
      lines.push(`${pluralize(count, 'image')} left unchanged: ${SKIP_REASONS[reason] ?? reason}.`);
    }
    if (images.failed) lines.push(`${pluralize(images.failed, 'image')} couldn’t be decoded by this browser and were left unchanged.`);
  }
  lines.push(`${pluralize(stats.removedObjects, 'unused object')} removed.`);
  if (stats.mergedDuplicates) lines.push(`${pluralize(stats.mergedDuplicates, 'duplicate resource')} merged.`);
  lines.push(`${pluralize(stats.compressedStreams, 'uncompressed stream')} compressed.`);
  return lines;
}

export function mount({ container, client, initialFiles = [] }) {
  const tool = toolById('compress');
  const header = createToolHeader(tool);
  let mode = 'lossless';
  let capabilities = { lossyCompression: true };
  let exportManager = null;
  let hasResult = false;
  let downloaded = true;

  const files = createFileManager({ client, multiple: false, onChange: render });
  const dropZone = createDropZone({ multiple: false, onFiles: (list) => onFiles(list) });
  const listSlot = h('div');
  const actionBar = createActionBar({ label: 'Compress PDF', icon: 'compress', onClick: runCompress });
  const status = createStatusArea({ client, onBusyChange: render });

  const name = uid('compress-mode');
  const inputs = MODES.map((option) => h('input', { type: 'radio', name, value: option.id, checked: option.id === mode }));
  const modeGroup = h('fieldset', { class: 'choice-group' },
    h('legend', { text: 'Compression level' }),
    MODES.map((option, index) => h('label', { class: 'choice' },
      inputs[index],
      h('span', { class: 'choice__title', text: option.title }),
      h('span', { class: 'choice__desc', text: option.description }),
    )),
  );
  modeGroup.addEventListener('change', (event) => {
    mode = event.target.value;
    render();
  });
  const modeNotice = h('div', { class: 'stack' });
  const options = h('section', { class: 'panel stack', 'aria-label': 'Compression options' }, modeGroup, modeNotice);
  const inputSection = h('section', { class: 'tool-section' }, dropZone.element, listSlot, options, actionBar.element);
  container.append(h('div', { class: 'tool' }, header.element, inputSection, status.element));

  client.request('capabilities').then((caps) => {
    capabilities = caps;
    render();
  }).catch(() => {});

  function onFiles(list) {
    if (status.busy) return;
    if (hasResult) backToOptions();
    files.add(list);
  }

  function render() {
    const busy = status.busy;
    const entry = files.entries[0];
    const ready = files.readyEntries[0];
    dropZone.element.hidden = Boolean(entry);
    listSlot.replaceChildren(entry
      ? renderFileList(files.entries, { disabled: busy, onRemove: (id) => files.remove(id), onReplace: (id, f) => files.replace(id, f), onRetry: (id) => files.retry(id) })
      : '');
    options.hidden = !ready;
    if (MODES.find((m) => m.id === mode).lossy && !capabilities.lossyCompression) {
      mode = 'lossless';
      inputs[0].checked = true;
    }
    MODES.forEach((option, index) => {
      inputs[index].disabled = busy || (option.lossy && !capabilities.lossyCompression);
    });
    const notices = [];
    if (!capabilities.lossyCompression) {
      notices.push(alertBox({ tone: 'info', message: 'This browser can’t re-encode images in the background, so only lossless optimization is available.' }));
    }
    if (mode === 'smaller') {
      notices.push(alertBox({ tone: 'warning', title: 'Visible quality loss is likely', message: 'Photos and scanned pages will look softer, and screenshots or diagrams stored as images may show artifacts. Your original file is not changed.' }));
    }
    modeNotice.replaceChildren(...notices);
    actionBar.element.hidden = !ready;
    actionBar.update({ enabled: Boolean(ready) && !busy, text: ready ? `Original size: ${formatBytes(ready.size)}` : '' });
  }

  async function runCompress() {
    const entry = files.readyEntries[0];
    if (!entry) return;
    const workload = assessWorkload({ fileCount: 1, totalBytes: entry.size, totalPages: entry.pageCount });
    if (workload.level === 'block') {
      status.show(alertBox({ tone: 'error', message: workload.message }));
      return;
    }
    if (workload.level === 'warn' && !(await confirmDialog({ title: 'Large file', message: workload.message, confirmLabel: 'Compress anyway' }))) return;
    const selectedMode = mode;
    await status.run({
      phases: ['load', 'process', 'write', 'verify'],
      task: async (onProgress) => {
        onProgress({ phase: 'load', label: 'Reading the document' });
        const bytes = await entry.file.arrayBuffer();
        return client.request('compress', { bytes, mode: selectedMode }, { transfer: [bytes], onProgress });
      },
      onSuccess: (output) => showResult(entry, output),
    });
  }

  function showResult(entry, { buffer, pageCount, stats }) {
    exportManager?.dispose();
    exportManager = createExportManager();
    const output = exportManager.createOutput({ buffer, name: defaultOutputName('compress', entry.name), pageCount });
    const change = describeSizeChange(entry.size, output.size);
    const smaller = change.direction === 'smaller';
    hasResult = true;
    // A result that isn't smaller isn't worth keeping, so leaving needs no warning.
    downloaded = !smaller;

    const stat = (label, value, tone) => h('div', { class: 'stat' },
      h('p', { class: 'stat__label', text: label }),
      h('p', { class: `stat__value${tone ? ` stat__value--${tone}` : ''}`, text: value }));
    const changeText = change.direction === 'same'
      ? 'No change'
      : `${smaller ? '−' : '+'}${formatBytes(change.absoluteDelta)} (${change.label})`;
    let advice = '';
    if (change.direction === 'same') advice = 'The result is the same size as your original, so there’s no benefit to using it.';
    else if (!smaller) {
      advice = `The result is ${formatBytes(change.absoluteDelta)} larger than your original, which is already well optimized. Keep your original.`;
      if (stats.mode === 'lossless') advice += ' If it contains photos or scans, Balanced may help.';
    }
    const content = h('div', { class: 'stack' },
      h('div', { class: 'stats' },
        stat('Original', formatBytes(entry.size)),
        stat('Result', formatBytes(output.size)),
        stat(smaller ? 'Saved' : 'Change', changeText, smaller ? 'good' : 'bad'),
      ),
      advice && alertBox({ tone: 'warning', message: advice }),
      h('details', { class: 'details' }, h('summary', { text: 'What Foldr changed' }), h('ul', {}, describeWork(stats).map((line) => h('li', { text: line })))),
    );

    const panel = createResultPanel({
      title: smaller ? `Reduced by ${change.label.replace('−', '')}` : 'This file couldn’t be made smaller',
      subtitle: smaller ? `${formatBytes(entry.size)} → ${formatBytes(output.size)}. Page count and page sizes are unchanged.` : 'Your original file is unchanged.',
      outputs: [output],
      exportManager,
      tone: smaller ? 'success' : 'warning',
      downloadLabel: smaller ? 'Download' : 'Download anyway',
      content,
      onStartOver: startOver,
      startOverLabel: 'Compress another PDF',
      onDownloaded: () => { downloaded = true; },
    });
    panel.element.lastElementChild.prepend(h('button', { type: 'button', class: 'btn btn--ghost', text: 'Try another level', onClick: backToOptions }));
    inputSection.hidden = true;
    status.show(panel.element);
    panel.focus();
    announce(smaller ? `Compressed: ${change.label}` : 'The file could not be made smaller.');
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
    files.clear();
  }

  render();
  if (initialFiles.length) files.add(initialFiles.slice(0, 1));

  return {
    focus: header.focus,
    onFiles,
    isDirty: () => status.busy || (hasResult && !downloaded),
    unmount() {
      if (status.busy) client.cancel();
      exportManager?.dispose();
      files.clear();
    },
  };
}
