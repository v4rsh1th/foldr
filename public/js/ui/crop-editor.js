// Corner editor for a scanned page: four draggable handles over the photo.
// Handles also move with the arrow keys (Shift for bigger steps), so the
// crop can be adjusted without a pointer.

import { FULL_QUAD, isConvexQuad } from '../core/scan-geometry.js';
import { h } from './dom.js';
import { icon } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CORNERS = ['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left'];

function svg(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

/**
 * Resolves with the new quad, or null if cancelled. `autoQuad` is the
 * detected outline (null if none was found).
 */
export function editCrop({ imageUrl, width, height, quad, autoQuad, pageLabel }) {
  return new Promise((resolve) => {
    let points = quad.map((point) => [...point]);
    let result = null;

    const image = h('img', { class: 'crop__image', src: imageUrl, alt: '', draggable: false });
    const shade = svg('path', { class: 'crop__shade', 'fill-rule': 'evenodd' });
    const edge = svg('polygon', { class: 'crop__edge', 'vector-effect': 'non-scaling-stroke' });
    const overlay = svg('svg', { class: 'crop__overlay', viewBox: '0 0 1 1', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    overlay.append(shade, edge);
    const handles = CORNERS.map((name, index) => {
      const handle = h('button', { type: 'button', class: 'crop__handle', 'aria-label': `${name} corner. Use the arrow keys to move it.` });
      handle.addEventListener('pointerdown', (event) => startDrag(event, index));
      handle.addEventListener('keydown', (event) => nudge(event, index));
      return handle;
    });
    const frame = h('div', { class: 'crop__frame' }, image, overlay, handles);
    const stage = h('div', { class: 'crop__stage' }, frame);
    // Fit the photo inside the stage without distorting it.
    const resizeObserver = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      const scale = Math.min(box.width / width, box.height / height);
      frame.style.width = `${Math.floor(width * scale)}px`;
      frame.style.height = `${Math.floor(height * scale)}px`;
    });

    const error = h('p', { class: 'field__error', role: 'alert', hidden: true, text: 'The corners cross over. Drag each one to a corner of the page.' });
    const apply = h('button', { type: 'button', class: 'btn btn--primary' }, icon('check'), 'Apply');
    const cancel = h('button', { type: 'button', class: 'btn btn--secondary', text: 'Cancel' });
    const detect = h('button', { type: 'button', class: 'btn btn--ghost', disabled: !autoQuad }, icon('scan'), autoQuad ? 'Auto-detect' : 'No edges found');
    const whole = h('button', { type: 'button', class: 'btn btn--ghost' }, icon('selectAll'), 'Whole photo');

    const dialog = h('dialog', { class: 'dialog crop', 'aria-label': `Adjust corners of ${pageLabel}` },
      h('div', { class: 'crop__header' },
        h('h2', { class: 'dialog__title', text: `Adjust corners · ${pageLabel}` }),
        h('p', { class: 'muted small', text: 'Drag the corners onto the corners of the page.' }),
      ),
      stage,
      error,
      h('div', { class: 'dialog__actions crop__actions' },
        h('div', { class: 'cluster' }, detect, whole),
        h('div', { class: 'cluster' }, cancel, apply),
      ),
    );

    function draw() {
      const list = points.map((p) => p.join(',')).join(' ');
      edge.setAttribute('points', list);
      shade.setAttribute('d', `M0,0H1V1H0Z M${points.map((p) => p.join(',')).join(' L')} Z`);
      points.forEach(([x, y], index) => {
        handles[index].style.left = `${x * 100}%`;
        handles[index].style.top = `${y * 100}%`;
      });
      const valid = isConvexQuad(points.map(([x, y]) => [x * width, y * height]));
      error.hidden = valid;
      apply.disabled = !valid;
      edge.classList.toggle('crop__edge--invalid', !valid);
    }

    function setPoint(index, x, y) {
      points[index] = [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
      draw();
    }

    function startDrag(event, index) {
      event.preventDefault();
      const handle = handles[index];
      handle.setPointerCapture(event.pointerId);
      handle.focus();
      const rect = frame.getBoundingClientRect();
      // Keep the offset between the finger and the corner, so the corner
      // doesn't jump under the finger and stays visible beside it.
      const offsetX = event.clientX - (rect.left + points[index][0] * rect.width);
      const offsetY = event.clientY - (rect.top + points[index][1] * rect.height);
      const move = (moveEvent) => {
        setPoint(index, (moveEvent.clientX - offsetX - rect.left) / rect.width, (moveEvent.clientY - offsetY - rect.top) / rect.height);
      };
      const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        handle.classList.remove('crop__handle--active');
      };
      handle.classList.add('crop__handle--active');
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }

    function nudge(event, index) {
      const step = event.shiftKey ? 0.025 : 0.004;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      if (!delta) return;
      event.preventDefault();
      setPoint(index, points[index][0] + delta[0], points[index][1] + delta[1]);
    }

    detect.addEventListener('click', () => {
      points = autoQuad.map((point) => [...point]);
      draw();
    });
    whole.addEventListener('click', () => {
      points = FULL_QUAD.map((point) => [...point]);
      draw();
    });
    cancel.addEventListener('click', () => dialog.close());
    apply.addEventListener('click', () => {
      result = points;
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      resizeObserver.disconnect();
      dialog.remove();
      resolve(result);
    });

    draw();
    document.body.append(dialog);
    dialog.showModal();
    resizeObserver.observe(stage);
    handles[0].focus();
  });
}
