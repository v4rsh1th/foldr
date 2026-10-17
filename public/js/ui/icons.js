// Inline SVG icons (24px grid, stroke-based), built with DOM APIs.

const PATHS = {
  merge: ['M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3', 'M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3', 'M12 7v10', 'M8 12h8'],
  split: ['M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5', 'M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5', 'M12 2v20'],
  organize: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
  rotate: ['M21 12a9 9 0 1 1-3-6.7', 'M21 4v5h-5'],
  rotateCw: ['M20 12a8 8 0 1 1-2.6-5.9', 'M20 4v5h-5'],
  rotateCcw: ['M4 12a8 8 0 1 0 2.6-5.9', 'M4 4v5h5'],
  compress: ['M4 14h6v6', 'M20 10h-6V4', 'M14 10l7-7', 'M3 21l7-7'],
  upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  download: ['M12 4v12', 'M7 11l5 5 5-5', 'M4 20h16'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  check: ['M5 12l5 5L20 7'],
  arrowLeft: ['M15 6l-6 6 6 6'],
  arrowRight: ['M9 6l6 6-6 6'],
  arrowUp: ['M6 15l6-6 6 6'],
  arrowDown: ['M6 9l6 6 6-6'],
  toStart: ['M17 6l-6 6 6 6', 'M7 6v12'],
  toEnd: ['M7 6l6 6-6 6', 'M17 6v12'],
  back: ['M19 12H5', 'M11 6l-6 6 6 6'],
  undo: ['M9 14L4 9l5-5', 'M4 9h11a5 5 0 0 1 0 10h-3'],
  redo: ['M15 14l5-5-5-5', 'M20 9H9a5 5 0 0 0 0 10h3'],
  replace: ['M4 7h13l-3-3', 'M20 17H7l3 3'],
  offline: ['M2 9a16 16 0 0 1 20 0', 'M5 12.5a11 11 0 0 1 14 0', 'M8.5 16a6 6 0 0 1 7 0', 'M12 20h.01'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-5', 'M12 8h.01'],
  warning: ['M12 3l10 18H2z', 'M12 10v4', 'M12 17.5h.01'],
  error: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M15 9l-6 6', 'M9 9l6 6'],
  success: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M8 12l3 3 5-6'],
  plus: ['M12 5v14', 'M5 12h14'],
  open: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  archive: ['M3 4h18v4H3z', 'M5 8v12h14V8', 'M10 12h4'],
  grip: ['M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01'],
  selectAll: ['M4 4h16v16H4z', 'M8 12l3 3 5-6'],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name, { size = 24, label } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'grip' ? '3' : '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  svg.setAttribute('focusable', 'false');
  for (const d of PATHS[name] ?? PATHS.file) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
