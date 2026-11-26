import type { Session } from "../store/session";

/** File > Export: ask for a path, then let the provider write the symbol map or the C header. */
export async function exportAs(s: Session, kind: "symbols" | "header") {
  const program = s.program();
  if (!program || s.store.getState().opening || !s.caps.has("export")) return;
  const base = program.session.name.replace(/[\\/]/g, "_"), path = await window.host.pickSavePath(kind === "symbols" ? `${base}.symbols.json` : `${base}.h`);
  if (!path) return;
  try {
    if (kind === "symbols") { const r = await program.api.exports.symbols({ path }); s.flash(`Exported ${r.functions} functions, ${r.labels} labels, ${r.data} data, ${r.comments} comments to ${r.path}`); }
    else { const r = await program.api.exports.header({ path }); s.flash(`Exported ${r.types} types and ${r.functions} prototypes to ${r.path}${r.skipped ? ` (${r.skipped} names are not C identifiers)` : ""}`); }
  } catch (e) { s.fail(e); }
}
