import { createRoot } from "react-dom/client";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { loader } from "@monaco-editor/react";
import { App } from "./App";
import { WebSocketBackend } from "./rpc";
import { testTimeout } from "./tabs";
import { changeLog } from "./changeLog";
import type { AutotestControls } from "./autotest";
import "./style.css";

// Bundle Monaco locally (no CDN).
(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

const root = createRoot(document.getElementById("root")!);
async function start() {
  const cfg = await window.host.getConfig();
  const requests: AutotestControls["requests"] = [];
  const backend = new WebSocketBackend({
    onEdit: (command, params, result) => changeLog.record(command, params, result),
    onSessionChanged: () => changeLog.clear(),
    onRequest: cfg.autotest && !cfg.bench ? (method, params) => requests.push({ method, params }) : undefined,
  });
  await backend.connect(cfg.port, cfg.token);
  if (!cfg.autotest) { root.render(<App backend={backend} />); return; }

  const [{ runAutotest, runBench }, { autotestBackend }] = await Promise.all([
    import("./autotest"), import("./autotestBackend"),
  ]);
  if (cfg.decompileTimeout) testTimeout.secs = cfg.decompileTimeout;
  const { controls, instrumented } = autotestBackend(backend, requests);
  root.render(<App backend={instrumented} onReady={(driver) => {
    void (cfg.bench ? runBench : runAutotest)(cfg.autotest!, { ...driver, ...controls,
      cancelFile: cfg.cancelFile, only: cfg.only, flow: cfg.flow, expect: cfg.expect,
    });
  }} />);
}

void start().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  root.render(<p className="notice" role="alert">{message}</p>);
  const off = window.host.onQuitRequested(() => { off(); void window.host.quitReady({ ok: true }); });
  void window.host.getConfig().then((cfg) => { if (cfg.autotest) void window.host.autotestDone({ ok: false, errors: [message] }); });
});
