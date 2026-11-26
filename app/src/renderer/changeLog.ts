import type { Address } from "../../../protocol";

export interface Change { id: number; label: string; address?: Address; undone: boolean; saved: boolean; at: number }

/** One line per edit RPC; null = not an edit. Params are the request's own. */
export function describe(method: string, p: any): { label: string; address?: Address } | null {
  switch (method) {
    case "rename_symbol": return { label: `Rename to ${p.newName}`, address: p.address };
    case "create_label": return { label: `Label ${p.name}`, address: p.address };
    case "set_comment": return { label: p.text ? `Comment (${p.kind})` : `Clear comment (${p.kind})`, address: p.address };
    case "create_function": return { label: `Create function${p.name ? " " + p.name : ""}`, address: p.address };
    case "set_function_signature": return { label: `Signature ${p.signature}`, address: p.entry };
    case "rename_variable": return { label: `Rename ${p.name} to ${p.newName}`, address: p.entry };
    case "retype_variable": return { label: `Retype ${p.name} as ${p.dataType}`, address: p.entry };
    case "define_data": return { label: `Define ${p.dataType}`, address: p.address };
    case "clear_code": return { label: "Clear code", address: p.address };
    case "create_struct_from_data": return { label: `Structure ${p.name} from data`, address: p.address };
    case "auto_create_structure": return { label: `Auto structure ${p.structName ?? ""}`.trim(), address: p.entry };
    case "create_data_type": return { label: `Create ${p.kind}${p.name ? " " + p.name : ""}` };
    case "delete_data_type": return { label: `Delete type ${p.path}` };
    case "rename_data_type": return { label: `Rename type ${p.path} to ${p.newName}` };
    case "edit_struct": return { label: `Edit structure ${p.path}` };
    case "edit_enum": return { label: `Edit enum ${p.path}` };
    default: return null;
  }
}

/**
 * Session log of edits, fed from every RPC (see client.ts). Mirrors Ghidra's undo stack: undo/redo flip entries, a new edit drops the undone ones,
 * and a save that wrote freezes what came before (Ghidra drops its history on save). shortcut: kept in memory per open program, lost on reload; upgrade to a sidecar-side log if it must survive restarts.
 */
export class ChangeLog {
  items: Change[] = [];
  private redo: number[] = [];
  private n = 0;
  private subs = new Set<() => void>();
  subscribe = (f: () => void) => { this.subs.add(f); return () => { this.subs.delete(f); }; };
  getSnapshot = () => this.items;
  private set(items: Change[]) { this.items = items; this.subs.forEach((f) => f()); }
  clear() { this.redo = []; this.set([]); }
  record(method: string, p: any, result: any) {
    if (method === "open_binary" || method === "close_program") return this.clear();
    if (method === "save") { if (result?.saved) { this.redo = []; this.set(this.items.filter((c) => !c.undone).map((c) => ({ ...c, saved: true }))); } return; }
    if (method === "undo") {
      const c = [...this.items].reverse().find((x) => !x.undone && !x.saved);
      if (c) { this.redo.push(c.id); this.set(this.items.map((x) => (x === c ? { ...x, undone: true } : x))); }
      return;
    }
    if (method === "redo") {
      const id = this.redo.pop();
      if (id !== undefined) this.set(this.items.map((x) => (x.id === id ? { ...x, undone: false } : x)));
      return;
    }
    const d = describe(method, p);
    if (!d) return;
    this.redo = [];
    this.set([...this.items.filter((c) => !c.undone), { id: ++this.n, ...d, undone: false, saved: false, at: Date.now() }]);
  }
}

export const changeLog = new ChangeLog();
