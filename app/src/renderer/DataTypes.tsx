import { isFailure, type ProgramEdits, type TypeEdits, type TypeReads } from "./backend";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DataTypeDetail, DataTypeHit, DtSource } from "../../../protocol";
import { latest } from "./latest";
import { scanner } from "./scan";
import { useDebounced } from "./hooks";
import { Confirm } from "./Confirm";
import { FormDialog, type FormField } from "./FormDialog";
import { EnumEditor, StructEditor, type Run } from "./TypeEditors";
import { catKey, fmtSize, flatten, normAddress, parentPath, typeKey, type Level, type TreeRow } from "./dtTree";

type Sel = { source: string; path: string; category: boolean };
type NewKind = "struct" | "union" | "enum" | "typedef" | "pointer" | "category";
type Dlg = { t: "new"; kind: NewKind } | { t: "rename" } | { t: "delete" } | { t: "apply" };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isNotFound = (e: unknown) => isFailure(e, "notFound");
const KIND_LABEL: Record<string, string> = { struct: "struct", union: "union", enum: "enum", typedef: "typedef", pointer: "ptr", function: "func", array: "array", builtin: "built-in" };

/**
 * Data Type Manager: the program's types and the built-ins as a lazily loaded category tree with a filter, and an editor for the
 * selected type (struct/union, enum; others read-only). Every edit is one RPC = one Ghidra transaction; the panel refetches
 * what it shows when `version` changes (program_changed: edits, undo and redo alike).
 */
