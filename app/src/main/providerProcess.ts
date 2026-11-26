import { spawn, type ChildProcess } from "node:child_process";
import { accessSync } from "node:fs";
import { createInterface } from "node:readline";
import type { ProviderLaunch } from "./providers";

const STARTUP_MS = 90_000;
const KILL_GRACE_MS = 60_000;

export class ProviderProcess {
  private child: ChildProcess | undefined;
  private stopping: Promise<number> | undefined;
  private get alive() { return !!this.child && this.child.exitCode === null && this.child.signalCode === null; }

  async start(launch: ProviderLaunch, onExit: (why: unknown) => void): Promise<number> {
    for (const resource of launch.resources) accessSync(resource);
    const child = this.child = spawn(launch.executable, launch.args, { stdio: ["pipe", "pipe", "inherit"], env: launch.env });
    child.stdin.on("error", () => {}); // an exit can race the shutdown EOF
    return new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      const startup = setTimeout(() => finish(new Error("Backend did not report a port within 90 seconds")), STARTUP_MS);
      let ready = false;
      const finish = (error?: Error, port?: number) => {
        clearTimeout(startup);
        lines.close();
        child.stdout.resume();
        if (error) { reject(error); this.kill(); }
        else { ready = true; resolve(port!); }
      };

      child.on("error", (error) => { if (!ready) finish(error); });
      child.once("exit", (code, signal) => {
        if (!ready) finish(new Error(`Backend exited before startup (${code ?? signal})`));
        else if (!this.stopping) onExit(code ?? signal);
      });
      lines.once("line", (line) => {
        const port = Number(line);
        if (!/^\d+$/.test(line) || port < 1 || port > 65535) finish(new Error("Backend reported an invalid port"));
        else finish(undefined, port);
      });
    });
  }

  /** Wait for any provider save on shutdown. An idle provider exits immediately. */
  stop(): Promise<number> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return Promise.resolve(0);
    if (!this.alive) return Promise.resolve(child.exitCode ?? 1);
    this.stopping = new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.error(`Backend still running after ${KILL_GRACE_MS} ms. Terminating it; an in-progress save may be lost.`);
        this.kill();
      }, KILL_GRACE_MS);
      child.once("exit", (code) => { clearTimeout(timer); resolve(code ?? 1); });
      child.stdin?.end();
      child.kill("SIGTERM");
    });
    return this.stopping;
  }

  kill() { if (this.alive) this.child?.kill("SIGKILL"); }
}
