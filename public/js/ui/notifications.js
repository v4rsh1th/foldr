import { h } from './dom.js';
import { icon } from './icons.js';

const MAX_TOASTS = 3;

function region() {
  return document.getElementById('toast-region');
}

/** Announces a message to screen readers via the polite live region. */
export function announce(message) {
  const announcer = document.getElementById('sr-announcer');
  if (!announcer) return;
  // Clearing first makes repeated identical messages announce again.
  announcer.textContent = '';
  setTimeout(() => { announcer.textContent = message; }, 50);
}

/**
 * Shows a toast. `action` is { label, onClick }. Returns a dismiss function.
 * Toasts with an action stay longer so they can be reached by keyboard.
 */
export function toast(message, { type = 'info', action, duration } = {}) {
  const container = region();
  if (!container) return () => {};
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    element.remove();
  };
  const element = h('div', { class: `toast toast--${type}`, role: type === 'error' ? 'alert' : 'status' },
    h('span', { class: 'toast__message', text: message }),
    action && h('button', {
      type: 'button',
      class: 'btn',
      text: action.label,
      onClick: () => {
        dismiss();
        action.onClick();
      },
    }),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Dismiss notification', onClick: dismiss }, icon('close')),
  );
  while (container.children.length >= MAX_TOASTS) container.firstElementChild.remove();
  container.append(element);
  const lifetime = duration ?? (action ? 10000 : type === 'error' ? 8000 : 5000);
  if (lifetime > 0) {
    const start = () => { timer = setTimeout(dismiss, lifetime); };
    element.addEventListener('pointerenter', () => clearTimeout(timer));
    element.addEventListener('pointerleave', start);
    element.addEventListener('focusin', () => clearTimeout(timer));
    element.addEventListener('focusout', start);
    start();
  }
  return dismiss;
}
