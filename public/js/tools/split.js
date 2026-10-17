import { createFileManager } from '../file-manager.js';
import { createExportManager } from '../export-manager.js';
import { parsePageList, parseRangeGroups, chunkPages, formatGroupsInput, formatPageLabel } from '../core/page-ranges.js';
import { baseNameOf, defaultOutputName, uniqueFilenames, sanitizeFilename } from '../core/filenames.js';
import { pluralize } from '../core/format.js';
import { h, uid } from '../ui/dom.js';
import { createDropZone } from '../ui/drop-zone.js';
import { renderFileList } from '../ui/file-list.js';
import { createResultPanel } from '../ui/result-panel.js';
import { confirmDialog } from '../ui/dialogs.js';
import { announce } from '../ui/notifications.js';
import { createToolHeader, createStatusArea, createActionBar, toolById } from './tool-shell.js';

const MODES = [
  { id: 'extract', title: 'Extract pages', description: 'Pick pages for one new PDF, in the order you type them.' },
  { id: 'individual', title: 'Every page', description: 'Save each page as its own PDF.' },
  { id: 'ranges', title: 'Split by ranges', description: 'Each range becomes a separate PDF.' },
];
const MANY_OUTPUTS = 100;

function labelForName(pages) {
  const label = formatPageLabel(pages);
  return label.length > 40 ? 'selection' : label;
}

