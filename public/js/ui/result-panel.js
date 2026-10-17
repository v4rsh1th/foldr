// Shared success/export panel: editable filenames, downloads, optional ZIP,
// open-in-browser preview and "start over".

import { formatBytes, pluralize } from '../core/format.js';
import { sanitizeFilename, stripPdfExtension } from '../core/filenames.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { toast, announce } from './notifications.js';

export function createResultPanel({
  title,
  subtitle,
  outputs,
  exportManager,
  zipName,
  tone = 'success',
  downloadLabel = 'Download',
  content = null,
  onStartOver,
  startOverLabel = 'Start over',
  onDownloaded = () => {},
}) {
  function download(output, nameInput) {
    try {
      const name = exportManager.download(output, `${nameInput.value}.pdf`);
      output.name = name;
      nameInput.value = stripPdfExtension(name);
      onDownloaded(output);
      announce(`Downloading ${name}`);
    } catch (error) {
      console.error('Foldr: download failed:', error?.name);
      toast('The download couldn’t be started. Try again, or use “Open” and save from the viewer.', { type: 'error' });
    }
  }

  const rows = outputs.map((output, index) => {
    const inputId = `output-name-${output.id}`;
    const nameInput = h('input', {
      id: inputId,
      class: 'input',
      type: 'text',
      value: stripPdfExtension(output.name),
      autocomplete: 'off',
      maxLength: 120,
    });
    nameInput.setAttribute('spellcheck', 'false');
    nameInput.addEventListener('change', () => {
      const safe = stripPdfExtension(sanitizeFilename(`${nameInput.value}.pdf`));
      nameInput.value = safe;
      output.name = `${safe}.pdf`;
    });
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') download(output, nameInput);
    });
    return h('li', { class: 'output-item' },
      h('div', {},
        h('label', { class: 'visually-hidden', for: inputId, text: outputs.length > 1 ? `File name for output ${index + 1}` : 'File name' }),
        h('div', { class: 'output-item__name' }, nameInput, h('span', { class: 'output-item__ext', 'aria-hidden': 'true', text: '.pdf' })),
      ),
      h('div', { class: 'output-item__buttons' },
        h('button', { type: 'button', class: 'btn btn--secondary', 'aria-label': `Open ${outputs.length > 1 ? `output ${index + 1}` : 'result'} in a new tab`, onClick: () => exportManager.open(output) }, icon('open'), 'Open'),
        h('button', { type: 'button', class: `btn ${outputs.length === 1 && tone === 'success' ? 'btn--primary' : 'btn--secondary'}`, onClick: () => download(output, nameInput) }, icon('download'), downloadLabel),
      ),
      h('p', { class: 'output-item__meta', text: `${pluralize(output.pageCount, 'page')} · ${formatBytes(output.size)}` }),
    );
  });

  let zipButton = null;
  if (outputs.length > 1 && zipName) {
    zipButton = h('button', { type: 'button', class: 'btn btn--primary' }, icon('archive'), `Download all as ZIP (${outputs.length} files)`);
    zipButton.addEventListener('click', async () => {
      zipButton.disabled = true;
      const label = zipButton.lastChild.textContent;
      zipButton.lastChild.textContent = 'Preparing ZIP…';
      try {
        const name = await exportManager.downloadZip(outputs, zipName);
        outputs.forEach(onDownloaded);
        announce(`Downloading ${name}`);
      } catch (error) {
        console.error('Foldr: ZIP failed:', error?.name);
        toast(error?.name === 'ZipTooLargeError' ? error.message : 'Foldr couldn’t create the ZIP. Download the files individually instead.', { type: 'error' });
      } finally {
        zipButton.disabled = false;
        zipButton.lastChild.textContent = label;
      }
    });
  }

  const heading = h('h2', { class: 'result__title', tabIndex: -1, text: title });
  const element = h('section', { class: 'panel result', 'aria-labelledby': undefined },
    h('div', { class: 'result__header' },
      h('span', { class: `result__icon${tone === 'warning' ? ' result__icon--warning' : ''}`, 'aria-hidden': 'true' }, icon(tone === 'warning' ? 'warning' : 'success')),
      h('div', {}, heading, subtitle && h('p', { class: 'result__subtitle', text: subtitle })),
    ),
    content,
    zipButton && h('div', { class: 'cluster' }, zipButton),
    h('ol', { class: 'output-list', 'aria-label': 'Output files' }, rows),
    h('div', { class: 'cluster' },
      h('button', { type: 'button', class: 'btn btn--ghost', onClick: onStartOver }, icon('undo'), startOverLabel),
    ),
  );
  return { element, focus: () => heading.focus() };
}
