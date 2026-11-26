import { useEffect, useRef, useState } from "react";
import type { Address } from "../../../protocol";
import { resolveGoto } from "./parseGoto";
import { searchSymbols } from "./symbols";
import { useRestoreFocus } from "./hooks";

/** Go to address bar: Enter navigates, Escape closes, an invalid entry shows an inline error and stays open. */
export function GoTo({ onGo, onClose }: { onGo: (a: Address) => void; onClose: () => void }) {
  useRestoreFocus();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const submit = async () => {
    try {
      const r = await resolveGoto(value, (q) => searchSymbols(q, 100));
      if ("error" in r) setError(r.error); else { onGo(r.address); onClose(); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="goto" role="dialog" aria-label="Go to address">
      <label>Go to address or function: <input ref={ref} value={value} aria-invalid={!!error} aria-describedby="goto-err" placeholder="0x401000 or main"
        onChange={(e) => { setValue(e.target.value); setError(""); }}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); else if (e.key === "Escape") onClose(); }} /></label>
      <span id="goto-err" className="err" role="alert">{error}</span>
      <button onClick={onClose} aria-label="Close go to address">×</button>
    </div>
  );
}
