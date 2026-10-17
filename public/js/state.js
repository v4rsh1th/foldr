// Minimal observable store. Each tool keeps its own store; app-level state
// (files handed over from the home screen, update availability) lives in
// `appState`. Nothing here is persisted: document bytes never touch storage.

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get() {
      return state;
    },
    set(changes) {
      const next = typeof changes === 'function' ? changes(state) : { ...state, ...changes };
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const appState = createStore({
  pendingFiles: [],
  updateReady: false,
});

/**
 * Tracks one asynchronous operation at a time. `begin()` returns a token;
 * results are applied only if the token is still current, so a cancelled or
 * superseded operation can never overwrite a newer result.
 */
export function createOperationTracker() {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    isCurrent(token) {
      return token === current;
    },
    invalidate() {
      current += 1;
    },
  };
}
