import { createFileManager } from '../file-manager.js';
import { createExportManager } from '../export-manager.js';
import { openPreview } from '../pdf-renderer.js';
import { createPages } from '../core/page-order.js';
import { assessWorkload } from '../core/validation.js';
import { formatBytes, pluralize } from '../core/format.js';
import { defaultOutputName } from '../core/filenames.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { createDropZone } from '../ui/drop-zone.js';
import { renderFileList } from '../ui/file-list.js';
import { createResultPanel } from '../ui/result-panel.js';
import { createPageGrid } from '../ui/page-grid.js';
import { confirmDialog } from '../ui/dialogs.js';
import { toast, announce } from '../ui/notifications.js';
import { createToolHeader, createStatusArea, createActionBar, alertBox, toolById } from './tool-shell.js';

export function mount({ container, client, initialFiles = [] }) {
  const tool = toolById('merge');
  const header = createToolHeader(tool);
  const listSlot = h('div', { class: 'stack' });
  const noticeSlot = h('div');
  let exportManager = null;
  let preview = null;
  let grid = null;
  let result = null;
  let downloaded = false;

  const files = createFileManager({ client, multiple: true, onChange: render });
  const dropZone = createDropZone({ multiple: true, title: 'Add PDF files', onFiles: addFiles });
  const actionBar = createActionBar({ label: 'Merge PDFs', icon: 'merge', onClick: runMerge });
  const status = createStatusArea({ client, onBusyChange: render });
  const inputSection = h('section', { class: 'tool-section', 'aria-label': 'Files to merge' }, dropZone.element, listSlot, noticeSlot, actionBar.element);
  const element = h('div', { class: 'tool' }, header.element, inputSection, status.element);
  container.append(element);

  function addFiles(list) {
    const ignored = files.add(list);
    if (ignored) toast(`${pluralize(ignored, 'file')} weren’t added: Foldr merges up to 200 files at once.`, { type: 'error' });
  }

  function render() {
    const { entries } = files;
    const busy = status.busy;
    dropZone.setDisabled(busy);
    dropZone.setCompact(entries.length > 0);
    listSlot.replaceChildren(entries.length
      ? renderFileList(entries, {
        reorderable: true,
        disabled: busy,
        onRemove: (id) => files.remove(id),
        onMove: (id, delta) => {
          files.move(id, delta);
          const index = files.entries.findIndex((e) => e.id === id);
          announce(`Moved to position ${index + 1} of ${files.entries.length}`);
        },
        onReplace: (id, file) => files.replace(id, file),
        onRetry: (id) => files.retry(id),
      })
      : h('p', { class: 'muted small', text: 'Add at least two PDFs. You can reorder them before merging.' }));

    const lossy = files.readyEntries.some((e) => e.features?.hasForm || e.features?.hasOutline || e.features?.hasAttachments);
    noticeSlot.replaceChildren(lossy
      ? alertBox({ tone: 'info', message: 'Some files have bookmarks, form fields or attachments. Pages, text, images and links are merged, but bookmarks, interactive form definitions and attachments aren’t carried over.' })
      : '');

    const ready = files.readyEntries.length;
    const { totalBytes, totalPages } = files.totals;
    let text = '';
    if (files.isValidating) text = 'Checking files…';
    else if (files.hasErrors) text = 'Remove the files that can’t be used to continue.';
    else if (entries.length === 1) text = 'Add at least one more PDF to merge.';
    else if (entries.length > 1) text = `${pluralize(ready, 'file')} · ${pluralize(totalPages, 'page')} · ${formatBytes(totalBytes)}`;
    actionBar.update({ enabled: !busy && ready >= 2 && ready === entries.length, text });
  }

  async function runMerge() {
    const entries = files.readyEntries;
    const workload = assessWorkload(files.totals);
    if (workload.level === 'block') {
      status.show(alertBox({ tone: 'error', title: 'Too large to merge here', message: workload.message }));
      return;
    }
    if (workload.level === 'warn' && !(await confirmDialog({ title: 'Large merge', message: workload.message, confirmLabel: 'Merge anyway' }))) return;

    const ids = entries.map((entry) => entry.id);
    const pageInfos = entries.flatMap((entry) => entry.pages);
    await status.run({
      phases: ['load', 'process', 'write', 'verify'],
      task: async (onProgress) => {
        onProgress({ phase: 'load', label: 'Reading files' });
        await files.ensureRegistered(ids);
        return client.request('merge', { fileIds: ids }, { onProgress });
      },
      onSuccess: (output) => showResult(output, pageInfos),
    });
  }

  async function showResult({ buffer, pageCount }, pageInfos) {
    clearResult();
    exportManager = createExportManager();
    result = exportManager.createOutput({ buffer, name: defaultOutputName('merge'), pageCount });
    downloaded = false;
    const previewSlot = h('div', {}, h('p', { class: 'muted small', text: 'Loading preview…' }));
    const panel = createResultPanel({
      title: 'Your PDF is ready',
      subtitle: `${pluralize(files.entries.length, 'file')} merged into ${pluralize(pageCount, 'page')}.`,
      outputs: [result],
      exportManager,
      content: previewSlot,
      onStartOver: startOver,
      onDownloaded: () => { downloaded = true; },
    });
    const editButton = h('button', { type: 'button', class: 'btn btn--ghost', onClick: backToFiles }, icon('back'), 'Change files');
    panel.element.lastElementChild.prepend(editButton);
    inputSection.hidden = true;
    status.show(panel.element);
    panel.focus();
    announce('Merge complete. Your PDF is ready to download.');

    try {
      preview = await openPreview(result.blob);
      if (!result) return;
      grid = createPageGrid({ previewDocument: preview, pageSizes: pageInfos, mode: 'preview', label: 'Merged pages' });
      grid.update(createPages(pageInfos));
      previewSlot.replaceChildren(h('details', { class: 'details', open: pageCount <= 40 }, h('summary', { text: `Preview ${pluralize(pageCount, 'page')}` }), grid.element));
    } catch {
      previewSlot.replaceChildren(h('p', { class: 'muted small', text: 'Preview unavailable, but the file is ready. Use “Open” to view it.' }));
    }
  }

  function clearResult() {
    grid?.destroy();
    grid = null;
    preview?.destroy();
    preview = null;
    exportManager?.dispose();
    exportManager = null;
    result = null;
  }

  function backToFiles() {
    clearResult();
    status.clear();
    inputSection.hidden = false;
    render();
  }

  function startOver() {
    backToFiles();
    files.clear();
    dropZone.element.querySelector('button')?.focus();
  }

  render();
  if (initialFiles.length) addFiles(initialFiles);

  return {
    focus: header.focus,
    onFiles: (list) => {
      if (status.busy) return;
      if (result) backToFiles();
      addFiles(list);
    },
    isDirty: () => status.busy || (result && !downloaded) || (!result && files.entries.length >= 2),
    unmount() {
      if (status.busy) client.cancel();
      clearResult();
      files.clear();
    },
  };
}
