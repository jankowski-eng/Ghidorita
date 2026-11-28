import type { Address } from "../../../protocol";
import { agentOf } from "../agent/attribution";

/** locked: unsaved, but the provider's undo history no longer holds it. by: the MCP client that made it (absent = the user) */
export interface Change { id: number; label: string; address?: Address; undone: boolean; saved: boolean; locked?: boolean; at: number; by?: string; undoName?: string } // undoName: the provider's name for the undo step this edit committed (the edit result's `undoName`)

/** One line per edit command; null = not an edit. Params are the request's own. */
export function describe(method: string, p: any): { label: string; address?: Address } | null {
  switch (method) {
    case "renameSymbol": return { label: `Rename to ${p.newName}`, address: p.address };
    case "createLabel": return { label: `Label ${p.name}`, address: p.address };
    case "setComment": return { label: p.text ? `Comment (${p.kind})` : `Clear comment (${p.kind})`, address: p.address };
    case "createFunction": return { label: `Create function${p.name ? " " + p.name : ""}`, address: p.address };
    case "setFunctionSignature": return { label: `Signature ${p.signature}`, address: p.entry };
    case "renameVariable": return { label: `Rename ${p.name} to ${p.newName}`, address: p.entry };
    case "retypeVariable": return { label: `Retype ${p.name} as ${p.dataType}`, address: p.entry };
    case "setEquate": return { label: `Equate ${p.name}`, address: p.address };
    case "setFunctionNoReturn": return { label: p.noReturn === false ? "Clear no return" : "Mark no return", address: p.entry };
    case "splitVariable": return { label: `Split out ${p.name} as ${p.newName}`, address: p.entry };
    case "forceUnionField": return { label: `Force field ${p.field ?? "(none)"}`, address: p.entry };
    case "defineData": return { label: `Define ${p.dataType}`, address: p.address };
    case "clearCode": return { label: "Clear code", address: p.address };
    case "createStructFromData": return { label: `Structure ${p.name} from data`, address: p.address };
    case "autoCreateStructure": return { label: `Auto structure ${p.structName ?? ""}`.trim(), address: p.entry };
    case "patchInstruction": return { label: `Patch ${p.bytes}`, address: p.address };
    case "setBookmark": return { label: `Bookmark ${p.category ? p.category : "(no category)"}`, address: p.address };
    case "removeBookmark": return { label: `Remove bookmark${p.category ? " " + p.category : ""}`, address: p.address };
    case "createDataType": return { label: `Create ${p.kind}${p.name ? " " + p.name : ""}` };
    case "deleteDataType": return { label: `Delete type ${p.path}` };
    case "renameDataType": return { label: `Rename type ${p.path} to ${p.newName}` };
    case "editStruct": return { label: `Edit structure ${p.path}` };
    case "editEnum": return { label: `Edit enum ${p.path}` };
    default: return null;
  }
}

/**
 * Session-local log of successful edit commands. Undo/redo flip entries and a new edit drops undone entries.
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
  /**
   * The provider's history is the truth. When it holds nothing (an analysis cleared it and saved: the edits are in the file; or it cleared it and
   * the save failed: they are not) no listed edit can be undone or redone any more.
   */
  reconcile(u: { canUndo: boolean; canRedo: boolean; dirty: boolean }) {
    if (u.canUndo || u.canRedo) return;
    const next = this.items.filter((c) => !c.undone).map((c) => (c.saved ? c : u.dirty ? (c.locked ? c : { ...c, locked: true }) : { ...c, saved: true, locked: false }));
    if (next.length === this.items.length && next.every((c, i) => c === this.items[i])) return;
    this.redo = [];
    this.set(next);
  }
  record(method: string, p: any, result: any) {
    if (method === "save") { if (result?.undoHistoryCleared) { this.redo = []; this.set(this.items.filter((c) => !c.undone).map((c) => ({ ...c, saved: true }))); } return; }
    if (method === "undo") {
      const c = [...this.items].reverse().find((x) => !x.undone && !x.saved && !x.locked);
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
    const by = agentOf(p), undoName = typeof result?.undoName === "string" ? result.undoName : undefined;
    this.set([...this.items.filter((c) => !c.undone), { id: ++this.n, ...d, undone: false, saved: false, at: Date.now(), ...(by ? { by } : {}), ...(undoName ? { undoName } : {}) }]);
  }
}

export const changeLog = new ChangeLog();
