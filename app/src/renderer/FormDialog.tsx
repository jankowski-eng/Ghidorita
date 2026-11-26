import { useEffect, useRef, useState } from "react";
import type { DataTypeHit } from "../../../protocol";
import { rpc } from "./client";
import { latest } from "./latest";
import { useDebounced, useRestoreFocus, trapTab } from "./hooks";

export interface FormField { key: string; label: string; initial?: string; kind?: "text" | "datatype" }

/** A data type input with autocomplete from list_data_types (latest reply wins). Arrow keys pick, Enter/Tab accept a pick. */
function TypeInput({ label, value, onChange, disabled, autoFocus }: { label: string; value: string; onChange: (v: string) => void; disabled: boolean; autoFocus: boolean }) {
  const [hits, setHits] = useState<DataTypeHit[]>([]);
  const [sel, setSel] = useState(-1);
  const run = useRef(latest()).current;
  const dq = useDebounced(value, 150);
  useEffect(() => {
    const q = dq.trim().replace(/\s*\*+$|\[\d*\]$/g, ""); // "S *" / "char[8]" suggest by the element name
    if (!q) { run(Promise.resolve(null)); setHits([]); return; }
    run(rpc.call("list_data_types", { query: q, limit: 12 })).then((r) => { if (r) { setHits(r); setSel(-1); } }, () => setHits([]));
  }, [dq]); // eslint-disable-line
  const pick = (h: DataTypeHit) => { onChange(h.name + (/(\s*\*+|\[\d+\])$/.exec(value.trim())?.[0] ?? "")); setHits([]); setSel(-1); };
  return (
    <>
      <input aria-label={label} value={value} disabled={disabled} autoFocus={autoFocus} autoComplete="off" spellCheck={false} role="combobox" aria-expanded={hits.length > 0} aria-controls="ff-list" aria-autocomplete="list"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (!hits.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(hits.length - 1, s + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(-1, s - 1)); }
          else if ((e.key === "Enter" || e.key === "Tab") && sel >= 0) { e.preventDefault(); e.stopPropagation(); pick(hits[sel]); }
        }} />
      {hits.length > 0 && (
        <div className="ac" id="ff-list" role="listbox" aria-label="Data types">
          {hits.map((h, i) => <div key={h.path} role="option" aria-selected={i === sel} className={i === sel ? "cur" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h)}>{h.name} <span className="meta">{h.kind} · {h.size < 0 ? "dynamic" : h.size + " B"}</span></div>)}
        </div>
      )}
    </>
  );
}

/**
 * A modal with several labelled inputs (text, or data type with autocomplete). Enter submits, Escape cancels, the RPC error
 * stays in the dialog. Inputs are found by aria-label (the autotest types into them like a user).
 */
export function FormDialog({ title, fields, submit, onSubmit, onClose }: {
  title: string; fields: FormField[]; submit: string; onSubmit: (v: Record<string, string>) => Promise<void>; onClose: () => void;
}) {
  useRestoreFocus();
  const [vals, setVals] = useState(() => Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ""])));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try { await onSubmit(vals); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  const onKey = (e: React.KeyboardEvent<HTMLElement>) => {
    e.stopPropagation(); // never a listing/menu edit key
    trapTab(e);
    if (e.key === "Escape") { e.preventDefault(); if (!busy) onClose(); }
    else if (e.key === "Enter" && !e.nativeEvent.isComposing && (e.target as HTMLElement).tagName !== "BUTTON") { e.preventDefault(); void go(); }
  };
  return (
    <div className="dlg"><div className="card" role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKey}>
      <div className="title">{title}</div>
      {fields.map((f, i) => (
        <label key={f.key}>{f.label}
          {f.kind === "datatype"
            ? <TypeInput label={f.label} value={vals[f.key]} disabled={busy} autoFocus={i === 0} onChange={(v) => { setVals((x) => ({ ...x, [f.key]: v })); setError(""); }} />
            : <input aria-label={f.label} value={vals[f.key]} disabled={busy} autoFocus={i === 0} autoComplete="off" spellCheck={false} onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => { setVals((x) => ({ ...x, [f.key]: e.target.value })); setError(""); }} />}
        </label>
      ))}
      <div className="err" role="alert">{error}</div>
      <div className="btns">
        <button onClick={onClose} disabled={busy} aria-label={`Cancel ${title}`}>Cancel</button>
        <button onClick={go} disabled={busy} aria-label={submit}>{busy ? "Working…" : submit}</button>
      </div>
    </div></div>
  );
}
