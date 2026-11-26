import { useEffect, useState } from "react";
import { dropBlock } from "../dropAllowed";
import { useSession } from "../store/session";
import { requestOpen } from "./dialogs";

const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");

/** Dropping a file anywhere opens it like File > Open Binary (import card first). Returns whether a drag is over the window (for the overlay). */
export function useDropOpen() {
  const s = useSession();
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0; // dragenter/leave also fire for every child element
    const on = (t: string, f: (e: DragEvent) => void) => { window.addEventListener(t, f as EventListener); return () => window.removeEventListener(t, f as EventListener); };
    const offs = [
      on("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; setOver(true); }),
      on("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); }), // also stops the default navigation to the file
      on("dragleave", (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setOver(false); } }),
      on("drop", (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); depth = 0; setOver(false);
        const files = [...(e.dataTransfer?.files ?? [])];
        const st = s.store.getState();
        const why = dropBlock({ opening: !!st.opening, closing: st.closing, unavailable: st.unavailable, modal: !!document.querySelector('[aria-modal="true"]') });
        if (why) { s.setNotice(why); return; }
        void window.host.checkDrop(files).then((r) => { if ("error" in r) s.setNotice(r.error); else { s.setNotice(""); requestOpen(s, r.path); } }, (err) => s.setNotice(String(err)));
      }),
    ];
    return () => offs.forEach((f) => f());
  }, [s]);
  return over;
}

/** Full-window hint while a file is dragged over. The browser hides the file's name until the drop. */
export function DropOverlay({ show }: { show: boolean }) {
  return show ? <div className="dropveil" role="status" aria-live="polite"><div>Drop to open</div></div> : null;
}
