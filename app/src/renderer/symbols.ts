import type { Address } from "../../../protocol";
import type { FunctionNavigation } from "./backend";
import { offIn, parseAddr } from "./address";

export type FuncAt = Awaited<ReturnType<FunctionNavigation["containing"]>> & {};

/** Cache exact addresses within the active session. Function bodies may have gaps or be noncontiguous. */
export function functionLookup(reader: FunctionNavigation) {
  const last = new Map<string, FuncAt | null>();
  let generation = 0;
  return {
    clear() { last.clear(); generation++; },
    async containing(address: Address): Promise<FuncAt | null> {
      const p = parseAddr(address);
      if (!p) return null;
      const key = p.space + "/" + p.off;
      if (last.has(key)) return last.get(key)!;
      const current = generation;
      const f = await reader.containing({ address });
      if (current === generation) {
        if (last.size >= 128) last.delete(last.keys().next().value!);
        last.set(key, f);
        if (f && offIn(f.entry, p.space) !== null && last.size < 128) {
          last.set(p.space + "/" + offIn(f.entry, p.space), f);
        }
      }
      return f;
    },
  };
}
