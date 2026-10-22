// Full-screen camera for scanning. Shows the live rear camera with the
// detected page outlined, and captures full-resolution photos. Frames are
// read only into a small in-memory canvas for the outline; nothing leaves
// the page. The camera is switched off as soon as the dialog closes.

import { SCAN } from '../config.js';
import { detectDocument, luminance } from '../core/scan-geometry.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { announce } from './notifications.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function cameraSupported() {
  return window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

export class CameraError extends Error {
  constructor(cause) {
    const messages = {
      NotAllowedError: 'Camera access is blocked. Allow the camera for this site in your browser’s settings, or use your camera app instead.',
      SecurityError: 'Camera access is blocked. Allow the camera for this site in your browser’s settings, or use your camera app instead.',
      NotFoundError: 'No camera was found on this device. You can import photos instead.',
      OverconstrainedError: 'No camera was found on this device. You can import photos instead.',
      NotReadableError: 'The camera is being used by another app. Close it and try again, or use your camera app instead.',
    };
    super(messages[cause?.name] ?? 'The camera couldn’t be started. Try again, or use your camera app instead.');
    this.name = 'CameraError';
    this.code = 'camera';
  }
}

const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => { setTimeout(() => reject(new Error('timeout')), ms); }),
]);

/**
 * Opens the camera. `onCapture(blob)` is called for every photo taken.
 * Resolves when the user closes the camera; rejects with CameraError if it
 * can't be started.
 */
