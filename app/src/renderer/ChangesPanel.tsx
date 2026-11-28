import { useSyncExternalStore } from "react";
import type { Address } from "../../../protocol";
import { agentName } from "../agent/attribution";
import { changeLog } from "./changeLog";
import { agentStatus } from "./features/agent";
import { useStore } from "./store/createStore";

/** Edits made in this session, newest first. Click one to go there. Undone edits stay listed (dimmed) until a new edit replaces them. */
export function ChangesPanel({ onGo }: { onGo: (a: Address) => void }) {
  const items = useSyncExternalStore(changeLog.subscribe, changeLog.getSnapshot);
  const liveClients = useStore(agentStatus, (s) => s.state.clients); // stable array: ids of the connected agents
  const live = items.filter((c) => !c.undone);
  return (
    <div className="changes" aria-label="Changes">
      <div className="msg" role="status">{live.length ? `${live.length} change${live.length === 1 ? "" : "s"} since the program was opened (${live.filter((c) => !c.saved).length} unsaved)` : "No changes yet."}</div>
      <ul>
        {[...items].reverse().map((c) => (
          <li key={c.id} className={c.undone ? "undone" : ""}>
            <button disabled={!c.address} onClick={() => c.address && onGo(c.address)}>
              <span className="t">{new Date(c.at).toLocaleTimeString()}</span>
              <span className="n">{c.label}{c.by ? ` · ${agentName(c.by, liveClients)}` : ""}</span>
              <span className="a">{c.address ?? ""}{c.undone ? " · undone" : c.saved ? " · saved" : c.locked ? " · unsaved, can no longer be undone" : ""}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
