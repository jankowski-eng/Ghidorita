import type { Address } from "../../../../protocol";
import { allowsCommand } from "../../capabilities";
import { addressAtCursor, BYTES_MAX, cArray } from "../copy";
import { copyText } from "../clipboard";
import { tokenAt } from "../editActions";
import { useSession } from "../store/session";
import type { TabsApi } from "../useTabs";
import { focusKind } from "./editing";

export type CopyWhat = "address" | "bytes" | "carray" | "decompiled";

/**
 * Copy actions: the address, the bytes (hex or a C array) and the decompiled text of what the cursor is on. From a context menu, the Edit menu, the command bar.
 * Cmd+C itself stays the focused control's own copy (Monaco copies its selection).
 * shortcut: the listing has no multi-row selection, so bytes are those of the cursor row only; upgrade when the listing gets a selection (get_bytes takes any range).
 */
export function useCopy(tabs: TabsApi) {
  const s = useSession();
  const { refs, caps, views, store } = s;
  const activeTab = () => tabs.state.tabs.find((x) => x.id === tabs.state.active) ?? null;

  /** `at`: a row or entry the caller already knows (a context menu); otherwise the focused pane decides. */
  const copy = async (what: CopyWhat, at?: Address) => {
    const current = s.program();
    const cmd = { type: "copy", what } as const;
    if (!current || s.blocked() || views.getState().importFor || !allowsCommand(caps, cmd)) return;
    const kind = focusKind(document.activeElement);
    if (kind === "input" && !at) return; // a text field's own shortcuts and selection are not ours
    const inDecompiler = kind === "decompiler" || (kind === "other" && !document.activeElement?.closest(".funcs") && refs.lastPane.current === "decompiler");
    const tab = activeTab(), d = tab ? tabs.data[tab.id] : undefined;
    await s.send(async () => {
      if (what === "decompiled") {
        if (d?.status !== "ready" || !d.text) return s.flash("No decompiled function to copy.");
        await copyText(d.text); return s.flash(`Copied decompiled function (${d.text.split("\n").length} lines)`);
      }
      if (what === "address") {
        let a = at;
        if (!a && inDecompiler && tab && d) {
          const pos = refs.editor.current?.getPosition();
          if (pos) a = addressAtCursor(tokenAt(d.tokens, pos.lineNumber, pos.column), d.tokens, pos.lineNumber - 1, tab.entry);
        }
        a ??= kind === "listing" ? refs.listingRow.current?.()?.address : views.getState().fn?.entry;
        if (!a) return s.flash("No address to copy here.");
        await copyText(a); return s.flash(`Copied address ${a}`);
      }
      const row = refs.listingRow.current?.();
      if (!row) return s.flash("Put the cursor on a listing row to copy its bytes.");
      if (row.length > BYTES_MAX) return s.flash(`That row is ${row.length} bytes; at most ${BYTES_MAX} can be copied.`);
      const hex = row.bytesMore ? (await current.api.listing.bytes({ address: row.address, length: row.length })).bytes : row.bytes;
      await copyText(what === "bytes" ? hex : cArray(hex));
      s.flash(`Copied ${row.length} byte${row.length === 1 ? "" : "s"} at ${row.address} as ${what === "bytes" ? "hex" : "a C array"}`);
    });
  };
  return { copy };
}
export type Copying = ReturnType<typeof useCopy>;
