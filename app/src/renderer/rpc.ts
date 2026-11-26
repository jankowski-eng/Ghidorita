import type { Methods, Notifications } from "../../../protocol";
import { RpcError, type Backend } from "./backend";


type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class WebSocketBackend implements Backend {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  onNotification: <N extends keyof Notifications>(method: N, params: Notifications[N]) => void = () => {};

  connect(port: number, token: string): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/${token}`);
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.id === undefined) return this.onNotification(msg.method, msg.params);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new RpcError(msg.error.code, msg.error.message)) : p.resolve(msg.result);
    };
    this.ws.onclose = () => { for (const p of this.pending.values()) p.reject(new Error("socket closed")); this.pending.clear(); };
    return new Promise((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error("ws connect failed")); });
  }

  call<M extends keyof Methods>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]> {
    return this.send(this.nextId++, method, params);
  }

  callCancellable<M extends keyof Methods>(method: M, params: Methods[M]["params"]) {
    // decompile, variable_uses: cancel_decompile; the scan requests (symbols, strings, searches): cancel_search
    const cancelWith = method === "decompile" || method === "variable_uses" ? "cancel_decompile" : ["list_symbols", "list_strings", "search_symbols", "search_memory", "list_data_types"].includes(method) ? "cancel_search" : null;
    if (!cancelWith) throw new Error(`${method} is not cancellable`);
    const id = this.nextId++;
    return { result: this.send(id, method, params), cancel: () => { this.send(this.nextId++, cancelWith, { id }).catch(() => {}); } };
  }

  private send<M extends keyof Methods>(id: number, method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) return reject(new Error("socket closed")); // send() on a closed socket drops silently: the call would never settle
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); } catch (e) { this.pending.delete(id); reject(e); } // closed socket
    });
  }
}
