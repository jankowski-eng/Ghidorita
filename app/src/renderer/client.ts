import { WebSocketBackend } from "./rpc";
import type { Backend } from "./backend";
import { changeLog } from "./changeLog";

/** The one connection to the sidecar. `ws` is only for the place that connects; UI code uses `rpc`. */
export const ws = new WebSocketBackend();
// every successful request feeds the edit log (changeLog.ts)
const call = ws.call.bind(ws);
ws.call = (method, params) => { const r = call(method, params); r.then((res) => changeLog.record(method, params, res), () => {}); return r; };
export const rpc: Backend = ws;
