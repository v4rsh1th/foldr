import { h, uid } from './dom.js';
import { icon } from './icons.js';

export const PDF_ACCEPT = 'application/pdf,.pdf';

/** Opens the native file picker without a persistent input element. */
export function pickFiles({ multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: PDF_ACCEPT, multiple, class: 'visually-hidden', tabIndex: -1, 'aria-hidden': 'true' });
    input.addEventListener('change', () => {
      resolve([...input.files]);
      input.remove();
    }, { once: true });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    }, { once: true });
    document.body.append(input);
    input.click();
  });
}

export function filesFromDrop(event) {
  return [...(event.dataTransfer?.files ?? [])];
}

export function hasFiles(event) {
  return [...(event.dataTransfer?.types ?? [])].includes('Files');
}

export function createDropZone({
  multiple = false,
  title = multiple ? 'Choose PDF files' : 'Choose a PDF',
  hint = multiple ? 'or drag and drop them here' : 'or drag and drop it here',
  buttonLabel = multiple ? 'Select PDFs' : 'Select PDF',
  compact = false,
  accept = PDF_ACCEPT,
  onFiles,
}) {
  const inputId = uid('file-input');
  const input = h('input', {
    id: inputId,
    type: 'file',
    accept,
    multiple,
    class: 'visually-hidden',
    'aria-label': buttonLabel,
    tabIndex: -1,
  });
  const button = h('button', { type: 'button', class: `btn btn--primary${compact ? '' : ' btn--large'}` }, icon('upload'), buttonLabel);
  const zone = h('div', { class: `drop-zone${compact ? ' drop-zone--compact' : ''}` },
    h('div', { class: 'drop-zone__icon' }, icon(compact ? 'plus' : 'upload')),
    h('div', {},
      h('p', { class: 'drop-zone__title', text: title }),
      h('p', { class: 'drop-zone__hint', text: hint }),
    ),
    button,
    input,
  );

  button.addEventListener('click', () => input.click());
  zone.addEventListener('click', (event) => {
    if (event.target === zone || (event.target.closest('.drop-zone') === zone && !event.target.closest('button, input'))) input.click();
  });
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    if (files.length) onFiles(files);
  });

  let depth = 0;
  zone.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth += 1;
    zone.classList.add('drop-zone--active');
  });
  zone.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) zone.classList.remove('drop-zone--active');
  });
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    depth = 0;
    zone.classList.remove('drop-zone--active');
    const files = filesFromDrop(event);
    if (files.length) onFiles(files);
  });

  return {
    element: zone,
    setCompact(value) {
      zone.classList.toggle('drop-zone--compact', value);
      button.classList.toggle('btn--large', !value);
    },
    setDisabled(disabled) {
      button.disabled = disabled;
      input.disabled = disabled;
      zone.toggleAttribute('aria-disabled', disabled);
    },
  };
}
