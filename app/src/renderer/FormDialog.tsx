import { useEffect, useRef, useState } from "react";
import type { DataTypeHit } from "../../../protocol";
import type { TypeReads } from "./backend";
import { scanner } from "./scan";
import { latest } from "./latest";
import { useDebounced, useRestoreFocus, trapTab } from "./hooks";

export interface FormField { key: string; label: string; initial?: string; kind?: "text" | "datatype" | "check"; choices?: string[] } // choices: suggestions for a text field (a datalist; any text is still accepted)
/** What a dialog shows under its inputs while they change (a preview of the result, e.g. the assembled bytes); submit waits for `ok`. The job is cancelled when the inputs change again. */
export type FormPreview = (v: Record<string, string>) => { result: Promise<{ message: string; ok: boolean }>; cancel(): void };

/** A data type input with autocomplete from list_data_types (latest reply wins). Arrow keys pick, Enter/Tab accept a pick. */
function TypeInput({ typeSearch, label, value, onChange, disabled, autoFocus }: { typeSearch: TypeReads["listDataTypes"]; label: string; value: string; onChange: (v: string) => void; disabled: boolean; autoFocus: boolean }) {
  const [hits, setHits] = useState<DataTypeHit[]>([]);
  const [sel, setSel] = useState(-1);
  const run = useRef(latest()).current;
  const sc = useRef(scanner()).current;
  const dq = useDebounced(value, 150);
  useEffect(() => {
    const q = dq.trim().replace(/\s*\*+$|\[\d*\]$/g, ""); // "S *" / "char[8]" suggest by the element name
    sc.cancelAll(); // the previous scan is stale
    if (!q) { run(Promise.resolve(null)); setHits([]); return; }
    run(sc.run(typeSearch({ query: q, limit: 12 }))).then((r) => { if (r) { setHits(r); setSel(-1); } }, () => setHits([]));
  }, [dq, typeSearch]);
  useEffect(() => () => sc.cancelAll(), [sc]); // eslint-disable-line
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
export function FormDialog({ typeSearch, title, fields, submit, onSubmit, onClose, preview }: {
  preview?: FormPreview; typeSearch?: TypeReads["listDataTypes"]; title: string; fields: FormField[]; submit: string; onSubmit: (v: Record<string, string>) => Promise<void>; onClose: () => void;
}) {
  useRestoreFocus();
  const [vals, setVals] = useState(() => Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ""])));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pv, setPv] = useState<{ message: string; ok: boolean } | null>(null);
  const settled = useDebounced(vals, 250);
  useEffect(() => {
    if (!preview) return;
    let live = true;
    const job = preview(settled);
    job.result.then((r) => { if (live) setPv(r); }, (e) => { if (live) setPv({ message: e instanceof Error ? e.message : String(e), ok: false }); });
    return () => { live = false; job.cancel(); };
  }, [settled]); // eslint-disable-line
  const ready = !preview || (!!pv?.ok && settled === vals);
  const go = async () => {
    if (busy || !ready) return;
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
      {fields.map((f, i) => f.kind === "check" ? (
        <label key={f.key} className="chk"><input type="checkbox" aria-label={f.label} checked={vals[f.key] === "1"} disabled={busy} onChange={(e) => setVals((x) => ({ ...x, [f.key]: e.target.checked ? "1" : "" }))} /> {f.label}</label>
      ) : (
        <label key={f.key}>{f.label}
          {typeSearch && f.kind === "datatype"
            ? <TypeInput typeSearch={typeSearch} label={f.label} value={vals[f.key]} disabled={busy} autoFocus={i === 0} onChange={(v) => { setVals((x) => ({ ...x, [f.key]: v })); setError(""); }} />
            : <><input aria-label={f.label} value={vals[f.key]} disabled={busy} autoFocus={i === 0} autoComplete="off" spellCheck={false} onFocus={(e) => e.currentTarget.select()} list={f.choices?.length ? "choices-" + f.key : undefined}
                onChange={(e) => { setVals((x) => ({ ...x, [f.key]: e.target.value })); setError(""); }} />
              {f.choices?.length ? <datalist id={"choices-" + f.key}>{f.choices.map((c) => <option key={c} value={c} />)}</datalist> : null}</>}
        </label>
      ))}
      {preview && <div className={pv?.ok && settled === vals ? "pv" : "pv wait"} role="status" aria-label="Preview">{settled === vals && pv ? pv.message : "…"}</div>}
      <div className="err" role="alert">{error}</div>
      <div className="btns">
        <button onClick={onClose} disabled={busy} aria-label={`Cancel ${title}`}>Cancel</button>
        <button onClick={go} disabled={busy || !ready} aria-label={submit}>{busy ? "Working…" : submit}</button>
      </div>
    </div></div>
  );
}
