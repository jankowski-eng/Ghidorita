import { useEffect, useRef, useState } from "react";
import type { ProgramEntry } from "../../../protocol";
import { isFailure } from "./backend";
import { Confirm } from "./Confirm";
import { latest } from "./latest";
import { useProgram, useSession } from "./store/session";
import { Welcome } from "./Welcome";

/** Shown while no program is open: the hint and (when the provider keeps a project) the program browser with its delete confirmation. */
export function WelcomePane() {
  const s = useSession();
  const projects = s.caps.has("projects");
  const opening = useProgram((p) => !!p.opening);
  const [progs, setProgs] = useState<{ list: ProgramEntry[]; loading: boolean; error: string }>({ list: [], loading: false, error: "" });
  const [version, setVersion] = useState(0);
  const [deleting, setDeleting] = useState<{ entry: ProgramEntry; error: string; busy: boolean } | null>(null);
  const run = useRef(latest()).current;

  // program browser: refresh whenever the welcome state is (re)entered (start, after close, after a failed open)
  useEffect(() => {
    if (opening || !projects) return;
    setProgs((x) => ({ ...x, loading: true, error: "" }));
    run(s.backend.projects.list()).then((l) => { if (l) setProgs({ list: l, loading: false, error: "" }); }, (e) => setProgs({ list: [], loading: false, error: e instanceof Error ? e.message : String(e) }));
  }, [opening, version]); // eslint-disable-line

  const deleteStored = async () => {
    if (!deleting) return;
    setDeleting({ ...deleting, busy: true, error: "" });
    try { await s.backend.projects.remove({ programId: deleting.entry.programId }); setDeleting(null); setVersion((v) => v + 1); }
    catch (e) {
      if (isFailure(e, "notFound")) { setDeleting(null); setVersion((v) => v + 1); } // already gone
      else setDeleting((d) => d && { ...d, busy: false, error: isFailure(e, "busy") ? "The sidecar is busy; try again in a moment." : e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <>
      {deleting && <Confirm title="Delete program?" message={`Remove ${deleting.entry.name} from the project? Its analysis is deleted; the original file is not touched.`} error={deleting.error} busy={deleting.busy}
        actions={[{ label: "Delete", onClick: () => void deleteStored() }]} onCancel={() => setDeleting(null)} />}
      <div className="notice">
        <p>{projects ? "Open a binary to begin (File → Open Binary…, Cmd+O), or reopen a program below." : "Open a file to browse its listing."}</p>
        {projects && <Welcome programs={progs.list} loading={progs.loading} error={progs.error} onOpen={(entry) => void s.openStored(entry)} onFull={(entry) => void s.openStored(entry, "full")} onDelete={(entry) => setDeleting({ entry, error: "", busy: false })} />}
      </div>
    </>
  );
}
