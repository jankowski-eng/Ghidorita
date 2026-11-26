import { useMemo } from "react";
import { BinaryMap } from "./BinaryMap";
import { GraphView } from "./GraphView";
import { CallGraphView } from "./CallGraphView";
import { DecompilerWarnings } from "./DecompilerWarnings";
import { Decompiler } from "./Decompiler";
import { FunctionList } from "./FunctionList";
import { Listing } from "./Listing";
import { Panes } from "./Layout";
import { TabStrip } from "./TabStrip";
import { XrefPanel } from "./XrefPanel";
import { allowsEdit, centreViews } from "../capabilities";
import { canForce, type TabsApi } from "./useTabs";
import type { Navigation } from "./features/navigation";
import type { Editing } from "./features/editing";
import type { Copying } from "./features/copy";
import { useProgram, useSession, useViews } from "./store/session";
import type { Views } from "./store/views";

/** The three panes (functions + map + references, listing, decompiler tabs) of the open program. Renders the stores and calls the feature hooks. */
export function Workbench({ tabs, nav, editing, copy, testMode }: { tabs: TabsApi; nav: Navigation; editing: Editing; copy: Copying; testMode: boolean }) {
  const s = useSession();
  const { caps, views, refs } = s;
  const program = useProgram((p) => p.program)!, map = useProgram((p) => p.map), funcs = useProgram((p) => p.funcs);
  const initialRows = useProgram((p) => p.initialRows), reading = useProgram((p) => p.reading), browseError = useProgram((p) => p.browseError);
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
  const centre = centreViews(caps, callGraphOn), graphEntry = active?.entry ?? fn?.entry; // without a decompiler there are no tabs: the call graph follows the current function
  const rowMenu = () => [
    { label: "Copy Address", run: () => void copy.copy("address") },
    ...(caps.has("bytes") ? [{ label: "Copy Bytes (Hex)", run: () => void copy.copy("bytes") }, { label: "Copy Bytes (C Array)", run: () => void copy.copy("carray") }] : []),
  ];

  if (!map) return (
    <div className="notice">
      {reading && <p role="status">Reading program…</p>}
      {browseError && <><p role="alert">Could not read the listing for {program.session.name}. {browseError}</p>
        <button disabled={busy || reading} onClick={() => void s.loadBrowsing(program)}>Retry listing</button></>}
    </div>
  );
  return (
    <Panes key={program.session.sessionId} visible={{ ...visible, decompiler: visible.decompiler && (centre.decompiler || centre.callGraph) }}>{{
      functions: (
        <div className="funcs-col">
          <div className="funcs-row">
            <BinaryMap map={map} funcs={funcs} here={here} covVersion={covVersion} onGo={(a) => go(a, "goto")} />
            <FunctionList searchSymbols={symbolSearch} funcs={funcs} selected={fn?.entry ?? null} onSelect={(e) => go(e, "functions")} menu={(e) => [{ label: "Copy Address", run: () => void copy.copy("address", e) }]} onPin={caps.has("decompile") ? (e) => { void go(e, "functions"); void tabs.show(e, true); } : undefined} />
          </div>
          {caps.has("references") && <XrefPanel references={ops.references} variableReferences={caps.has("variableReferences")} address={here} target={xrefTarget} version={xrefVersion} onGo={(a, use) => { set({ useHl: use ? { name: use.name, address: a } : null }); void go(a, "xrefs"); }} onFollow={() => set({ xrefTarget: null, useHl: null })} />}
        </div>
      ),
      listing: <Listing reader={ops.listing} initialRows={initialRows} testMode={testMode} rowRef={refs.listingRow} canEdit={(action) => allowsEdit(caps, action)} map={map} scrollReq={scrollReq} change={listingChange} topAddrRef={refs.topAddr} cursorRef={refs.cursor} onEdit={(a) => void editing.edit(a)} onLatency={(ms) => s.store.dispatch({ type: "stats", patch: { listingMs: ms } })} onError={s.fail} onRowClick={(a) => go(a, "listing")} onGo={(a) => go(a, "xrefs")} onXrefs={caps.has("references") ? (a) => set({ xrefTarget: { type: "address", address: a, label: a } }) : undefined} menu={rowMenu} />,
      decompiler: (centre.decompiler || centre.callGraph) && (
        <div className="dec">
          {centre.decompiler && <><TabStrip tabs={tabs.state} name={(e) => names.get(e) ?? e} onActivate={(id) => goTab(tabs.activate(id))} onClose={(id) => goTab(tabs.close(id))} onPin={tabs.pin} />
          {!active && <div className="empty">Select a function, click an address in the listing, or press G.</div>}
          {ad?.status === "loading" && <div className="empty">Decompiling…{ad.long && <button aria-label="Cancel decompile" onClick={() => tabs.cancel(active!.id)}>Cancel</button>}</div>}
          {ad?.status === "large" && <div className="empty" role="status">This function is {Math.round((ad.size ?? 0) / 1024)} KB: decompiling can take a minute or more.
            <button aria-label="Decompile anyway" onClick={() => tabs.decompileAnyway(active!.id)}>Decompile anyway</button></div>}
          {ad?.status === "error" && <div className="empty err">{ad.error}{canForce(ad) && <button aria-label="Decompile anyway" onClick={() => tabs.decompileAnyway(active!.id)}>Decompile anyway</button>}</div>}
          </>}
          {centre.decompiler && graphOn && active && <GraphView source={ops.decompiler.graph} entry={active.entry} here={here} version={dataVersion} covVersion={covVersion} onGo={(a) => go(a, "graph")} />}
          {centre.callGraph && graphEntry && <CallGraphView source={ops.references.callGraph} entry={graphEntry} funcs={funcs} version={dataVersion} covVersion={covVersion} onGo={(a) => go(a, "graph")} />}
          {centre.decompiler && <div className="editor" style={{ display: active && !graphOn && !callGraphOn ? undefined : "none" }}>
            <DecompilerWarnings warnings={ad?.status === "ready" ? ad.warnings ?? [] : []} />
            <div className="edwrap"><Decompiler canEdit={caps} tabId={active?.id ?? null} liveIds={tabs.state.tabs.map((t) => t.id)} text={ad?.text ?? ""} tokens={ad?.tokens ?? []} highlight={hlTokens} covVersion={covVersion} onCallClick={clickAt} editorRef={refs.editor} onEdit={(a) => void editing.edit(a)} canAt={editing.canAt} onXrefs={editing.showXrefs} onCopy={(w) => void copy.copy(w)} /></div>
          </div>}
        </div>
      ),
    }}</Panes>
  );
}
