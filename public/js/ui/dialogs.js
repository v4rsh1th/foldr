// Confirmation dialog built on the native <dialog> element, which provides
// modal focus containment and Escape-to-close without a keyboard trap.

import { h } from './dom.js';

export function confirmDialog({
  title,
  message,
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  tone = 'primary',
}) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const titleId = `dialog-title-${Date.now()}`;
    const messageId = `${titleId}-message`;
    const confirmButton = h('button', { type: 'button', class: `btn btn--${tone === 'danger' ? 'danger' : 'primary'}`, text: confirmLabel });
    const cancelButton = h('button', { type: 'button', class: 'btn btn--secondary', text: cancelLabel });
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': titleId, 'aria-describedby': messageId },
      h('div', { class: 'dialog__body' },
        h('h2', { class: 'dialog__title', id: titleId, text: title }),
        h('p', { class: 'dialog__message', id: messageId, text: message }),
      ),
      h('div', { class: 'dialog__actions' }, cancelButton, confirmButton),
    );

    let result = false;
    const close = (value) => {
      result = value;
      dialog.close();
    };
    confirmButton.addEventListener('click', () => close(true));
    cancelButton.addEventListener('click', () => close(false));
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close(false);
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve(result);
    });

    document.body.append(dialog);
    dialog.showModal();
    (tone === 'danger' ? cancelButton : confirmButton).focus();
  });
}
