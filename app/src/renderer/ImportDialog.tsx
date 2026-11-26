import { isFailure, type ImportSelection } from "./backend";
import { fmtSize } from "./format";
import { useEffect, useMemo, useState } from "react";
import type { AnalysisProfile, FileLayout, ImportCandidate, ImportOptions, LanguageInfo } from "../../../protocol";
import { trapTab, useRestoreFocus } from "./hooks";
import { buildOptions, choiceError, entropyHint, parseBase } from "./openOptions";

const label = (c: ImportCandidate) => `${c.loader}${c.language ? ` — ${c.language} / ${c.compilerSpec}` : c.requiresLanguage === false ? "" : " — choose language"}${c.preferred ? " (preferred)" : ""}`;
const errText = (e: unknown) => isFailure(e, "busy") ? "The backend is busy. Try again in a moment." : isFailure(e, "notFound") ? "File not found." : e instanceof Error ? e.message : String(e);

/** Shows the provider’s import choices. Enter = open with the preselected (default) choice. */
export function ImportDialog({ imports, path, onOpen, onCancel }: { imports: ImportSelection; path: string; onOpen: (o: ImportOptions | undefined) => void; onCancel: () => void }) {
  useRestoreFocus();
  const [state, setState] = useState<{ cands: ImportCandidate[]; langs: LanguageInfo[]; note?: string; entropy: number[]; sizeBytes: number; profiles?: { id: AnalysisProfile; label: string }[]; layout: FileLayout | null } | { error: string } | null>(null);
  const [idx, setIdx] = useState(0);
  const [language, setLanguage] = useState<string | null>(null);
  const [spec, setSpec] = useState<string | null>(null);
  const [base, setBase] = useState("");
  const [filter, setFilter] = useState("");
  const [profile, setProfile] = useState<AnalysisProfile>();
  const [adv, setAdv] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const { candidates: cands, sizeBytes, entropy, profiles, defaultProfile, note, layout } = await imports.choices({ path });
      const langs = await imports.languages().catch(() => [] as LanguageInfo[]); // optional unless the user must choose
      if (!live) return;
      const pre = Math.max(0, cands.findIndex((c) => c.preferred));
      setProfile(defaultProfile ?? profiles?.[0]?.id); setIdx(pre); setLanguage(cands[pre]?.language ?? null); setSpec(cands[pre]?.compilerSpec ?? null);
      setState({ cands, langs, note, entropy, sizeBytes, profiles, layout: layout ?? null });
    })().catch((e) => { if (live) setState({ error: errText(e) }); });
    return () => { live = false; };
  }, [imports, path]);

  const ready = state && "cands" in state ? state : null;
  const cand = ready?.cands[idx];
  const choice = cand && { cand, language, compilerSpec: spec, base, profile };
  const err = choice ? choiceError(choice) : "not ready";
  const specs = useMemo(() => ready?.langs.find((l) => l.id === language)?.compilerSpecs ?? (cand?.compilerSpec && language === cand.language ? [{ id: cand.compilerSpec, name: cand.compilerSpec }] : []), [ready, language, cand]);
  const langs = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (ready?.langs ?? []).filter((l) => !f || l.id.toLowerCase().includes(f) || l.description.toLowerCase().includes(f));
  }, [ready, filter]);
  const pick = (i: number) => { const c = ready!.cands[i]; setIdx(i); setLanguage(c.language); setSpec(c.compilerSpec); };
  const submit = () => { if (choice && !err) onOpen(buildOptions(choice)); };
  const baseErr = cand?.acceptsBaseAddress && base.trim() ? (() => { const b = parseBase(base); return b.ok ? "" : b.error; })() : "";

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Import binary" onKeyDown={(e) => {
      trapTab(e);
      if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
      else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); submit(); }
    }}>
      <div className="card wide">
        <div className="title">Import {path.split("/").pop()}</div>
        {!state && <div role="status">Checking file formats…</div>}
        {state && "error" in state && <div className="err" role="alert">{state.error}</div>}
        {ready?.note && <div role="status">{ready.note}</div>}
        {ready && cand && <>
          {ready.entropy.length > 0 && <div className="triage" role="img" aria-label={`Entropy by file position. ${entropyHint(ready.entropy)}`}>
            <div className="ebars">{ready.entropy.map((x, i) => <span key={i} title={`${x} bits/byte`} style={{ height: `${Math.round((x / 8) * 100)}%`, background: x >= 7.5 ? "#e0a93b" : "#5a8f6a" }} />)}</div>
            <span className="meta">{fmtSize(ready.sizeBytes)} · {entropyHint(ready.entropy)}</span>
          </div>}
          <dl className="card-facts" aria-label="File summary">
            <dt>Format</dt><dd>{cand.loader}{cand.preferred ? "" : " (not the preferred loader)"}</dd>
            <dt>Architecture</dt><dd>{language ? `${language}${spec ? ` / ${spec}` : ""}` : "not chosen yet"}</dd>
            <dt>Size</dt><dd>{fmtSize(ready.sizeBytes)}</dd>
            {ready.layout?.entry && <><dt>Entry point</dt><dd>{ready.layout.entry}</dd></>}
            {profile && <><dt>Analysis</dt><dd>{state && "profiles" in state ? state.profiles?.find((p) => p.id === profile)?.label ?? profile : profile}</dd></>}
          </dl>
          {!!ready.layout?.sections.length && <table className="secs" aria-label="Sections"><tbody>
            {ready.layout.sections.map((x, i) => <tr key={i}><td>{x.name}</td><td>{fmtSize(x.size)}</td><td title={`${x.entropy} bits/byte`}><span className="ebar" style={{ width: `${Math.round((x.entropy / 8) * 100)}%`, background: x.entropy >= 7.5 ? "#e0a93b" : "#5a8f6a" }} /></td></tr>)}
          </tbody></table>}
          {!language && <div className="err" role="status">This format needs a language: open Advanced options and choose one.</div>}
          <button type="button" aria-expanded={adv || !language} onClick={() => setAdv(!adv)}>{adv || !language ? "Hide advanced options" : "Advanced options…"}</button>
          <div hidden={!(adv || !language)} className="adv">
          <label>Loader
            <select aria-label="Loader" value={idx} onChange={(e) => pick(+e.target.value)}>
              {ready.cands.map((c, i) => <option key={i} value={i}>{label(c)}</option>)}
            </select>
          </label>
          {cand.requiresLanguage !== false && <><label>Language
            <input aria-label="Filter languages" placeholder="filter, e.g. arm or x86" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          {ready.langs.length > 0
            ? <select aria-label="Language" size={6} value={language ?? ""} onChange={(e) => { setLanguage(e.target.value); setSpec(null); }}>
                {!language && <option value="" disabled>(choose a language)</option>}
                {langs.map((l) => <option key={l.id} value={l.id}>{l.id} — {l.description}</option>)}
              </select>
            : <div className="msg">{language ? `Language: ${language}` : "The language list is unavailable."}</div>}</>}
          {specs.length > 0 && <label>Compiler
            <select aria-label="Compiler spec" value={spec ?? ""} onChange={(e) => setSpec(e.target.value || null)}>
              <option value="">(default)</option>
              {specs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>}
          {cand.acceptsBaseAddress && <label>Base address (optional)
            <input aria-label="Base address" aria-invalid={!!baseErr} placeholder="0x00400000" value={base} onChange={(e) => setBase(e.target.value)} />
          </label>}
          {baseErr && <div className="err" role="alert">{baseErr}</div>}
          {!!ready.profiles?.length && <label>Analysis
            <select aria-label="Analysis profile" value={profile ?? ""} onChange={(e) => setProfile(e.target.value as AnalysisProfile)}>
              {ready.profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>}
          </div>
        </>}
        <div className="row">
          <button className="primary" autoFocus disabled={!!err} onClick={submit}>Open</button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
