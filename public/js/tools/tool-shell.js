// Shared scaffolding for tool views: the page header and a status area that
// runs one operation at a time with progress, cancellation and errors.

import { createOperationTracker } from '../state.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { createProgress } from '../ui/progress.js';
import { announce } from '../ui/notifications.js';

export const TOOLS = [
  { id: 'merge', title: 'Merge PDFs', icon: 'merge', description: 'Combine several PDFs into one, in the order you choose.', multiple: true },
  { id: 'split', title: 'Split PDF', icon: 'split', description: 'Extract pages, split every page, or split by ranges.' },
  { id: 'organize', title: 'Organize PDF', icon: 'organize', description: 'Reorder, rotate and delete pages visually.' },
  { id: 'rotate', title: 'Rotate Pages', icon: 'rotate', description: 'Rotate the whole document or selected pages.' },
  { id: 'compress', title: 'Compress PDF', icon: 'compress', description: 'Reduce file size with lossless or image-based options.' },
  { id: 'scan', title: 'Scan Document', icon: 'scan', description: 'Photograph pages and turn them into a crisp, clean PDF.', input: 'images' },
];

export function toolById(id) {
  return TOOLS.find((tool) => tool.id === id);
}

export function createToolHeader(tool) {
  const heading = h('h1', { tabIndex: -1 }, h('span', { class: 'tool-card__icon', 'aria-hidden': 'true' }, icon(tool.icon)), tool.title);
  const element = h('header', { class: 'tool-header' },
    h('a', { class: 'back-link', href: '#/' }, icon('back'), 'All tools'),
    heading,
    h('p', { text: tool.description }),
  );
  return { element, focus: () => heading.focus({ preventScroll: true }) };
}

export function alertBox({ tone = 'info', title, message, actions = [] }) {
  const icons = { info: 'info', success: 'success', warning: 'warning', error: 'error' };
  return h('div', { class: `alert alert--${tone}`, role: tone === 'error' ? 'alert' : 'status' },
    icon(icons[tone]),
    h('div', { class: 'alert__body' },
      title && h('p', { class: 'alert__title', text: title }),
      message && h('p', { text: message }),
      actions.length > 0 && h('div', { class: 'alert__actions' }, actions),
    ),
  );
}

function describeError(error) {
  if (error?.code === 'cancelled') return null;
  if (error?.code && error.message) return error.message;
  console.error('Foldr: unexpected error:', error?.name, error?.message);
  return 'Something went wrong. Your files are unchanged; please try again.';
}

/**
 * The area below a tool's controls that shows progress, results and errors.
 * `onBusyChange(busy)` lets the tool disable its controls while running.
 */
export function createStatusArea({ client, onBusyChange = () => {} }) {
  const element = h('div', { class: 'stack', 'aria-live': 'off' });
  const tracker = createOperationTracker();
  let busy = false;

  function setBusy(value) {
    busy = value;
    onBusyChange(value);
  }

  return {
    element,
    get busy() { return busy; },

    /**
     * Runs `task(onProgress)`. On success calls `onSuccess(result)`; failures
     * show an error with a Retry button that re-runs with the same inputs.
     */
    async run({ phases, task, onSuccess, retryLabel = 'Try again' }) {
      if (busy) return;
      const token = tracker.begin();
      const progress = createProgress({
        phases,
        onCancel: () => {
          progress.setCancelling();
          client.cancel();
        },
      });
      element.replaceChildren(progress.element);
      setBusy(true);
      progress.element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      try {
        const result = await task((info) => {
          if (tracker.isCurrent(token)) progress.update(info);
        });
        if (!tracker.isCurrent(token)) return;
        progress.update({ phase: 'download', label: 'Preparing download' });
        setBusy(false);
        element.replaceChildren();
        await onSuccess(result);
      } catch (error) {
        if (!tracker.isCurrent(token)) return;
        setBusy(false);
        if (error?.code === 'cancelled') {
          element.replaceChildren(alertBox({ tone: 'info', title: 'Cancelled', message: 'Nothing was changed. Your files are still selected.' }));
          announce('Operation cancelled');
          return;
        }
        const message = describeError(error);
        const retry = h('button', { type: 'button', class: 'btn btn--secondary', text: retryLabel });
        retry.addEventListener('click', () => this.run({ phases, task, onSuccess, retryLabel }));
        element.replaceChildren(alertBox({ tone: 'error', title: 'That didn’t work', message, actions: [retry] }));
        announce(`Error: ${message}`);
      } finally {
        if (tracker.isCurrent(token) && busy) setBusy(false);
      }
    },

    show(...nodes) {
      tracker.invalidate();
      element.replaceChildren(...nodes);
    },

    clear() {
      tracker.invalidate();
      element.replaceChildren();
      if (busy) setBusy(false);
    },
  };
}

/** Summary line + primary action, sticky at the bottom on small screens. */
export function createActionBar({ label, onClick, icon: iconName }) {
  const summary = h('p', { class: 'action-bar__summary', 'aria-live': 'polite' });
  const button = h('button', { type: 'button', class: 'btn btn--primary btn--large', onClick }, iconName && icon(iconName), h('span', { text: label }));
  const element = h('div', { class: 'action-bar' }, summary, h('div', { class: 'action-bar__buttons' }, button));
  return {
    element,
    button,
    update({ enabled, text, buttonLabel }) {
      button.disabled = !enabled;
      if (text !== undefined) summary.textContent = text;
      if (buttonLabel) button.lastChild.textContent = buttonLabel;
    },
  };
}
