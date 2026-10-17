// Hash-based routing (#/merge, #/split, …). Hash routes work from any static
// host and offline without server-side fallbacks, and they never reach the
// server, so nothing about the user's work appears in request URLs.

export function createRouter({ routes, fallback, onRoute, canLeave = async () => true }) {
  let current = null;
  let handling = false;

  function parse() {
    const name = location.hash.replace(/^#\/?/, '').split(/[?/]/)[0];
    return routes.includes(name) ? name : fallback;
  }

  async function handle() {
    const next = parse();
    if (next === current || handling) return;
    handling = true;
    try {
      if (current !== null && !(await canLeave(next))) {
        // Stay put without adding a history entry or re-triggering hashchange.
        history.replaceState(null, '', current === fallback ? '#/' : `#/${current}`);
        return;
      }
      current = next;
      onRoute(next);
    } finally {
      handling = false;
    }
  }

  return {
    start() {
      window.addEventListener('hashchange', handle);
      handle();
    },
    navigate(name) {
      const hash = name === fallback ? '#/' : `#/${name}`;
      if (location.hash === hash) handle();
      else location.hash = hash;
    },
    get current() {
      return current;
    },
  };
}
