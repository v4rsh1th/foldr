import { pluralize } from '../core/format.js';
import { h, replaceChildren } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { createDropZone, PDF_ACCEPT } from '../ui/drop-zone.js';
import { IMAGE_ACCEPT } from '../core/image-compress.js';
import { TOOLS, TOOL_GROUPS, groupOf, toolIcon } from './tool-shell.js';

function toolCard(tool, { disabled = false, onClick } = {}) {
  return h('a', {
    class: `tool-card${groupOf(tool) === 'images' ? ' tool-card--image' : ''}`,
    href: `#/${tool.id}`,
    'aria-disabled': disabled ? 'true' : undefined,
    tabIndex: disabled ? -1 : undefined,
    onClick,
  },
  toolIcon(tool),
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
  const heading = h('h1', { tabIndex: -1, text: 'Everything you need for PDFs and images' });

  const dropZone = createDropZone({
    multiple: true,
    accept: `${PDF_ACCEPT},${IMAGE_ACCEPT}`,
    title: 'Choose PDFs or images',
    hint: 'or drag and drop them here',
    buttonLabel: 'Select files',
    onFiles: (files) => {
      pending = files;
      renderChooser();
    },
  });

  // While files are waiting, the chooser replaces the main tool grid: its
  // cards hand the files over, whereas the grid's plain links would open a
  // tool without them.
  const toolsSection = h('div', { class: 'stack' },
    TOOL_GROUPS.map((group) => h('section', { class: 'tool-group', 'aria-labelledby': `tools-${group.id}` },
      h('div', { class: 'tool-group__header' },
        h('h2', { id: `tools-${group.id}`, text: group.title }),
        h('p', { text: group.description }),
      ),
      h('div', { class: 'tool-grid' }, TOOLS.filter((tool) => groupOf(tool) === group.id).map((tool) => toolCard(tool))),
    )),
  );

  function renderChooser() {
    chooser.hidden = pending.length === 0;
    toolsSection.hidden = pending.length > 0;
    dropZone.setCompact(pending.length > 0);
    if (!pending.length) return;
    const many = pending.length > 1;
    // Offer only the tools that accept these files: photos go to Scan and
    // the image tools, PDFs to the rest.
    const photos = pending.every((file) => file.type.startsWith('image/'));
    const tools = TOOLS.filter((tool) => (tool.input === 'images') === photos);
    const title = many ? `${pluralize(pending.length, 'file')} selected` : pending[0].name;
    // The dom.js helper skips false/null children (e.g. the multi-file note).
    replaceChildren(chooser,
      h('div', { class: 'cluster' },
        h('h2', { class: 'tool-section__title', tabIndex: -1, text: `What would you like to do with ${many ? 'these files' : 'this file'}?` }),
        h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => { pending = []; renderChooser(); } }, icon('close'), 'Clear'),
      ),
      h('p', { class: 'muted small', text: title }),
      many && !photos && h('p', { class: 'muted small', text: 'Only Merge works with several files at once. Other tools use the first file.' }),
      h('div', { class: 'tool-grid' }, tools.map((tool) => toolCard(tool, {
        onClick: () => handOff(pending),
      }))),
    );
    chooser.querySelector('h2').focus();
  }

  container.append(h('div', { class: 'home' },
    h('div', { class: 'home-intro' },
      heading,
      h('p', { text: 'Scan documents, shrink photos or strip their hidden metadata, and merge, split, organize, rotate or compress PDFs, quickly and securely.' }),
    ),
    dropZone.element,
    chooser,
    toolsSection,
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