export function DataTypes({ types, edits, defineData, version, cursorAddress, onClose }: { types: TypeReads; edits?: TypeEdits; defineData?: ProgramEdits["defineData"]; version: number; cursorAddress: string; onClose: () => void }) {
  const [sources, setSources] = useState<DtSource[]>([]);
  const [levels, setLevels] = useState<Record<string, Level>>({});
  const levelsRef = useRef(levels); levelsRef.current = levels;
  const [open, setOpen] = useState<Set<string>>(() => new Set([catKey("program", "/")]));
  const [filter, setFilter] = useState("");
  const dq = useDebounced(filter.trim(), 150);
  const [hits, setHits] = useState<DataTypeHit[] | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [detail, setDetail] = useState<DataTypeDetail | null>(null);
  const [err, setErr] = useState("");
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const runHits = useRef(latest()).current;
  const sc = useRef(scanner()).current;
  const runDetail = useRef(latest()).current;
  const scroller = useRef<HTMLDivElement>(null);

  const loadLevel = async (source: string, path: string) => {
    try { const l = await types.dtChildren({ source, path }); setLevels((x) => ({ ...x, [catKey(source, path)]: l })); }
    catch (e) {
      if (isNotFound(e)) { setLevels((x) => { const { [catKey(source, path)]: _, ...rest } = x; return rest; }); setOpen((o) => { const n = new Set(o); n.delete(catKey(source, path)); return n; }); }
      else setErr(msg(e));
    }
  };
  // sources once; then (re)load every loaded level whenever the program changed
  useEffect(() => { types.dtSources().then(setSources, (e) => setErr(msg(e))); }, []);
  useEffect(() => {
    const keys = Object.keys(levelsRef.current).length ? Object.keys(levelsRef.current) : [catKey("program", "/")];
    for (const k of keys) { const i = k.indexOf("|"); void loadLevel(k.slice(0, i), k.slice(i + 1)); }
  }, [version]); // eslint-disable-line
  useEffect(() => { // filter: flat search over program + built-in types (list_data_types); empty = tree
    sc.cancelAll(); // the previous scan is stale
    if (!dq) { runHits(Promise.resolve(null)); setHits(null); return; }
    runHits(sc.run(types.listDataTypes({ query: dq, limit: 300 }))).then((r) => { if (r) { setHits(r); setCursor(0); } }, (e) => setErr(msg(e)));
  }, [dq, version]); // eslint-disable-line
  useEffect(() => () => sc.cancelAll(), [sc]);
  const loadDetail = (s: Sel | null) => {
    if (!s || s.category) { runDetail(Promise.resolve(null)); setDetail(null); return; }
    runDetail(types.getDataType({ path: s.path, source: s.source })).then((d) => { if (d) setDetail(d); },
      (e) => { if (isNotFound(e)) { setSel(null); setDetail(null); } else setErr(msg(e)); });
  };
  useEffect(() => loadDetail(sel), [sel?.source, sel?.path, sel?.category, version]); // eslint-disable-line
  const reload = () => loadDetail(sel);

  const rows: TreeRow[] = useMemo(() => hits
    ? hits.map((h): TreeRow => ({ key: typeKey(h.source ?? "program", h.path), depth: 0, kind: "type", label: h.name, source: h.source ?? "program", path: h.path, node: h }))
    : flatten(sources, open, (s, p) => levels[catKey(s, p)]), [hits, sources, open, levels]);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => 20, overscan: 12 });

  const toggle = (r: Extract<TreeRow, { kind: "category" }>) => {
    const next = new Set(open);
    if (r.open) next.delete(r.key); else { next.add(r.key); if (!levels[r.key]) void loadLevel(r.source, r.path); }
    setOpen(next);
  };
  const choose = (r: TreeRow, i: number) => {
    setCursor(i); setErr("");
    setSel({ source: r.source, path: r.path, category: r.kind === "category" });
    if (r.kind === "category") toggle(r);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const r = rows[cursor];
    const go = (i: number) => { const c = Math.max(0, Math.min(rows.length - 1, i)); setCursor(c); v.scrollToIndex(c); if (rows[c]) { const x = rows[c]; setSel({ source: x.source, path: x.path, category: x.kind === "category" }); } };
    if (e.key === "ArrowDown") { e.preventDefault(); go(cursor + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(cursor - 1); }
    else if (r?.kind === "category" && ((e.key === "ArrowRight" && !r.open) || (e.key === "ArrowLeft" && r.open) || e.key === "Enter")) { e.preventDefault(); toggle(r); }
  };

  const writable = edits && sel ? sources.find((s) => s.id === sel.source)?.writable ?? false : false;
  const ctxCategory = sel && sel.source === "program" ? (sel.category ? sel.path : parentPath(sel.path)) : "/";
  const run: Run = async (f) => { try { await f(); setErr(""); reload(); return true; } catch (e) { setErr(msg(e)); return false; } };
  const select = async (path: string, category = false) => { // after create/rename: show the new thing
    setSel({ source: "program", path, category });
    const cat = category ? path : parentPath(path);
    setOpen((o) => { const n = new Set(o); for (let p = cat; ; p = parentPath(p)) { n.add(catKey("program", p)); if (p === "/") break; } return n; });
    await loadLevel("program", cat);
  };

  const formFor = (d: Dlg): { title: string; submit: string; fields: FormField[]; go: (v: Record<string, string>) => Promise<void> } | null => {
    if (d.t === "new") {
      const cat: FormField = { key: "category", label: "Category", initial: ctxCategory };
      const k = d.kind, name: FormField = { key: "name", label: "Name" };
      const fields = k === "struct" ? [name, { key: "size", label: "Size (bytes)", initial: "0" }, cat] : k === "enum" ? [name, { key: "size", label: "Size (bytes)", initial: "4" }, cat]
        : k === "typedef" ? [name, { key: "base", label: "Target type", kind: "datatype" } as FormField, cat] : k === "pointer" ? [{ key: "base", label: "Pointee type", kind: "datatype" } as FormField]
        : k === "category" ? [name, { key: "category", label: "Parent category", initial: ctxCategory }] : [name, cat];
      return { title: `New ${k}`, submit: "Create", fields, go: async (v) => {
        const r = await edits!.createDataType({ kind: k, name: v.name?.trim() || undefined, category: v.category?.trim() || undefined, base: v.base?.trim() || undefined,
          size: v.size !== undefined && v.size.trim() !== "" ? Number(v.size) : undefined });
        await select(r.path, k === "category");
      } };
    }
    if (d.t === "rename" && sel) return { title: "Rename data type", submit: "Rename", fields: [{ key: "name", label: "New name", initial: detail?.name ?? "" }],
      go: async (v) => { const r = await edits!.renameDataType({ path: sel.path, newName: v.name.trim() }); await select(r.path); } };
    if (d.t === "apply" && sel) return { title: "Apply data type", submit: "Apply", fields: [{ key: "address", label: "Address", initial: cursorAddress }, { key: "type", label: "Data type", initial: sel.path, kind: "datatype" }],
      go: async (v) => { const a = normAddress(v.address); if (!a) throw new Error("not an address: " + v.address); await defineData!({ address: a, dataType: v.type.trim() }); } };
    return null;
  };
  const form = dlg ? formFor(dlg) : null;
  const del = async () => {
    if (!sel) return;
    setBusy(true);
    try { await edits!.deleteDataType({ path: sel.path, category: sel.category || undefined }); setDlg(null); setSel(null); setDetail(null); setErr(""); }
    catch (e) { setErr(msg(e)); setDlg(null); } finally { setBusy(false); }
  };

  return (
    <div className="dtm" role="region" aria-label="Data Type Manager" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <div className="dtm-tree">
        <div className="tools">
          {edits && (["struct", "union", "enum", "typedef", "pointer", "category"] as NewKind[]).map((k) => <button key={k} aria-label={`New ${k}`} onClick={() => setDlg({ t: "new", kind: k })}>{k}</button>)}
        </div>
        <input aria-label="Filter data types" placeholder="filter data types" value={filter} autoFocus onChange={(e) => setFilter(e.target.value)} />
        <div className="scroll grow" ref={scroller} role="tree" tabIndex={0} aria-label="Data types" onKeyDown={onKey}>
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {v.getVirtualItems().map((it) => {
              const r = rows[it.index];
              const isSel = sel?.source === r.source && sel.path === r.path && sel.category === (r.kind === "category");
              return (
                <div key={r.key} role="treeitem" aria-level={r.depth + 1} aria-expanded={r.kind === "category" ? r.open : undefined} aria-selected={isSel}
                  className={"trow" + (isSel ? " sel" : "") + (it.index === cursor ? " cur" : "")} onClick={() => choose(r, it.index)}
                  style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${it.start}px)`, paddingLeft: 6 + r.depth * 14 }}>
                  {r.kind === "category" ? <><span className="tw">{r.open ? "▾" : "▸"}</span> {r.label}</>
                    : <><span className={"k k-" + r.node.kind}>{KIND_LABEL[r.node.kind] ?? r.node.kind}</span> {r.label} <span className="meta">{fmtSize(r.node.size)}</span></>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="dtm-detail">
        <div className="tools head">
          <b>{detail ? `${detail.kind} ${detail.name}` : sel?.category ? `category ${sel.path}` : "Data Type Manager"}</b>
          {detail && <span className="meta">{detail.path} · {fmtSize(detail.size)} bytes{detail.archive ? ` · from ${detail.archive}` : ""}{writable ? "" : " · read-only"}</span>}
          <span className="grow" />
          {edits && detail?.writable && <button aria-label="Rename data type" onClick={() => setDlg({ t: "rename" })}>Rename…</button>}
          {sel && writable && (detail || sel.path !== "/") && <button aria-label="Delete data type" onClick={() => setDlg({ t: "delete" })}>Delete…</button>}
          <button aria-label="Close data types" onClick={onClose}>Close</button>
        </div>
        {err && <div className="err pad" role="alert">{err}</div>}
        {!detail && <div className="empty">{sel?.category ? "Pick a type to view or edit it." : "Select a type in the tree, or create one with the buttons above."}</div>}
        {detail && writable && (detail.kind === "struct" || detail.kind === "union") && <StructEditor typeSearch={types.listDataTypes} edit={edits?.editStruct} d={detail} run={run} reload={reload} onApply={() => setDlg({ t: "apply" })} />}
        {detail && writable && detail.kind === "enum" && <EnumEditor edit={edits?.editEnum} d={detail} run={run} reload={reload} onApply={() => setDlg({ t: "apply" })} />}
        {detail && !(writable && ["struct", "union", "enum"].includes(detail.kind)) && (
          <div className="ed pad">
            {detail.description && <p>{detail.description}</p>}
            {detail.base !== undefined && <p>{detail.kind === "typedef" ? "Defined as" : "Points to"} <code>{detail.base}</code>{detail.elements !== undefined ? ` × ${detail.elements}` : ""}</p>}
            {detail.signature && <p><code>{detail.signature}</code></p>}
            {detail.components && <table className="comps" aria-label="Components"><tbody>{detail.components.filter((c) => !c.undefined).map((c) => <tr key={c.ordinal}><td className="mono">{c.offset}</td><td>{c.type}</td><td>{c.name ?? c.defaultName}</td></tr>)}</tbody></table>}
            {writable && detail.kind !== "builtin" && <p className="meta">This kind of type is shown read-only.</p>}
            {defineData && detail.size > 0 && <button aria-label="Apply at address" disabled={detail.kind === "function"} onClick={() => setDlg({ t: "apply" })}>Apply at address…</button>}
          </div>
        )}
      </div>
      {form && dlg && <FormDialog typeSearch={types.listDataTypes} key={dlg.t + ("kind" in dlg ? dlg.kind : "")} title={form.title} submit={form.submit} fields={form.fields} onSubmit={form.go} onClose={() => setDlg(null)} />}
      {dlg?.t === "delete" && sel && <Confirm title="Delete data type?" busy={busy} message={sel.category ? `Delete the empty category ${sel.path}?` : `Delete ${sel.path}? Data defined with it is cleared; Undo brings it back.`}
        actions={[{ label: "Delete", onClick: () => void del(), primary: true }]} onCancel={() => setDlg(null)} />}
    </div>
  );
}
