import { pluralize } from '../core/format.js';
import { h, replaceChildren } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { createDropZone } from '../ui/drop-zone.js';
import { TOOLS } from './tool-shell.js';

function toolCard(tool, { disabled = false, onClick } = {}) {
  return h('a', {
    class: 'tool-card',
    href: `#/${tool.id}`,
    'aria-disabled': disabled ? 'true' : undefined,
    tabIndex: disabled ? -1 : undefined,
    onClick,
  },
  h('span', { class: 'tool-card__icon', 'aria-hidden': 'true' }, icon(tool.icon)),
  h('span', { class: 'tool-card__title', text: tool.title }),
  h('span', { class: 'tool-card__desc', text: tool.description }));
}

/**
 * Home: the tool grid plus a drop zone. Files dropped here are handed to
 * whichever tool the user then picks (via `handOff`), never stored.
 */
export function mount({ container, handOff }) {
  let pending = [];
  const chooser = h('section', { class: 'panel stack', 'aria-live': 'polite', hidden: true });
  const heading = h('h1', { tabIndex: -1, text: 'Private PDF tools that run in your browser' });

  const dropZone = createDropZone({
    multiple: true,
    title: 'Choose or drop PDFs to get started',
    hint: 'Your files are opened on this device and never uploaded.',
    buttonLabel: 'Select PDFs',
    onFiles: (files) => {
      pending = files;
      renderChooser();
    },
  });

  // While files are waiting, the chooser replaces the main tool grid: its
  // cards hand the files over, whereas the grid's plain links would open a
  // tool without them.
  const toolsSection = h('section', { 'aria-labelledby': 'tools-heading', class: 'stack' },
    h('h2', { id: 'tools-heading', class: 'visually-hidden', text: 'Tools' }),
    h('div', { class: 'tool-grid' }, TOOLS.map((tool) => toolCard(tool))),
  );

  function renderChooser() {
    chooser.hidden = pending.length === 0;
    toolsSection.hidden = pending.length > 0;
    dropZone.setCompact(pending.length > 0);
    if (!pending.length) return;
    const many = pending.length > 1;
    const title = many ? `${pluralize(pending.length, 'file')} selected` : pending[0].name;
    // The dom.js helper skips false/null children (e.g. the multi-file note).
    replaceChildren(chooser,
      h('div', { class: 'cluster' },
        h('h2', { class: 'tool-section__title', tabIndex: -1, text: `What would you like to do with ${many ? 'these files' : 'this file'}?` }),
        h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => { pending = []; renderChooser(); } }, icon('close'), 'Clear'),
      ),
      h('p', { class: 'muted small', text: title }),
      many && h('p', { class: 'muted small', text: 'Only Merge works with several files at once. Other tools use the first file.' }),
      h('div', { class: 'tool-grid' }, TOOLS.map((tool) => toolCard(tool, {
        onClick: () => handOff(pending),
      }))),
    );
    chooser.querySelector('h2').focus();
  }

  container.append(h('div', { class: 'home' },
    h('div', { class: 'home-intro' },
      heading,
      h('p', { text: 'Merge, split, organize, rotate and compress PDFs. Everything happens on your device: no uploads, no account, no watermarks.' }),
    ),
    dropZone.element,
    chooser,
    toolsSection,
    h('section', { class: 'home-trust', 'aria-label': 'Why Foldr' },
      h('p', { class: 'trust-item' }, icon('shield'), h('span', {}, h('strong', { text: 'Stays on your device' }), 'PDFs are processed in your browser. Nothing is uploaded.')),
      h('p', { class: 'trust-item' }, icon('offline'), h('span', {}, h('strong', { text: 'Works offline' }), 'Install Foldr or revisit it, and it keeps working without a connection.')),
      h('p', { class: 'trust-item' }, icon('free'), h('span', {}, h('strong', { text: 'Free, with no catches' }), 'No sign-up, watermarks, daily limits, ads or tracking.')),
    ),
  ));

  return {
    focus: () => heading.focus({ preventScroll: true }),
    onFiles: (files) => {
      pending = files;
      renderChooser();
    },
    isDirty: () => false,
    unmount() {
      pending = [];
    },
  };
}
