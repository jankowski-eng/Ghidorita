import type { Methods, Notifications } from "../../../protocol";

/** `code` is an ErrorCode from protocol.ts. */
export class RpcError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

/** What the UI needs from the sidecar; transport details (connect, ids) stay in the implementation. */
export interface Backend {
  call<M extends keyof Methods>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]>;
  /** Like call(), plus a fire-and-forget cancel(). Only supported for methods the sidecar can cancel (decompile). */
  callCancellable<M extends keyof Methods>(method: M, params: Methods[M]["params"]): { result: Promise<Methods[M]["result"]>; cancel(): void };
  onNotification: <N extends keyof Notifications>(method: N, params: Notifications[N]) => void; // assignable callback, as before
}
