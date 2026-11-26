import { useMemo } from "react";
import type { Address } from "../../../protocol";
import { bpLines, firstAddress, inFunction, lineForAddress, lineValues, statementRange } from "./debug";
import { BinaryMap } from "./BinaryMap";
import { GraphView } from "./GraphView";
import { CallGraphView } from "./CallGraphView";
import { Decompiler } from "./Decompiler";
import { FunctionList } from "./FunctionList";
import { Listing } from "./Listing";
import { Panes } from "./Layout";
import { TabStrip } from "./TabStrip";
import { XrefPanel } from "./XrefPanel";
import { allowsEdit } from "../capabilities";
import { canForce, type TabsApi } from "./useTabs";
import type { Navigation } from "./features/navigation";
import type { Editing } from "./features/editing";
import type { Copying } from "./features/copy";
import { shownDebug } from "./store/program";
import { useProgram, useSession, useViews } from "./store/session";
import type { Views } from "./store/views";

/** The three panes (functions + map + references, listing, decompiler tabs) of the open program. Renders the stores and calls the feature hooks. */
export function Workbench({ tabs, nav, editing, copy, testMode }: { tabs: TabsApi; nav: Navigation; editing: Editing; copy: Copying; testMode: boolean }) {
  const s = useSession();
  const { caps, views, refs } = s;
  const program = useProgram((p) => p.program)!, map = useProgram((p) => p.map), funcs = useProgram((p) => p.funcs);
  const initialRows = useProgram((p) => p.initialRows), reading = useProgram((p) => p.reading), browseError = useProgram((p) => p.browseError);
  const dbg = useProgram(shownDebug), liveDbg = useProgram((p) => p.debug), canDebug = caps.has("debugger");
  const busy = useProgram((p) => !!p.opening || p.closing || p.unavailable);
  const { xrefTarget, useHl, xrefVersion, listingChange, scrollReq, visible, covVersion, graphOn, callGraphOn, dataVersion } = useViews((v) => v);
  const ops = program.api;
  const set = (patch: Partial<Views>) => views.dispatch({ type: "set", patch });
  const names = useMemo(() => new Map(funcs.map((f) => [f.entry, f.name])), [funcs]);
  const here = nav.nav.current?.address ?? null;
  const active = tabs.state.tabs.find((t) => t.id === tabs.state.active) ?? null;
  const ad = active ? tabs.data[active.id] : undefined;
  const hlTokens = useMemo(() => (useHl && ad ? ad.tokens.filter((t) => t.varName === useHl.name && t.address === useHl.address) : []), [useHl, ad?.tokens]); // eslint-disable-line
  const symbolSearch = caps.has("symbolSearch") ? ops.searches.searchSymbols : undefined;
  const { go, goTab, clickAt, fn } = nav;
  const rowMenu = () => [
    { label: "Copy Address", run: () => void copy.copy("address") },
    ...(caps.has("bytes") ? [{ label: "Copy Bytes (Hex)", run: () => void copy.copy("bytes") }, { label: "Copy Bytes (C Array)", run: () => void copy.copy("carray") }] : []),
  ];
  const stoppedAt = dbg?.state === "stopped" ? dbg.address ?? null : null, bps = liveDbg?.breakpoints ?? [];
  const toggleBp = (a: Address | null) => { if (a) void s.debugAction("breakpoint", a); };
  const here_fn = active ? funcs.find((f) => f.entry === active.entry) : undefined;
  const pcLine = ad && stoppedAt && here_fn && inFunction(here_fn, stoppedAt) ? lineForAddress(ad.tokens, stoppedAt) : null; // only in the function that holds the stop
  const stmt = ad && pcLine !== null && stoppedAt ? statementRange(ad.tokens, pcLine, stoppedAt) : null; // the instructions behind the current line
  const vals = ad && dbg?.values && here_fn && dbg.values.entry === here_fn.entry && pcLine !== null ? lineValues(ad.tokens, ad.text, dbg.values.items, dbg.values.was) : []; // values only in the function that holds the stop
  const bpl = useMemo(() => (ad && bps.length ? bpLines(ad.tokens, bps) : []), [ad?.tokens, bps.join(",")]); // eslint-disable-line

  if (!map) return (
    <div className="notice">
      {reading && <p role="status">Reading program…</p>}
      {browseError && <><p role="alert">Could not read the listing for {program.session.name}. {browseError}</p>
        <button disabled={busy || reading} onClick={() => void s.loadBrowsing(program)}>Retry listing</button></>}
    </div>
  );
  return (
    <Panes key={program.session.sessionId} visible={{ ...visible, decompiler: visible.decompiler && caps.has("decompile") }}>{{
      functions: (
        <div className="funcs-col">
          <div className="funcs-row">
            <BinaryMap map={map} funcs={funcs} here={here} covVersion={covVersion} onGo={(a) => go(a, "goto")} />
            <FunctionList searchSymbols={symbolSearch} funcs={funcs} selected={fn?.entry ?? null} onSelect={(e) => go(e, "functions")} menu={(e) => [{ label: "Copy Address", run: () => void copy.copy("address", e) }]} onPin={caps.has("decompile") ? (e) => { void go(e, "functions"); void tabs.show(e, true); } : undefined} />
          </div>
          {caps.has("references") && <XrefPanel references={ops.references} variableReferences={caps.has("variableReferences")} address={here} target={xrefTarget} version={xrefVersion} onGo={(a, use) => { set({ useHl: use ? { name: use.name, address: a } : null }); void go(a, "xrefs"); }} onFollow={() => set({ xrefTarget: null, useHl: null })} />}
        </div>
      ),
      listing: <Listing reader={ops.listing} initialRows={initialRows} testMode={testMode} rowRef={refs.listingRow} canEdit={(action) => allowsEdit(caps, action)} map={map} scrollReq={scrollReq} change={listingChange} topAddrRef={refs.topAddr} cursorRef={refs.cursor} onEdit={(a) => void editing.edit(a)} onLatency={(ms) => s.store.dispatch({ type: "stats", patch: { listingMs: ms } })} onError={s.fail} pc={stoppedAt} stmt={stmt} breakpoints={bps} onGutter={canDebug ? toggleBp : undefined} onRowClick={(a) => go(a, "listing")} onGo={(a) => go(a, "xrefs")} onXrefs={caps.has("references") ? (a) => set({ xrefTarget: { type: "address", address: a, label: a } }) : undefined} menu={rowMenu} />,
      decompiler: caps.has("decompile") && (
        <div className="dec">
          <TabStrip tabs={tabs.state} name={(e) => names.get(e) ?? e} onActivate={(id) => goTab(tabs.activate(id))} onClose={(id) => goTab(tabs.close(id))} onPin={tabs.pin} />
          {!active && <div className="empty">Select a function, click an address in the listing, or press Cmd+G.</div>}
          {ad?.status === "loading" && <div className="empty">Decompiling…{ad.long && <button aria-label="Cancel decompile" onClick={() => tabs.cancel(active!.id)}>Cancel</button>}</div>}
          {ad?.status === "large" && <div className="empty" role="status">This function is {Math.round((ad.size ?? 0) / 1024)} KB: decompiling can take a minute or more.
            <button aria-label="Decompile anyway" onClick={() => tabs.decompileAnyway(active!.id)}>Decompile anyway</button></div>}
          {ad?.status === "error" && <div className="empty err">{ad.error}{canForce(ad) && <button aria-label="Decompile anyway" onClick={() => tabs.decompileAnyway(active!.id)}>Decompile anyway</button>}</div>}
          {graphOn && active && <GraphView source={ops.decompiler.graph} entry={active.entry} here={here} version={dataVersion} covVersion={covVersion} onGo={(a) => go(a, "graph")} />}
          {callGraphOn && active && <CallGraphView source={ops.references.callGraph} entry={active.entry} funcs={funcs} version={dataVersion} covVersion={covVersion} onGo={(a) => go(a, "graph")} />}
          <div className="editor" style={{ display: active && !graphOn && !callGraphOn ? undefined : "none" }}>
            <Decompiler canEdit={caps} tabId={active?.id ?? null} liveIds={tabs.state.tabs.map((t) => t.id)} text={ad?.text ?? ""} tokens={ad?.tokens ?? []} highlight={hlTokens} covVersion={covVersion} pcLine={pcLine} pcSeq={dbg?.stop} values={vals} bpLines={bpl} onGutter={canDebug ? (line1) => toggleBp(ad ? firstAddress(ad.tokens, line1 - 1) : null) : undefined} onCallClick={clickAt} editorRef={refs.editor} onEdit={(a) => void editing.edit(a)} canAt={editing.canAt} onXrefs={editing.showXrefs} onCopy={(w) => void copy.copy(w)} />
          </div>
        </div>
      ),
    }}</Panes>
  );
}
