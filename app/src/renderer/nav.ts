import type { Address } from "../../../protocol";

export type Source = "listing" | "decompiler" | "functions" | "goto" | "history" | "open" | "search" | "xrefs" | "graph";
export interface Loc { address: Address; source: Source }
/** Browser-style history: one current location, a back stack and a forward stack. Immutable. */
export interface Nav { current: Loc | null; back: Loc[]; forward: Loc[] }

export const NAV_CAP = 100;
export const emptyNav: Nav = { current: null, back: [], forward: [] };

const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();

/** Navigate to a new location: clears forward; a repeat of the current address changes nothing. */
export function push(n: Nav, loc: Loc, cap = NAV_CAP): Nav {
  if (n.current && same(n.current.address, loc.address)) return n;
  const back = n.current ? [...n.back, n.current] : n.back;
  return { current: loc, back: back.length > cap ? back.slice(back.length - cap) : back, forward: [] };
}
export const goBack = (n: Nav): Nav => n.back.length && n.current
  ? { current: n.back[n.back.length - 1], back: n.back.slice(0, -1), forward: [...n.forward, n.current] } : n;
export const goForward = (n: Nav): Nav => n.forward.length && n.current
  ? { current: n.forward[n.forward.length - 1], back: [...n.back, n.current], forward: n.forward.slice(0, -1) } : n;
