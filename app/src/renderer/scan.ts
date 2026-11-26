import type { Methods } from "../../../protocol";
import { rpc } from "./client";
import { RpcError } from "./backend";

/** Scan requests (list_symbols, list_strings, search_memory) that can be cancelled together: the panel cancels its stale ones when its query changes. */
export function scanner() {
  const live = new Set<() => void>();
  return {
    call<M extends keyof Methods>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]> {
      const { result, cancel } = rpc.callCancellable(method, params);
      live.add(cancel);
      return result.finally(() => live.delete(cancel));
    },
    cancelAll() { for (const c of live) c(); live.clear(); },
  };
}
export const isCancelled = (e: unknown) => e instanceof RpcError && e.code === -32002;
export const isNoProgram = (e: unknown) => e instanceof RpcError && e.code === -32001;
