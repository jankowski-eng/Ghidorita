import type { Address, FunctionInfo } from "../../../protocol";
import { coverage } from "./coverage";

const n = (v: bigint) => v.toLocaleString();

/** Coverage runs: load several files, name them, show one (A) or two (A vs B) in the listing and on the binary map. */
export function CoveragePanel({ version, funcs, onGo, onLoad, onChange }: { version: number; funcs: FunctionInfo[]; onGo: (a: Address) => void; onLoad: () => void; onChange: () => void }) {
  const runs = coverage.runs, d = coverage.diff(), fd = coverage.funcDiff(funcs);
  const set = (f: () => void) => { f(); onChange(); };
  const pick = (slot: "a" | "b") => (
    <select aria-label={slot === "a" ? "Run A" : "Run B"} value={coverage[slot] ?? ""} onChange={(e) => set(() => coverage.select(slot, e.target.value ? Number(e.target.value) : null))}>
      <option value="">{slot === "a" ? "(none)" : "(none: show A alone)"}</option>
      {runs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
    </select>
  );
  return (
    <div className="panel" role="region" aria-label="Coverage" data-version={version}>
      <div className="ph-bar">
        <button onClick={onLoad}>Load coverage…</button>
        <label className="chip">A {pick("a")}</label>
        <label className="chip">B {pick("b")}</label>
        <button onClick={() => set(() => coverage.clear())} disabled={!runs.length}>Clear all</button>
        <span role="status" aria-label="Coverage difference">
          {d ? `only A ${n(d.onlyA)} B · only B ${n(d.onlyB)} B · both ${n(d.both)} B` : runs.length ? "pick two runs to compare" : "no coverage loaded"}
        </span>
      </div>
      {fd && (
        <div className="covfuncs">
          {([["only A", fd.onlyA], ["only B", fd.onlyB]] as const).map(([label, fs]) => (
            <div key={label} role="list" aria-label={`Functions reached ${label}`}>
              <div className="dim">{label}: {fs.length} functions</div>
              {fs.map((f) => <div key={f.entry} role="listitem"><button className="lnk" onClick={() => onGo(f.entry)}>{f.name}</button> <span className="dim">{f.entry}</span></div>)}
            </div>
          ))}
        </div>
      )}
      <div className="covlist" role="list" aria-label="Coverage runs">
        {runs.map((r) => (
          <div key={r.id} role="listitem" className="covrun">
            <input aria-label={`Name of run ${r.id}`} defaultValue={r.name} onBlur={(e) => set(() => coverage.rename(r.id, e.target.value))} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
            <span className="dim">{r.cov.size} ranges · {n(r.cov.bytes())} bytes</span>
            <button aria-label={`Show ${r.name} as A`} aria-pressed={coverage.a === r.id} onClick={() => set(() => coverage.select("a", r.id))}>A</button>
            <button aria-label={`Show ${r.name} as B`} aria-pressed={coverage.b === r.id} onClick={() => set(() => coverage.select("b", r.id))}>B</button>
            <button aria-label={`Remove ${r.name}`} onClick={() => set(() => coverage.remove(r.id))}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}
