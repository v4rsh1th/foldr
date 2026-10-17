import { formatBytes, pluralize } from '../core/format.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { pickFiles } from './drop-zone.js';

function statusLine(entry) {
  if (entry.status === 'validating') {
    return h('span', { class: 'cluster' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Checking…');
  }
  if (entry.status === 'error') return null;
  return h('span', { text: pluralize(entry.pageCount, 'page') });
}

/**
 * Renders the selected files. Filenames are inserted as text, never HTML.
 * `reorderable` adds move up/down buttons (used by Merge).
 */
export function renderFileList(entries, { reorderable = false, disabled = false, onRemove, onMove, onReplace, onRetry }) {
  return h('ol', { class: 'file-list', 'aria-label': 'Selected files' },
    entries.map((entry, index) => {
      const nameId = `${entry.id}-name`;
      const buttons = [];
      if (reorderable) {
        buttons.push(
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move up', 'aria-describedby': nameId, disabled: disabled || index === 0, onClick: () => onMove(entry.id, -1) }, icon('arrowUp')),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move down', 'aria-describedby': nameId, disabled: disabled || index === entries.length - 1, onClick: () => onMove(entry.id, 1) }, icon('arrowDown')),
        );
      }
      if (entry.status === 'error' && onRetry && entry.errorCode === 'read-failed') {
        buttons.push(h('button', { type: 'button', class: 'btn btn--ghost', disabled, onClick: () => onRetry(entry.id), text: 'Retry' }));
      }
      if (onReplace) {
        buttons.push(h('button', {
          type: 'button',
          class: 'icon-btn',
          'aria-label': 'Replace file',
          title: 'Replace file',
          'aria-describedby': nameId,
          disabled,
          onClick: async () => {
            const [file] = await pickFiles();
            if (file) onReplace(entry.id, file);
          },
        }, icon('replace')));
      }
      buttons.push(h('button', { type: 'button', class: 'icon-btn icon-btn--danger', 'aria-label': 'Remove file', title: 'Remove', 'aria-describedby': nameId, disabled, onClick: () => onRemove(entry.id) }, icon('trash')));

      return h('li', { class: `file-item${entry.status === 'error' ? ' file-item--error' : ''}` },
        h('span', { class: 'file-item__index', 'aria-hidden': 'true', text: reorderable ? String(index + 1) : '' }, reorderable ? null : icon('file', { size: 16 })),
        h('div', { class: 'file-item__body' },
          h('p', { class: 'file-item__name', id: nameId, title: entry.name, text: entry.name }),
          h('p', { class: 'file-item__meta' }, h('span', { text: formatBytes(entry.size) }), statusLine(entry)),
          entry.error && h('p', { class: 'file-item__meta file-item__meta--error', role: 'alert', text: entry.error }),
          entry.warnings?.map((warning) => h('p', { class: 'file-item__meta file-item__meta--warning', text: warning })),
        ),
        h('div', { class: 'file-item__actions' }, buttons),
      );
    }),
  );
}
