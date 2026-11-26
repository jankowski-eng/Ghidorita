import { WebSocketBackend } from "./rpc";
import type { Backend } from "./backend";

/** The one connection to the sidecar. `ws` is only for the place that connects; UI code uses `rpc`. */
export const ws = new WebSocketBackend();
export const rpc: Backend = ws;
