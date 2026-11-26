import { debugLabel } from "./debug";
import { shownDebug } from "./store/program";
import { useProgram } from "./store/session";

/** The registers of the shown stop (the live one, or a recorded one); the ones whose value changed since the stop before are highlighted. */
export function RegistersPanel() {
  const d = useProgram(shownDebug), live = useProgram((p) => p.debug), last = useProgram((p) => p.debugLast), past = useProgram((p) => p.debugAt !== null);
  if (!d || d.state === "detached") return <div className="empty" role="status">{d?.error ?? "Not attached. Debug > Attach to QEMU…"}</div>;
  const regs = d.state === "stopped" ? d.registers ?? [] : Object.entries(last).map(([name, value]) => ({ name, value })); // while running: the values of the last stop
  return (
    <div className="regs" aria-label="Registers" aria-busy={d.state === "running"}>
      <div className="regs-h" role="status">{debugLabel(d)} · {d.target}{past && live ? ` · recorded stop, the target is at ${live.address ?? live.state}` : ""}</div>
      <div className="regs-grid">
        {regs.map((r) => (
          <div key={r.name} className={"reg" + (d.state === "running" ? " stale" : r.name in d.changed ? " changed" : "")} title={r.name in d.changed ? `changed, was ${d.changed[r.name]}` : undefined}>
            <span className="rn">{r.name}</span><span className="rv">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
