import { plainWarning, prefixNotes } from "./warnings";

const SHOWN = 3;
/** Compact bar above the decompiled C: one truncated line per warning (full text on hover), then the in_ / unaff_ / extraout_ notes when a warning mentions them. */
export function DecompilerWarnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  const notes = prefixNotes(warnings);
  return (
    <div className="dwarn" role="status" aria-label="Decompiler warnings">
      {warnings.slice(0, SHOWN).map((w, i) => <div key={i} className="dw" title={w}>⚠ {plainWarning(w)}</div>)}
      {warnings.length > SHOWN && <div className="dw dim" title={warnings.slice(SHOWN).join("\n")}>+ {warnings.length - SHOWN} more (hover for the full text)</div>}
      {notes.map((n) => <div key={n} className="dw dim" title={n}>{n}</div>)}
    </div>
  );
}
