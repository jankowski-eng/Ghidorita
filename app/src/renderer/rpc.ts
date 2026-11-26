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
    // shortcut: only decompile is cancellable server-side (cancel_decompile); extend when the sidecar cancels more
    if (method !== "decompile") throw new Error(`${method} is not cancellable`);
    const id = this.nextId++;
    return { result: this.send(id, method, params), cancel: () => { this.send(this.nextId++, "cancel_decompile", { id }).catch(() => {}); } };
  }

  private send<M extends keyof Methods>(id: number, method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
}