export function mount({ container, client, initialFiles = [] }) {
  const tool = toolById('split');
  const header = createToolHeader(tool);
  let mode = 'extract';
  let plan = { groups: [], error: null };
  let exportManager = null;
  let downloaded = true;
  let hasResult = false;

  const files = createFileManager({ client, multiple: false, onChange: () => onFilesChanged() });
  const dropZone = createDropZone({ multiple: false, onFiles: (list) => files.add(list) });
  const listSlot = h('div');
  const actionBar = createActionBar({ label: 'Split PDF', icon: 'split', onClick: runSplit });
  const status = createStatusArea({ client, onBusyChange: render });

  // Options ---------------------------------------------------------------
  const radioName = uid('split-mode');
  const modeInputs = MODES.map((option) => h('input', { type: 'radio', name: radioName, value: option.id, checked: option.id === mode }));
  const modeGroup = h('fieldset', { class: 'choice-group choice-group--row' },
    h('legend', { text: 'How do you want to split?' }),
    MODES.map((option, index) => h('label', { class: 'choice' },
      modeInputs[index],
      h('span', { class: 'choice__title', text: option.title }),
      h('span', { class: 'choice__desc', text: option.description }),
    )),
  );
  modeGroup.addEventListener('change', (event) => {
    mode = event.target.value;
    updatePlan();
  });

  const rangeInputId = uid('pages');
  const hintId = `${rangeInputId}-hint`;
  const errorId = `${rangeInputId}-error`;
  const rangeLabel = h('label', { class: 'field__label', for: rangeInputId });
  const rangeInput = h('input', { id: rangeInputId, class: 'input', type: 'text', inputMode: 'text', autocomplete: 'off', 'aria-describedby': `${hintId} ${errorId}` });
  rangeInput.setAttribute('spellcheck', 'false');
  const rangeHint = h('p', { class: 'field__hint', id: hintId });
  const rangeError = h('p', { class: 'field__error', id: errorId, role: 'alert' });
  rangeInput.addEventListener('input', updatePlan);

  const chunkInputId = uid('chunk');
  const chunkInput = h('input', { id: chunkInputId, class: 'input input--narrow', type: 'number', min: '1', step: '1', value: '5', inputMode: 'numeric' });
  const chunkButton = h('button', { type: 'button', class: 'btn btn--secondary', text: 'Fill in ranges' });
  chunkButton.addEventListener('click', () => {
    const entry = files.readyEntries[0];
    if (!entry) return;
    try {
      rangeInput.value = formatGroupsInput(chunkPages(entry.pageCount, Number(chunkInput.value)));
      updatePlan();
    } catch (error) {
      rangeError.textContent = error.message;
    }
  });
  const chunkRow = h('div', { class: 'field' },
    h('label', { class: 'field__label', for: chunkInputId, text: 'Or split every N pages' }),
    h('div', { class: 'input-group' }, chunkInput, chunkButton),
  );
  const rangeField = h('div', { class: 'field' }, rangeLabel, rangeInput, rangeHint, rangeError);
  const individualNote = h('p', { class: 'field__hint' });
  const options = h('section', { class: 'panel stack', 'aria-label': 'Split options' }, modeGroup, rangeField, chunkRow, individualNote);

  const inputSection = h('section', { class: 'tool-section' }, dropZone.element, listSlot, options, actionBar.element);
  container.append(h('div', { class: 'tool' }, header.element, inputSection, status.element));

  function updatePlan() {
    const entry = files.readyEntries[0];
    rangeField.hidden = mode === 'individual';
    chunkRow.hidden = mode !== 'ranges';
    individualNote.hidden = mode !== 'individual';
    rangeLabel.textContent = mode === 'extract' ? 'Pages to extract' : 'Page ranges';
    rangeInput.placeholder = mode === 'extract' ? 'e.g. 1, 3, 5-8' : 'e.g. 1-5, 6-10, 11-15';
    rangeHint.textContent = mode === 'extract'
      ? `Separate pages with commas and use a dash for ranges.${entry ? ` This document has ${pluralize(entry.pageCount, 'page')}.` : ''}`
      : `Each comma-separated range becomes its own file.${entry ? ` This document has ${pluralize(entry.pageCount, 'page')}.` : ''}`;
    plan = { groups: [], error: null };
    if (entry) {
      try {
        if (mode === 'individual') {
          plan.groups = Array.from({ length: entry.pageCount }, (_, i) => ({ pages: [i + 1] }));
          individualNote.textContent = `This creates ${pluralize(entry.pageCount, 'file')}, one per page.`;
        } else if (rangeInput.value.trim()) {
          plan.groups = mode === 'extract'
            ? [{ pages: parsePageList(rangeInput.value, entry.pageCount) }]
            : parseRangeGroups(rangeInput.value, entry.pageCount);
        }
      } catch (error) {
        plan.error = error.message;
      }
    }
    rangeError.textContent = plan.error ?? '';
    rangeInput.setAttribute('aria-invalid', String(Boolean(plan.error)));
    render();
  }

  function render() {
    const busy = status.busy;
    const entry = files.entries[0];
    dropZone.element.hidden = Boolean(entry);
    listSlot.replaceChildren(entry
      ? renderFileList(files.entries, { disabled: busy, onRemove: (id) => files.remove(id), onReplace: (id, f) => files.replace(id, f), onRetry: (id) => files.retry(id) })
      : '');
    const ready = files.readyEntries[0];
    options.hidden = !ready;
    [...modeInputs, rangeInput, chunkInput, chunkButton].forEach((control) => { control.disabled = busy; });
    let text = '';
    if (ready && !plan.error && plan.groups.length) {
      const pages = plan.groups.reduce((sum, g) => sum + g.pages.length, 0);
      text = plan.groups.length === 1
        ? `Creates 1 file with ${pluralize(pages, 'page')}.`
        : `Creates ${pluralize(plan.groups.length, 'file')}.`;
    } else if (ready && !plan.error) {
      text = 'Enter the pages you want.';
    }
    actionBar.element.hidden = !ready;
    actionBar.update({ enabled: Boolean(ready) && !busy && !plan.error && plan.groups.length > 0, text });
  }

  function outputNames(entry, groups) {
    const base = baseNameOf(entry.name);
    const names = groups.map((group) => (mode === 'individual'
      ? sanitizeFilename(`${base}-page-${group.pages[0]}`)
      : defaultOutputName('split', entry.name, labelForName(group.pages))));
    return uniqueFilenames(names);
  }

  async function runSplit() {
    const entry = files.readyEntries[0];
    const { groups } = plan;
    if (!entry || !groups.length) return;
    if (groups.length > MANY_OUTPUTS && !(await confirmDialog({
      title: `Create ${groups.length} files?`,
      message: 'That’s a lot of separate files. You’ll be able to download them together as a ZIP.',
      confirmLabel: 'Create files',
    }))) return;
    const names = outputNames(entry, groups);
    await status.run({
      phases: ['load', 'process', 'verify'],
      task: async (onProgress) => {
        onProgress({ phase: 'load', label: 'Reading the document' });
        await files.ensureRegistered([entry.id]);
        return client.request('split', { fileId: entry.id, groups: groups.map((g) => ({ pages: g.pages })) }, { onProgress });
      },
      onSuccess: (outputs) => showResult(entry, outputs, names),
    });
  }

  function showResult(entry, outputs, names) {
    exportManager?.dispose();
    exportManager = createExportManager();
    const results = outputs.map((output, index) => exportManager.createOutput({ buffer: output.buffer, name: names[index], pageCount: output.pageCount }));
    hasResult = true;
    downloaded = false;
    const panel = createResultPanel({
      title: results.length === 1 ? 'Your PDF is ready' : `${results.length} PDFs are ready`,
      subtitle: `Split from ${entry.name}.`,
      outputs: results,
      exportManager,
      zipName: `${baseNameOf(entry.name)}-split.zip`,
      onStartOver: startOver,
      startOverLabel: 'Split another PDF',
      onDownloaded: () => { downloaded = true; },
    });
    const again = h('button', { type: 'button', class: 'btn btn--ghost', text: 'Change pages', onClick: backToOptions });
    panel.element.lastElementChild.prepend(again);
    inputSection.hidden = true;
    status.show(panel.element);
    panel.focus();
    announce('Split complete.');
  }

  function backToOptions() {
    exportManager?.dispose();
    exportManager = null;
    hasResult = false;
    downloaded = true;
    status.clear();
    inputSection.hidden = false;
    rangeInput.focus();
  }

  function startOver() {
    backToOptions();
    rangeInput.value = '';
    files.clear();
    updatePlan();
  }

  // Re-plan whenever the ready file changes (its page count affects validation).
  let lastEntryKey = '';
  function onFilesChanged() {
    const ready = files.readyEntries[0];
    const key = ready ? `${ready.id}:${ready.pageCount}` : '';
    if (key === lastEntryKey) {
      render();
      return;
    }
    lastEntryKey = key;
    updatePlan();
  }

  updatePlan();
  if (initialFiles.length) files.add(initialFiles.slice(0, 1));

  return {
    focus: header.focus,
    onFiles: (list) => {
      if (status.busy) return;
      if (hasResult) backToOptions();
      files.add(list);
    },
    isDirty: () => status.busy || (hasResult && !downloaded),
    unmount() {
      if (status.busy) client.cancel();
      exportManager?.dispose();
      files.clear();
    },
  };
}