export async function openCamera({ onCapture, initialCount = 0 }) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } },
    });
  } catch (error) {
    throw new CameraError(error);
  }
  const [track] = stream.getVideoTracks();
  const capabilities = track.getCapabilities?.() ?? {};
  if (capabilities.focusMode?.includes('continuous')) {
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }
  const imageCapture = typeof ImageCapture === 'function' ? new ImageCapture(track) : null;

  return new Promise((resolve) => {
    let count = initialCount;
    let closed = false;
    let busy = false;
    let timer = 0;
    let torch = false;
    let thumbUrl = null;
    let smoothed = null;
    let misses = 0;

    const video = h('video', { class: 'camera__video', muted: true, autoplay: true, playsInline: true });
    video.setAttribute('playsinline', '');
    video.srcObject = stream;
    const outline = document.createElementNS(SVG_NS, 'svg');
    outline.setAttribute('class', 'camera__outline');
    outline.setAttribute('viewBox', '0 0 1 1');
    outline.setAttribute('preserveAspectRatio', 'none');
    outline.setAttribute('aria-hidden', 'true');
    const polygon = document.createElementNS(SVG_NS, 'polygon');
    polygon.setAttribute('vector-effect', 'non-scaling-stroke');
    outline.append(polygon);
    const frame = h('div', { class: 'camera__frame' }, video, outline, h('div', { class: 'camera__flash' }));
    const hint = h('p', { class: 'camera__hint', text: 'Starting the camera…' });
    const stage = h('div', { class: 'camera__stage' }, frame, hint);

    const thumb = h('img', { class: 'camera__thumb', alt: '', hidden: true });
    const countLabel = h('span', { class: 'camera__count' });
    const shutter = h('button', { type: 'button', class: 'camera__shutter', 'aria-label': 'Take photo', disabled: true });
    const done = h('button', { type: 'button', class: 'btn btn--primary camera__done' }, icon('check'), h('span', { text: 'Done' }));
    const close = h('button', { type: 'button', class: 'icon-btn camera__icon-btn', 'aria-label': 'Close camera' }, icon('close'));
    const torchButton = h('button', { type: 'button', class: 'icon-btn camera__icon-btn', 'aria-label': 'Flashlight', 'aria-pressed': 'false', hidden: !capabilities.torch }, icon('flash'));

    const dialog = h('dialog', { class: 'camera', 'aria-label': 'Camera' },
      h('div', { class: 'camera__top' }, close, torchButton),
      stage,
      h('div', { class: 'camera__bar' },
        h('div', { class: 'camera__pages' }, thumb, countLabel),
        shutter,
        done,
      ),
    );

    function updateCount() {
      countLabel.textContent = count ? `${count} ${count === 1 ? 'page' : 'pages'}` : '';
    }

    function layout() {
      if (!video.videoWidth) return;
      const ratio = video.videoWidth / video.videoHeight;
      const { width, height } = stage.getBoundingClientRect();
      const frameWidth = Math.min(width, height * ratio);
      frame.style.width = `${Math.floor(frameWidth)}px`;
      frame.style.height = `${Math.floor(frameWidth / ratio)}px`;
    }
    const resizeObserver = new ResizeObserver(layout);
    resizeObserver.observe(stage);

    // Live outline: detect on a small copy of the frame a few times a second.
    const probe = document.createElement('canvas');
    const probeContext = probe.getContext('2d', { willReadFrequently: true });
    function detect() {
      if (closed) return;
      if (video.readyState >= 2 && !document.hidden && !busy) {
        const scale = SCAN.liveDetectSide / Math.max(video.videoWidth, video.videoHeight);
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));
        if (probe.width !== width || probe.height !== height) {
          probe.width = width;
          probe.height = height;
        }
        probeContext.drawImage(video, 0, 0, width, height);
        const quad = detectDocument(luminance(probeContext.getImageData(0, 0, width, height).data, width, height), width, height);
        if (quad) {
          misses = 0;
          smoothed = smoothed ? smoothed.map((point, i) => point.map((value, axis) => value * 0.5 + quad[i][axis] * 0.5)) : quad;
          polygon.setAttribute('points', smoothed.map((point) => point.join(',')).join(' '));
          outline.classList.add('camera__outline--found');
          hint.textContent = 'Page found. Hold steady and tap the shutter.';
        } else if (++misses >= 3) {
          smoothed = null;
          outline.classList.remove('camera__outline--found');
          hint.textContent = 'Fit the whole page in view, on a darker surface if you can.';
        }
      }
      timer = setTimeout(detect, SCAN.liveDetectIntervalMs);
    }

    async function grabFrame() {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise((done) => { canvas.toBlob(done, 'image/jpeg', 0.95); });
      canvas.width = 0;
      return blob;
    }

    async function capture() {
      if (busy || closed || video.readyState < 2) return;
      busy = true;
      shutter.disabled = true;
      frame.classList.remove('camera__frame--flash');
      void frame.offsetWidth;
      frame.classList.add('camera__frame--flash');
      let blob = null;
      // takePhoto() uses the full sensor and autofocus; a video frame is the fallback.
      if (imageCapture) {
        try {
          blob = await withTimeout(imageCapture.takePhoto(), 4000);
        } catch {
          blob = null;
        }
      }
      if (!blob && !closed) blob = await grabFrame();
      busy = false;
      shutter.disabled = closed;
      if (!blob || closed) return;
      count += 1;
      updateCount();
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
      thumbUrl = URL.createObjectURL(blob);
      thumb.src = thumbUrl;
      thumb.hidden = false;
      announce(`Page ${count} captured`);
      onCapture(blob);
    }

    function finish() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      resizeObserver.disconnect();
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve();
    }

    shutter.addEventListener('click', capture);
    done.addEventListener('click', finish);
    close.addEventListener('click', finish);
    dialog.addEventListener('close', finish);
    dialog.addEventListener('keydown', (event) => {
      if ((event.key === ' ' || event.key === 'Enter') && event.target === dialog) {
        event.preventDefault();
        capture();
      }
    });
    torchButton.addEventListener('click', () => {
      torch = !torch;
      track.applyConstraints({ advanced: [{ torch }] }).then(() => {
        torchButton.setAttribute('aria-pressed', String(torch));
      }).catch(() => { torch = !torch; });
    });
    video.addEventListener('loadedmetadata', () => {
      layout();
      shutter.disabled = false;
      hint.textContent = 'Point the camera at the page.';
      detect();
    });
    track.addEventListener('ended', finish);

    updateCount();
    document.body.append(dialog);
    dialog.showModal();
    shutter.focus();
    video.play?.().catch(() => {});
  });
}
