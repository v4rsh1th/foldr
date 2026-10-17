// Tiny DOM builder. Children that are strings become text nodes, so untrusted
// values (filenames, error messages) can never be interpreted as HTML.
// Props that are false/null/undefined are skipped, so pass string values for
// enumerated attributes such as spellcheck.

export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in element && !key.startsWith('aria') && key !== 'role' && key !== 'list') element[key] = value;
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  append(element, children);
  return element;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function replaceChildren(parent, ...children) {
  parent.replaceChildren();
  return append(parent, children);
}

let idCounter = 0;
export function uid(prefix = 'id') {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** Runs `callback` on the next animation frame, coalescing repeated calls. */
export function frameScheduler(callback) {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      callback();
    });
  };
}
