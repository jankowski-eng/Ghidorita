import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Address, PcodeResult } from "../../../protocol";
import type { Decompilation } from "./backend";
import { isCancelled, isNoProgram } from "./scan";
import { linesAt, pcodeLines, type PcodeMode } from "./pcode";

const LH = 18;

/**
 * P-code of the function at `entry` (raw: Instruction.getPcode(); high: the decompiler's ops), text only, virtualised. It follows the shared cursor
 * (the lines of the cursor's instruction are marked and scrolled into view) and a click on a line moves it, so the listing, the C and the hex view follow.
 */
export function PcodeView({ source, entry, cursor, version, onGo }: { source: Decompilation["pcode"]; entry: Address; cursor: Address | null; version: number; onGo: (a: Address) => void }) {
  const [res, setRes] = useState<PcodeResult | null>(null), [err, setErr] = useState(""), [mode, setMode] = useState<PcodeMode>("high");
  useEffect(() => {
    let live = true;
    setErr(""); setRes(null); // never show the previous function's p-code under the new one
    const job = source({ entry });
    job.result.then((r) => { if (live) setRes(r); }, (e) => { if (live && !isCancelled(e) && !isNoProgram(e)) { setRes(null); setErr(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; job.cancel(); };
  }, [source, entry, version]);
  const lines = useMemo(() => (res ? pcodeLines(res, mode) : []), [res, mode]);
  const instrs = useMemo(() => (res ? res.raw.map((i) => ({ address: i.address, length: i.length })) : []), [res]);
  const cur = useMemo(() => linesAt(lines, cursor, instrs), [lines, cursor, instrs]);
  const box = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: lines.length, getScrollElement: () => box.current, estimateSize: () => LH, overscan: 20 });
  useEffect(() => { if (cur.length) v.scrollToIndex(cur[0], { align: "auto" }); }, [cur[0], lines]); // eslint-disable-line
  return (
    <div className="pcode" role="region" aria-label="P-code">
      <div className="ph-bar">
        <span role="group" aria-label="P-code level">
          {(["high", "raw"] as const).map((m) => <button key={m} aria-pressed={mode === m} className={mode === m ? "on" : ""} aria-label={m === "raw" ? "Raw p-code" : "High p-code"} onClick={() => setMode(m)}>{m === "raw" ? "Raw" : "High"}</button>)}
        </span>
        <span role="status" aria-label="P-code state" className={err ? "err" : ""}>{err || (res ? `${mode === "raw" ? res.raw.length + " instructions" : res.high.length + " ops"}${res.truncated ? " (cut)" : ""}` : "decompiling…")}</span>
      </div>
      <div className="pc-scroll" ref={box} tabIndex={0}>
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((it) => {
            const l = lines[it.index];
            return <div key={it.index} role="row" className={"pc-line" + (l.head ? " head" : "") + (cur.includes(it.index) ? " cur" : "")} aria-current={cur[0] === it.index ? "true" : undefined} tabIndex={l.address ? 0 : undefined} aria-label={l.address ? `${l.text} (Enter goes to ${l.address})` : undefined}
              style={{ position: "absolute", top: 0, left: 0, right: 0, height: LH, transform: `translateY(${it.start}px)` }} onClick={() => l.address && onGo(l.address)} onKeyDown={(e) => { if (l.address && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onGo(l.address); } }}>{l.text}</div>;
          })}
        </div>
      </div>
    </div>
  );
}
