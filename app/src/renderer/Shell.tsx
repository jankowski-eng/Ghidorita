import { useMemo } from "react";
import type { Address, StackSlot, SymbolHit } from "../../../protocol";
import { allowsEdit } from "../capabilities";
import { Dock } from "./Dock";
import { DataTypes } from "./DataTypes";
import { GoTo } from "./GoTo";
import { SearchPanel } from "./SearchPanel";
import { StatusBar } from "./StatusBar";
import { Toolbar } from "./Toolbar";
import type { Source } from "./nav";
import type { MenuCommand } from "../preload/index";
import { coverageActions } from "./features/coverage";
import { requestOpen } from "./features/dialogs";
import { useBusy } from "./features/menu";
import type { Navigation } from "./features/navigation";
import { shownDebug } from "./store/program";
import { useProgram, useSession, useViews } from "./store/session";

/** The chrome around the panes: toolbar, search and go-to bars, bottom dock, status bar, data type manager. Each renders the stores and calls the features. */
export function AppToolbar() {
  const s = useSession();
  const hasMap = useProgram((p) => !!p.map), busy = useBusy(), open = useViews((v) => v.searchOpen);
  return <Toolbar canCommand={hasMap} busy={busy} open={open} onCommand={() => s.views.dispatch({ type: "set", patch: { searchOpen: true } })}
    onPick={async () => { const p = await window.host.pickFile(); if (p) requestOpen(s, p); }} />;
}

export function TopBars({ go, run }: { go: (a: Address, source: Source) => unknown; run: (c: MenuCommand) => void }) {
  const s = useSession();
  const opened = useProgram((p) => !!p.program), program = useProgram((p) => p.program), funcs = useProgram((p) => p.funcs);
  const layouts = useViews((v) => v.layoutNames), searchOpen = useViews((v) => v.searchOpen), gotoOpen = useViews((v) => v.gotoOpen);
  const close = (key: "searchOpen" | "gotoOpen") => s.views.dispatch({ type: "set", patch: { [key]: false } });
  const symbolSearch = s.caps.has("symbolSearch") ? program?.api.searches.searchSymbols : undefined;
  const searchLocation = (q: string): Promise<SymbolHit[]> => symbolSearch
    ? symbolSearch({ query: q, limit: 100 }).result
    : Promise.resolve(funcs.filter((f) => f.name.toLowerCase().startsWith(q.toLowerCase())).map((f) => ({ name: f.name, address: f.entry, kind: "function" })));
  return (
    <>
      {searchOpen && opened && <SearchPanel layouts={layouts} capabilities={s.caps} searchSymbols={symbolSearch} topSymbols={s.caps.has("suggestions") ? program?.api.searches.topSymbols : undefined} listStrings={s.caps.has("strings") ? program?.api.searches.listStrings : undefined} onGo={(a) => go(a, "search")} onRun={run} onClose={() => close("searchOpen")} />}
      {gotoOpen && opened && <GoTo search={searchLocation} onGo={(a) => go(a, "goto")} onClose={() => close("gotoOpen")} />}
    </>
  );
}

export function BottomDock({ go }: { go: (a: Address, source: Source) => unknown }) {
  const s = useSession();
  const program = useProgram((p) => p.program), funcs = useProgram((p) => p.funcs);
  const { dock, dataVersion, covVersion, fn, cursorAt } = useViews((v) => v);
  const map = useProgram((p) => p.map), here = useViews((v) => v.nav.current?.address ?? null);
  const cov = useMemo(() => coverageActions(s), [s]);
  if (!program || !dock || !map) return null;
  const hex = { read: program.api.listing.bytes, patches: s.caps.has("patch") ? program.api.patch.list : undefined, map, cursor: cursorAt ?? here,
    unit: async (address: Address) => (await program.api.listing.rows({ address, count: 1 }))[0] ?? null };
  // a slot is edited through the decompiler's variable edits (rename_variable / retype_variable): the same dialogs as the decompiler's L and Cmd+L
  const ask = (spec: { title: string; label: string; field: "text" | "datatype"; initial: string; submit: string }, go: (v: string) => Promise<unknown>) =>
    s.views.dispatch({ type: "set", patch: { dlg: { spec, submit: async (v) => { await go(v.trim()); } } } });
  const editable = allowsEdit(s.caps, "retype"); // rename_variable / retype_variable: decompile + variableEditing
  const rename = (entry: Address, slot: StackSlot) => ask({ title: "Rename variable", label: "New name", field: "text", initial: slot.name, submit: "Rename" }, (v) => program.api.edits.renameVariable({ entry, name: slot.name, newName: v }));
  const retype = (entry: Address, slot: StackSlot) => ask({ title: "Retype variable", label: "Data type", field: "datatype", initial: slot.dataType, submit: "Retype" }, (v) => program.api.edits.retypeVariable({ entry, name: slot.name, dataType: v }));
  return <Dock searches={program.api.searches} capabilities={s.caps} active={dock} onActivate={(d) => s.views.dispatch({ type: "set", patch: { dock: d } })} onClose={() => s.views.dispatch({ type: "set", patch: { dock: null } })}
    version={dataVersion} onGo={(a) => go(a, "search")} onError={s.fail} bookmarks={program.api.bookmarks} hex={hex} stack={{ read: program.api.functions.stackFrame, entry: fn?.entry ?? null, name: fn?.name ?? "", onRename: editable ? rename : undefined, onRetype: editable ? retype : undefined }} calls={{ op: program.api.references.calls, entry: fn?.entry ?? null, name: fn?.name ?? "" }} cov={{ version: covVersion, funcs, onLoad: () => void cov.pick(), onChange: cov.changed }} />;
}

export function TypeManager() {
  const s = useSession();
  const program = useProgram((p) => p.program), typesOpen = useViews((v) => v.typesOpen), version = useViews((v) => v.typesVersion);
  if (!program || !typesOpen) return null;
  const editable = s.caps.has("typeEditing");
  return <DataTypes types={program.api.types} edits={editable ? program.api.typeEdits : undefined} defineData={editable ? program.api.edits.defineData : undefined} version={version}
    cursorAddress={s.refs.cursor.current || s.refs.topAddr.current} onClose={() => s.views.dispatch({ type: "set", patch: { typesOpen: false } })} />;
}

export function AppStatusBar({ nav }: { nav: Navigation }) {
  const { map, funcs, stats, error, saving, flash, analysis, debug } = useProgram((p) => p);
  const session = useSession(), shown = useProgram(shownDebug), at = useProgram((p) => p.debugAt), n = useProgram((p) => p.debugHistory.length);
  const dirty = useProgram((p) => p.undo.dirty);
  return (
    <>
      <StatusBar address={nav.nav.current?.address ?? null} func={nav.fn?.name ?? null} bytes={map?.total ?? 0} funcs={funcs.length} stats={stats} error={error} dirty={dirty} saving={saving} flash={flash} analysis={analysis} debug={shown} debugNote={shown && debug && at !== null ? ` · recorded stop ${at + 1} of ${n}, the target is at ${debug.address ?? debug.state}` : ""} onAnalysis={(a) => void session.analysisAction(a)} caps={session.caps}
        back={[...nav.nav.back].reverse().map((l) => l.address)} forward={[...nav.nav.forward].reverse().map((l) => l.address)} onBack={nav.back} onForward={nav.forward} />
    </>
  );
}

/** The welcome pane's line: "Open cancelled.", "Could not open …". */
export function Notice() {
  const notice = useProgram((p) => p.notice);
  return notice ? <div className="flash" role="status">{notice}</div> : null;
}
