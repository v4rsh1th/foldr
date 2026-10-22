// Application entry point: routing between tools, unsaved-work protection,
// page-wide drag and drop, connectivity status and service worker updates.

import { APP_VERSION } from './config.js';
import { createRouter } from './router.js';
import { appState } from './state.js';
import { PdfWorkerClient } from './worker-client.js';
import { confirmDialog } from './ui/dialogs.js';
import { toast } from './ui/notifications.js';
import { icon } from './ui/icons.js';
import { h } from './ui/dom.js';
import { filesFromDrop, hasFiles } from './ui/drop-zone.js';
import { mount as mountHome } from './tools/home.js';
import { mount as mountMerge } from './tools/merge.js';
import { mount as mountSplit } from './tools/split.js';
import { mountOrganize, mountRotate } from './tools/page-editor.js';
import { mount as mountCompress } from './tools/compress.js';
import { mount as mountScan } from './tools/scan.js';
import { toolById } from './tools/tool-shell.js';

const VIEWS = {
  home: mountHome,
  merge: mountMerge,
  split: mountSplit,
  organize: mountOrganize,
  rotate: mountRotate,
  compress: mountCompress,
  scan: mountScan,
};

const viewRoot = document.getElementById('view');
const main = document.getElementById('main');
const client = new PdfWorkerClient();
let view = null;
let router;

function mountView(name) {
  view?.unmount();
  viewRoot.replaceChildren();
  window.scrollTo(0, 0);
  const initialFiles = appState.get().pendingFiles;
  appState.set({ pendingFiles: [] });
  view = VIEWS[name]({
    container: viewRoot,
    client,
    initialFiles,
    handOff: (files) => appState.set({ pendingFiles: files }),
  });
  const tool = toolById(name);
  document.title = tool ? `${tool.title} · Foldr` : 'Foldr · PDF tools';
  // Move focus to the new view's heading for keyboard and screen reader users,
  // except on first load where the browser's default focus is expected.
  if (router?.current !== null && document.readyState === 'complete') view.focus?.();
}

async function confirmLeave() {
  if (!view?.isDirty()) return true;
  return confirmDialog({
    title: 'Leave this tool?',
    message: 'Your work here hasn’t been saved. If you leave, your changes and any results you haven’t downloaded will be discarded.',
    confirmLabel: 'Leave',
    cancelLabel: 'Stay',
    tone: 'danger',
  });
}

router = createRouter({
  routes: Object.keys(VIEWS).filter((name) => name !== 'home'),
  fallback: 'home',
  onRoute: mountView,
  canLeave: confirmLeave,
});

window.addEventListener('beforeunload', (event) => {
  if (view?.isDirty()) {
    event.preventDefault();
    event.returnValue = '';
  }
});

// ---- Page-wide drag and drop -------------------------------------------------
// Dropping a PDF anywhere goes to the current tool, and never makes the
// browser navigate away to display the file.

const overlay = h('div', { class: 'global-drop-overlay', hidden: true, 'aria-hidden': 'true' }, h('span', { text: 'Drop PDFs to add them' }));
document.body.append(overlay);
let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  dragDepth += 1;
  overlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) overlay.hidden = true;
});
window.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', (event) => {
  dragDepth = 0;
  overlay.hidden = true;
  if (!hasFiles(event)) return;
  event.preventDefault();
  const files = filesFromDrop(event);
  if (files.length) view?.onFiles?.(files);
});

// ---- Connectivity --------------------------------------------------------------

const networkStatus = document.getElementById('network-status');
function updateNetworkStatus() {
  const offline = !navigator.onLine;
  networkStatus.hidden = !offline;
  if (!offline) return;
  const ready = Boolean(navigator.serviceWorker?.controller);
  networkStatus.className = `pill ${ready ? 'pill--success' : 'pill--warning'}`;
  networkStatus.replaceChildren(icon('offline'), ready ? 'Offline · ready' : 'Offline');
  networkStatus.title = ready
    ? 'You’re offline. Foldr is installed for offline use, so every tool still works.'
    : 'You’re offline and Foldr hasn’t finished saving itself for offline use yet.';
}
window.addEventListener('online', updateNetworkStatus);
window.addEventListener('offline', updateNetworkStatus);

// ---- Service worker ---------------------------------------------------------------

let reloadRequested = false;

function promptForUpdate(registration) {
  appState.set({ updateReady: true });
  toast('A new version of Foldr is available.', {
    duration: 0,
    action: {
      label: 'Reload',
      onClick: async () => {
        if (view?.isDirty() && !(await confirmLeave())) return;
        reloadRequested = true;
        registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
      },
    },
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    const hadController = Boolean(navigator.serviceWorker.controller);
    const registration = await navigator.serviceWorker.register('sw.js', { scope: './' });
    if (registration.waiting && hadController) promptForUpdate(registration);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state !== 'installed') return;
        if (hadController || navigator.serviceWorker.controller) promptForUpdate(registration);
        else toast('Foldr is ready to work offline.', { type: 'success' });
      });
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      updateNetworkStatus();
      // Reload only for an update the user asked for in this tab; first
      // install (clients.claim) and updates applied from other tabs don't
      // reload, so no work is lost.
      if (!reloadRequested || reloading) {
        if (hadController && !reloadRequested && view?.isDirty()) {
          toast('Foldr was updated in another tab. Finish what you’re doing, then reload this page.', { duration: 0 });
        }
        return;
      }
      reloading = true;
      window.location.reload();
    });
  } catch (error) {
    console.warn('Foldr: offline support unavailable:', error?.message);
  }
}

// ---- Start ------------------------------------------------------------------------

document.getElementById('app-version').textContent = `v${APP_VERSION}`;
// The skip link must not change the hash, which drives routing.
document.querySelector('.skip-link')?.addEventListener('click', (event) => {
  event.preventDefault();
  main.focus();
});
main.addEventListener('click', (event) => {
  // Keep in-app links from reloading when they point at the current route.
  const link = event.target.closest('a[href^="#/"]');
  if (link && link.getAttribute('aria-disabled') === 'true') event.preventDefault();
});
updateNetworkStatus();
router.start();
if (document.readyState === 'complete') registerServiceWorker();
else window.addEventListener('load', registerServiceWorker, { once: true });
