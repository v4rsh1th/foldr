// Progress panel. Shows a real percentage only when the operation reports
// done/total; otherwise the bar is indeterminate rather than invented.

import { h } from './dom.js';

const PHASE_LABELS = {
  load: 'Loading',
  preview: 'Previews',
  process: 'Processing',
  write: 'Creating output',
  verify: 'Verifying',
  download: 'Preparing download',
};

export function createProgress({ phases = ['load', 'process', 'write', 'verify'], onCancel } = {}) {
  const label = h('span', { class: 'progress__label', text: 'Starting…' });
  const detail = h('span', { class: 'progress__detail' });
  const bar = h('div', { class: 'progress__bar' });
  const track = h('div', {
    class: 'progress__track',
    role: 'progressbar',
    'aria-label': 'Progress',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
  }, bar);
  const stepElements = new Map(phases.map((phase) => [phase, h('li', { class: 'progress__step', text: PHASE_LABELS[phase] ?? phase })]));
  const cancelButton = onCancel
    ? h('button', { type: 'button', class: 'btn btn--secondary', text: 'Cancel', onClick: () => onCancel() })
    : null;
  const status = h('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });

  const element = h('section', { class: 'panel progress progress--indeterminate', 'aria-label': 'Operation progress' },
    h('div', { class: 'progress__header' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), label, detail, cancelButton),
    track,
    h('ol', { class: 'progress__steps', 'aria-label': 'Steps' }, [...stepElements.values()]),
    status,
  );

  let lastAnnounced = '';
  function update({ phase, label: text, done, total } = {}) {
    if (text) label.textContent = text;
    if (phase && stepElements.has(phase)) {
      let reached = false;
      for (const [key, step] of [...stepElements.entries()].reverse()) {
        if (key === phase) {
          reached = true;
          step.className = 'progress__step progress__step--active';
        } else {
          step.className = reached ? 'progress__step progress__step--done' : 'progress__step';
        }
      }
    }
    const determinate = Number.isFinite(done) && Number.isFinite(total) && total > 0;
    element.classList.toggle('progress--indeterminate', !determinate);
    if (determinate) {
      const percent = Math.round((done / total) * 100);
      bar.style.width = `${percent}%`;
      track.setAttribute('aria-valuenow', String(percent));
      detail.textContent = `${done} of ${total}`;
    } else {
      bar.style.width = '';
      track.removeAttribute('aria-valuenow');
      detail.textContent = '';
    }
    // Announce phase changes only, not every tick.
    if (text && text !== lastAnnounced && !determinate) {
      lastAnnounced = text;
      status.textContent = text;
    }
  }

  return {
    element,
    update,
    setCancelling() {
      if (cancelButton) {
        cancelButton.disabled = true;
        cancelButton.textContent = 'Cancelling…';
      }
    },
  };
}
