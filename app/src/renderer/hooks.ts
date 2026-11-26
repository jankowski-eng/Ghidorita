import { useEffect, useState } from "react";

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** On unmount, put focus back where it was when the component mounted (if that element is still there). */
export function useRestoreFocus() {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => { requestAnimationFrame(() => { if (prev && prev.isConnected && !(prev as HTMLButtonElement).disabled) prev.focus(); }); };
  }, []);
}

/** Keep Tab / Shift+Tab inside the dialog element (attach to its onKeyDown). */
export function trapTab(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "Tab") return;
  const f = [...e.currentTarget.querySelectorAll<HTMLElement>("button, input, select, [tabindex]")].filter((x) => !(x as HTMLButtonElement).disabled && x.tabIndex >= 0);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && (document.activeElement === first || !e.currentTarget.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
