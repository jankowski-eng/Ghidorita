import { useSyncExternalStore } from "react";

/**
 * A minimal store: state + pure reducer. `subscribe` serves plain code (the session actions), `useStore` serves components
 * (useSyncExternalStore: select primitives or stable references). No dependency: the reducer is the whole idea.
 */
export interface Store<S, A> { getState(): S; dispatch(a: A): void; subscribe(fn: () => void): () => void }

export function createStore<S, A>(reduce: (s: S, a: A) => S, initial: S): Store<S, A> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(a) { const next = reduce(state, a); if (next === state) return; state = next; for (const f of [...subs]) f(); },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

export function useStore<S, A, T>(store: Store<S, A>, select: (s: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}
