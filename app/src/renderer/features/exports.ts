import type { Session } from "../store/session";

/** File > Export: ask for a path, then let the provider write the symbol map, the C header or the Ghidra archive. */
export async function exportAs(s: Session, kind: "symbols" | "header" | "gzf") {
  const program = s.program();
  if (!program || s.store.getState().opening || !s.caps.has(kind === "gzf" ? "exportGzf" : "export")) return;
  const base = program.session.name.replace(/[\\/]/g, "_"), file = { symbols: `${base}.symbols.json`, header: `${base}.h`, gzf: `${base}.gzf` }[kind];
  const path = await window.host.pickSavePath(file);
  if (!path) return;
  try {
    if (kind === "symbols") { const r = await program.api.exports.symbols({ path }); s.flash(`Exported ${r.functions} functions, ${r.labels} labels, ${r.data} data, ${r.comments} comments to ${r.path}`); }
    else if (kind === "gzf") { const r = await program.api.exports.gzf({ path }); s.flash(`Exported Ghidra archive (${(r.bytes / 1048576).toFixed(1)} MB) to ${r.path}`); }
    else { const r = await program.api.exports.header({ path }); s.flash(`Exported ${r.types} types and ${r.functions} prototypes to ${r.path}${r.skipped ? ` (${r.skipped} names are not C identifiers)` : ""}`); }
  } catch (e) { s.fail(e); }
}
