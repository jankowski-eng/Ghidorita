import { shownDebug } from "./store/program";
import { useProgram } from "./store/session";

/** The variables of the function at the shown stop with their values; a value that differs from the stop before shows what it was. */
export function LocalsPanel() {
  const d = useProgram(shownDebug);
  if (!d || d.state !== "stopped") return <div className="empty" role="status">{d?.state === "running" ? "Running…" : "Not stopped in a function."}</div>;
  if (!d.values) return <div className="empty" role="status">No variables known for this stop (no decompiled function here, or reading them failed).</div>;
  const { items, was } = d.values;
  return (
    <div className="regs" aria-label="Locals">
      <table className="vals"><thead><tr><th>name</th><th>type</th><th>value</th><th>was</th><th>where</th></tr></thead>
        <tbody>{items.map((i) => {
          const before = was[i.name], changed = before !== undefined && before !== i.value;
          return <tr key={i.kind + i.name} className={changed ? "changed" : ""}><td>{i.name}</td><td>{i.type}</td><td>{i.value}</td><td>{changed ? before : ""}</td><td title={/^(stack|0x)/.test(i.where) ? undefined : "a register: only right where the decompiler keeps this variable in it"}>{i.where}</td></tr>;
        })}</tbody></table>
    </div>
  );
}
