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
