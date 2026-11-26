import { useEffect, useRef, useState } from "react";
import type { CommentKind, DataTypeHit } from "../../../protocol";
import { rpc } from "./client";
import { latest } from "./latest";
import { useDebounced, useRestoreFocus } from "./hooks";

export type Field = "text" | "datatype" | "comment";
/** comments: the existing text per kind (get_comments); the comment box shows the chosen kind's text and follows the kind selector. */
export interface EditSpec { title: string; label: string; field: Field; initial: string; submit: string; kind?: CommentKind; comments?: Partial<Record<CommentKind, string>> }
export const COMMENT_KINDS: CommentKind[] = ["eol", "pre", "post", "plate", "repeatable"];

/**
 * One modal for every edit: a text input, a data type input with autocomplete (list_data_types, latest reply wins),
 * or a comment box with a kind selector. Enter confirms (Shift+Enter = newline in comments), Escape cancels.
 * No optimistic update: onSubmit calls the edit RPC; its error is shown here and the dialog stays open.
 */
export function EditDialog({ spec, onSubmit, onClose }: {
  spec: EditSpec; onSubmit: (value: string, kind: CommentKind) => Promise<void>; onClose: () => void;
}) {
  useRestoreFocus();
  const [kind, setKind] = useState<CommentKind>(spec.kind ?? "eol");
  const [value, setValue] = useState(spec.comments ? spec.comments[spec.kind ?? "eol"] ?? "" : spec.initial);
  const drafts = useRef<Partial<Record<CommentKind, string>>>({ ...spec.comments }); // text per kind, edits survive switching kinds
  const changeKind = (k: CommentKind) => { drafts.current[kind] = value; setKind(k); setValue(drafts.current[k] ?? ""); setError(""); setTimeout(() => input.current?.focus(), 0); };
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<DataTypeHit[]>([]);
  const [sel, setSel] = useState(-1);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const run = useRef(latest()).current;
  const dq = useDebounced(value, 150);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => {
    if (spec.field !== "datatype" || !dq.trim()) { run(Promise.resolve(null)); setHits([]); return; }
    run(rpc.call("list_data_types", { query: dq.trim(), limit: 20 })).then((r) => { if (r) { setHits(r); setSel(-1); } }, () => setHits([]));
  }, [dq]); // eslint-disable-line
  const submit = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try { await onSubmit(value, kind); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); setTimeout(() => input.current?.focus(), 0); }
  };
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation(); // keys in a dialog are never listing/menu edit keys
    if (e.key === "Escape") { e.preventDefault(); if (!busy) onClose(); return; }
    if (spec.field === "datatype" && hits.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(hits.length - 1, s + 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(-1, s - 1)); return; }
      if ((e.key === "Enter" || e.key === "Tab") && sel >= 0) { e.preventDefault(); setValue(hits[sel].name); setHits([]); setSel(-1); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (e.target as HTMLElement).tagName !== "BUTTON") { e.preventDefault(); void submit(); }
  };
  const common = { ref: input, value, disabled: busy, "aria-label": spec.label, "aria-invalid": !!error, "aria-describedby": "edit-err",
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => { setValue(e.target.value); setError(""); } };
  return (
    <div className="dlg"><div className="card" role="dialog" aria-modal="true" aria-label={spec.title} onKeyDown={onKey}>
      <div className="title">{spec.title}</div>
      {spec.field === "comment" && (
        <label>Comment kind <select aria-label="Comment kind" value={kind} disabled={busy} onChange={(e) => changeKind(e.target.value as CommentKind)}>
          {COMMENT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
      )}
      <label>{spec.label}
        {spec.field === "comment" ? <textarea rows={3} {...common} />
          : spec.field === "datatype" ? <input {...common} role="combobox" aria-expanded={hits.length > 0} aria-controls="dt-list" aria-autocomplete="list" aria-activedescendant={sel >= 0 ? `dt-${sel}` : undefined} autoComplete="off" spellCheck={false} />
          : <input {...common} autoComplete="off" spellCheck={false} />}
      </label>
      {spec.field === "datatype" && hits.length > 0 && (
        <div className="ac" id="dt-list" role="listbox" aria-label="Data types">
          {hits.map((h, i) => <div key={h.path} id={`dt-${i}`} role="option" aria-selected={i === sel} className={i === sel ? "cur" : ""}
            onMouseDown={(e) => e.preventDefault()} onClick={() => { setValue(h.name); setHits([]); input.current?.focus(); }}>{h.name} <span className="meta">{h.path} · {h.size < 0 ? "dynamic" : h.size + " B"}</span></div>)}
        </div>
      )}
      <div id="edit-err" className="err" role="alert">{error}</div>
      <div className="btns">
        <button onClick={onClose} disabled={busy} aria-label="Cancel edit">Cancel</button>
        <button onClick={submit} disabled={busy} aria-label={spec.submit}>{busy ? "Working…" : spec.submit}</button>
      </div>
    </div></div>
  );
}
