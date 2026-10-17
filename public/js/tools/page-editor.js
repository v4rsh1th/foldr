// Organize PDF and Rotate Pages share this editor: the same page model
// (core/page-order.js), the same grid and the same worker operation. The mode
// only changes which controls are offered.

import { createFileManager } from '../file-manager.js';
import { createExportManager } from '../export-manager.js';
import { openPreview } from '../pdf-renderer.js';
import {
  createPages, createHistory, movePage, moveSelection, deletePages, rotatePages, resetRotation,
  isModified, hasRotationChanges, toExportPlan,
} from '../core/page-order.js';
import { assessWorkload } from '../core/validation.js';
import { defaultOutputName } from '../core/filenames.js';
import { pluralize } from '../core/format.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { createDropZone } from '../ui/drop-zone.js';
import { renderFileList } from '../ui/file-list.js';
import { createPageGrid } from '../ui/page-grid.js';
import { createResultPanel } from '../ui/result-panel.js';
import { confirmDialog } from '../ui/dialogs.js';
import { toast, announce } from '../ui/notifications.js';
import { createToolHeader, createStatusArea, createActionBar, alertBox, toolById } from './tool-shell.js';

export function createPageEditor(mode) {
  return function mount({ container, client, initialFiles = [] }) {
    const tool = toolById(mode);
    const header = createToolHeader(tool);
    const isOrganize = mode === 'organize';
    let entry = null;
    let preview = null;
    let grid = null;
    let history = null;
    let selection = new Set();
    let anchorKey = null;
    let exportManager = null;
    let hasResult = false;
    let downloaded = true;
    let loadToken = 0;

    const files = createFileManager({ client, multiple: false, onChange: onFilesChanged });
    const dropZone = createDropZone({ multiple: false, onFiles: (list) => requestReplace(list) });
    const fileSlot = h('div');
    const editorSlot = h('div', { class: 'editor-layout' });
    const actionBar = createActionBar({
      label: isOrganize ? 'Save organized PDF' : 'Save rotated PDF',
      icon: 'download',
      onClick: runExport,
    });
    const status = createStatusArea({ client, onBusyChange: () => renderToolbar() });
    const inputSection = h('section', { class: 'tool-section' }, dropZone.element, fileSlot, editorSlot, actionBar.element);
    container.append(h('div', { class: 'tool tool--wide' }, header.element, inputSection, status.element));

    // ---- Toolbar ------------------------------------------------------------

    const statusText = h('p', { class: 'page-toolbar__status', 'aria-live': 'polite' });
    const button = (iconName, label, onClick, extra = {}) => {
      const el = h('button', { type: 'button', class: `icon-btn${extra.danger ? ' icon-btn--danger' : ''}`, 'aria-label': label, title: extra.title ?? label, onClick }, icon(iconName));
      return el;
    };
    const controls = {
      selectAll: button('selectAll', 'Select all pages', () => command('select-all'), { title: 'Select all (Ctrl+A)' }),
      clear: button('close', 'Clear selection', () => command('clear-selection'), { title: 'Clear selection (Esc)' }),
      toStart: button('toStart', 'Move selected pages to the beginning', () => moveSelected('start')),
      left: button('arrowLeft', 'Move selected pages left', () => moveSelected(-1), { title: 'Move left (Alt+←)' }),
      right: button('arrowRight', 'Move selected pages right', () => moveSelected(1), { title: 'Move right (Alt+→)' }),
      toEnd: button('toEnd', 'Move selected pages to the end', () => moveSelected('end')),
      rotateLeft: button('rotateCcw', 'Rotate counter-clockwise', () => rotateSelected(-90), { title: 'Rotate left (Shift+R)' }),
      rotateRight: button('rotateCw', 'Rotate clockwise', () => rotateSelected(90), { title: 'Rotate right (R)' }),
      reset: button('undo', 'Reset rotation', () => resetSelected(), { title: 'Reset rotation' }),
      remove: button('trash', 'Delete selected pages', () => deleteSelected(), { danger: true, title: 'Delete (Del)' }),
      undo: button('undo', 'Undo', () => undo(), { title: 'Undo (Ctrl+Z)' }),
      redo: button('redo', 'Redo', () => redo(), { title: 'Redo (Ctrl+Shift+Z)' }),
    };
    const divider = () => h('span', { class: 'page-toolbar__divider', 'aria-hidden': 'true' });
    const group = (...items) => h('div', { class: 'page-toolbar__group' }, items);
    const toolbar = h('div', { class: 'page-toolbar', role: 'toolbar', 'aria-label': 'Page actions' },
      group(controls.selectAll, controls.clear),
      divider(),
      isOrganize && group(controls.toStart, controls.left, controls.right, controls.toEnd),
      isOrganize && divider(),
      group(controls.rotateLeft, controls.rotateRight, !isOrganize && controls.reset),
      isOrganize && divider(),
      isOrganize && group(controls.remove),
      divider(),
      group(controls.undo, controls.redo),
      statusText,
    );
    toolbar.addEventListener('keydown', (event) => {
      // Arrow-key navigation between toolbar buttons.
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const buttons = [...toolbar.querySelectorAll('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      buttons[(index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length].focus();
    });

    // ---- State helpers ------------------------------------------------------

    const pages = () => history?.state ?? [];
    const selectedKeys = () => pages().filter((page) => selection.has(page.key)).map((page) => page.key);

    function commit(next, message) {
      if (next === pages()) return;
      history.push(next);
      const live = new Set(next.map((page) => page.key));
      selection = new Set([...selection].filter((key) => live.has(key)));
      renderEditor();
      if (message) announce(message);
    }

    function targetKeys() {
      const keys = selectedKeys();
      return keys.length ? keys : null;
    }

    function moveSelected(direction) {
      const keys = selectedKeys();
      if (!keys.length) return;
      commit(moveSelection(pages(), keys, direction), `Moved ${pluralize(keys.length, 'page')}`);
      grid?.focusPage(keys[0]);
    }

    function rotateSelected(delta) {
      const keys = targetKeys();
      commit(rotatePages(pages(), keys, delta), `Rotated ${keys ? pluralize(keys.length, 'page') : 'all pages'} ${delta > 0 ? 'clockwise' : 'counter-clockwise'}`);
    }

    function resetSelected() {
      commit(resetRotation(pages(), targetKeys()), 'Rotation reset');
    }

    async function deleteSelected(keys = selectedKeys()) {
      if (!keys.length) return;
      if (keys.length >= pages().length) {
        toast('A PDF needs at least one page, so you can’t delete every page.', { type: 'error' });
        return;
      }
      commit(deletePages(pages(), keys));
      selection.clear();
      renderEditor();
      toast(`Deleted ${pluralize(keys.length, 'page')}`, { action: { label: 'Undo', onClick: undo } });
      announce(`Deleted ${pluralize(keys.length, 'page')}. ${pluralize(pages().length, 'page')} left.`);
    }

    function undo() {
      if (!history?.canUndo) return;
      history.undo();
      renderEditor();
      announce('Undone');
    }

    function redo() {
      if (!history?.canRedo) return;
      history.redo();
      renderEditor();
      announce('Redone');
    }

    function toggle(key, { extend = false, additive = true } = {}) {
      const list = pages();
      if (extend && anchorKey) {
        const a = list.findIndex((p) => p.key === anchorKey);
        const b = list.findIndex((p) => p.key === key);
        const [start, end] = a < b ? [a, b] : [b, a];
        for (let i = start; i <= end; i += 1) selection.add(list[i].key);
      } else if (additive) {
        if (selection.has(key)) selection.delete(key);
        else selection.add(key);
        anchorKey = key;
      }
      renderEditor();
    }

    function command(name, args = {}) {
      const list = pages();
      switch (name) {
        case 'select-all': selection = new Set(list.map((p) => p.key)); break;
        case 'clear-selection': selection.clear(); break;
        case 'rotate-page':
        case 'rotate-focused': {
          const keys = selection.has(args.key) && selection.size > 1 ? selectedKeys() : [args.key];
          commit(rotatePages(list, keys, args.delta), `Rotated ${pluralize(keys.length, 'page')}`);
          return;
        }
        case 'move-focused': {
          if (selection.has(args.key) && selection.size > 1) {
            moveSelected(Math.sign(args.delta));
          } else {
            const from = list.findIndex((p) => p.key === args.key);
            const next = movePage(list, from, from + args.delta);
            commit(next, `Page moved to position ${next.findIndex((p) => p.key === args.key) + 1} of ${next.length}`);
            grid?.focusPage(args.key);
          }
          return;
        }
        case 'delete-focused': {
          deleteSelected(selection.has(args.key) ? selectedKeys() : [args.key]);
          return;
        }
        default: return;
      }
      renderEditor();
    }

    // ---- Rendering ----------------------------------------------------------

    function renderToolbar() {
      const busy = status.busy;
      const list = pages();
      const count = selectedKeys().length;
      const none = count === 0;
      controls.selectAll.disabled = busy || count === list.length;
      controls.clear.disabled = busy || none;
      for (const key of ['toStart', 'left', 'right', 'toEnd']) controls[key].disabled = busy || none || count === list.length;
      controls.remove.disabled = busy || none || count >= list.length;
      controls.remove.title = count >= list.length && count > 0 ? 'A PDF needs at least one page' : 'Delete (Del)';
      controls.rotateLeft.disabled = busy || !list.length;
      controls.rotateRight.disabled = busy || !list.length;
      controls.rotateLeft.setAttribute('aria-label', none ? 'Rotate all pages counter-clockwise' : 'Rotate selected pages counter-clockwise');
      controls.rotateRight.setAttribute('aria-label', none ? 'Rotate all pages clockwise' : 'Rotate selected pages clockwise');
      controls.reset.disabled = busy || !hasRotationChanges(list);
      controls.undo.disabled = busy || !history?.canUndo;
      controls.redo.disabled = busy || !history?.canRedo;
      statusText.textContent = none
        ? (isOrganize ? 'Select pages, or drag to reorder' : 'Rotate all pages, or select some first')
        : `${count} of ${pluralize(list.length, 'page')} selected`;
      dropZone.setDisabled(busy);

      const changed = entry && history ? (isOrganize ? isModified(list, entry.pageCount) : hasRotationChanges(list)) : false;
      let text = '';
      if (history) {
        const removed = entry.pageCount - list.length;
        const rotated = list.filter((p) => p.rotation).length;
        const parts = [pluralize(list.length, 'page')];
        if (removed) parts.push(`${removed} deleted`);
        if (rotated) parts.push(`${rotated} rotated`);
        text = changed ? parts.join(' · ') : isOrganize ? 'No changes yet.' : 'No pages rotated yet.';
      }
      actionBar.element.hidden = !history;
      actionBar.update({ enabled: !busy && changed, text });
    }

    function renderEditor() {
      if (grid && history) grid.update(pages(), selection);
      renderToolbar();
    }

    function renderFiles() {
      dropZone.element.hidden = files.entries.length > 0;
      fileSlot.replaceChildren(files.entries.length
        ? renderFileList(files.entries, {
          disabled: status.busy,
          onRemove: () => requestReplace([]),
          onReplace: (id, file) => requestReplace([file]),
          onRetry: (id) => files.retry(id),
        })
        : '');
    }

    function teardownEditor() {
      loadToken += 1;
      grid?.destroy();
      grid = null;
      preview?.destroy();
      preview = null;
      history = null;
      selection = new Set();
      editorSlot.replaceChildren();
    }

    let loadedId = null;
    function onFilesChanged() {
      renderFiles();
      const ready = files.readyEntries[0] ?? null;
      if (ready?.id === loadedId) return;
      loadedId = ready?.id ?? null;
      teardownEditor();
      entry = ready;
      renderToolbar();
      if (entry) loadEditor(entry);
    }

    async function loadEditor(current) {
      const token = loadToken;
      const workload = assessWorkload({ fileCount: 1, totalBytes: current.size, totalPages: current.pageCount });
      if (workload.level === 'block') {
        editorSlot.replaceChildren(alertBox({ tone: 'error', title: 'Too large to edit here', message: workload.message }));
        return;
      }
      history = createHistory(createPages(current.pages));
      const notices = [];
      if (workload.level === 'warn') notices.push(alertBox({ tone: 'warning', message: workload.message }));
      const hint = h('p', { class: 'muted small' },
        isOrganize
          ? 'Click pages to select them. Drag to reorder (on touch screens, drag the grip). Keyboard: arrows to move focus, Space to select, Alt+arrows to move, R to rotate, Delete to remove.'
          : 'Use the buttons to rotate every page, or select pages first. Keyboard: arrows to move focus, Space to select, R / Shift+R to rotate.');
      const gridHost = h('div', {}, h('p', { class: 'muted small', role: 'status', text: 'Generating previews…' }));
      editorSlot.replaceChildren(...notices, toolbar, hint, gridHost);
      renderEditor();

      let doc = null;
      try {
        doc = await openPreview(current.file);
        if (doc.numPages !== current.pageCount) console.warn('Foldr: preview page count differs from document');
      } catch {
        if (token === loadToken) toast('Page previews aren’t available for this file, but you can still edit and save it.', { type: 'error' });
      }
      if (token !== loadToken) {
        doc?.destroy();
        return;
      }
      preview = doc;
      grid = makeGrid(current, doc);
      gridHost.replaceChildren(grid.element);
      renderEditor();
    }

    function makeGrid(current, previewDocument) {
      return createPageGrid({
        previewDocument,
        pageSizes: current.pages,
        mode,
        label: `Pages of ${current.name}`,
        onToggle: toggle,
        onMove: (from, to, key) => {
          const next = movePage(pages(), from, to);
          commit(next, `Page moved to position ${to + 1} of ${next.length}`);
          grid?.focusPage(key);
        },
        onCommand: command,
      });
    }

    async function requestReplace(list) {
      if (status.busy) return;
      const dirty = history && isModified(pages(), entry?.pageCount ?? 0);
      if (dirty && !(await confirmDialog({
        title: list.length ? 'Replace this PDF?' : 'Remove this PDF?',
        message: 'Your page changes haven’t been saved and will be lost.',
        confirmLabel: list.length ? 'Replace' : 'Remove',
        tone: 'danger',
      }))) return;
      if (hasResult) backToEditor();
      if (list.length) files.add(list);
      else files.clear();
    }

    async function runExport() {
      if (!entry || !history) return;
      let plan;
      try {
        plan = toExportPlan(pages());
      } catch (error) {
        toast(error.message, { type: 'error' });
        return;
      }
      const source = entry;
      await status.run({
        phases: ['load', 'process', 'write', 'verify'],
        task: async (onProgress) => {
          onProgress({ phase: 'load', label: 'Reading the document' });
          const bytes = await source.file.arrayBuffer();
          return client.request('edit', { bytes, plan }, { transfer: [bytes], onProgress });
        },
        onSuccess: (output) => showResult(source, output),
      });
    }

    function showResult(source, { buffer, pageCount }) {
      exportManager?.dispose();
      exportManager = createExportManager();
      const output = exportManager.createOutput({ buffer, name: defaultOutputName(mode, source.name), pageCount });
      hasResult = true;
      downloaded = false;
      const panel = createResultPanel({
        title: 'Your PDF is ready',
        subtitle: isOrganize ? `Saved with ${pluralize(pageCount, 'page')} in your chosen order.` : 'Rotation has been saved into the PDF.',
        outputs: [output],
        exportManager,
        onStartOver: () => requestStartOver(),
        startOverLabel: 'Start with another PDF',
        onDownloaded: () => { downloaded = true; },
      });
      panel.element.lastElementChild.prepend(h('button', { type: 'button', class: 'btn btn--ghost', onClick: backToEditor }, icon('back'), 'Keep editing'));
      inputSection.hidden = true;
      status.show(panel.element);
      panel.focus();
      announce('Your PDF is ready to download.');
    }

    function backToEditor() {
      exportManager?.dispose();
      exportManager = null;
      hasResult = false;
      downloaded = true;
      status.clear();
      inputSection.hidden = false;
      renderEditor();
    }

    function requestStartOver() {
      backToEditor();
      files.clear();
    }

    // Undo/redo shortcuts while the editor is on screen.
    function onKeyDown(event) {
      if (!history || inputSection.hidden || status.busy) return;
      if (event.target.closest?.('input, textarea, dialog')) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (modifier && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      }
    }
    document.addEventListener('keydown', onKeyDown);

    renderFiles();
    renderToolbar();
    if (initialFiles.length) files.add(initialFiles.slice(0, 1));

    return {
      focus: header.focus,
      onFiles: (list) => requestReplace(list),
      isDirty: () => status.busy
        || (hasResult && !downloaded)
        || Boolean(!hasResult && history && entry && isModified(pages(), entry.pageCount)),
      unmount() {
        if (status.busy) client.cancel();
        document.removeEventListener('keydown', onKeyDown);
        teardownEditor();
        exportManager?.dispose();
        files.clear();
      },
    };
  };
}

export const mountOrganize = createPageEditor('organize');
export const mountRotate = createPageEditor('rotate');
