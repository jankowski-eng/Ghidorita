import { BackendError, type ApplicationBackend } from "./backend";
import type { AutotestControls } from "./autotest";

export function autotestBackend(backend: ApplicationBackend, requests: AutotestControls["requests"]) {
  let held: { entry: string; started: boolean; cancelled: number } | undefined;
  let release: (() => void) | undefined, holdOpen = false;
  let cancelOpen: Parameters<AutotestControls["cancelOpenWhen"]>[0];
  const openAttempts: AutotestControls["openAttempts"] = [];
  const controls: AutotestControls = {
    requests, openAttempts,
    holdDecompile: (entry) => held = { entry, started: false, cancelled: 0 },
    cancelOpenWhen: (predicate) => { cancelOpen = predicate; },
    holdNextOpen: () => { holdOpen = true; return () => release?.(); },
  };
  const instrumented: ApplicationBackend = {
    capabilities: backend.capabilities, recovery: backend.recovery, imports: backend.imports, projects: backend.projects, events: backend.events,
    lifecycle: {
      ...backend.lifecycle,
      open(path, options, progress) {
        const params = { ...options, path };
        openAttempts.push(params);
        if (holdOpen) {
          holdOpen = false;
          const result = new Promise<never>((_, reject) => { release = () => reject(new BackendError("cancelled", "Open cancelled")); });
          return { result, cancel: async () => false };
        }
        if (cancelOpen?.(params)) {
          return { result: Promise.reject(new BackendError("cancelled", "Open cancelled")), cancel: async () => false };
        }
        return backend.lifecycle.open(path, options, progress);
      },
    },
    program(session) {
      const program = backend.program(session);
      return {
        ...program,
        decompiler: { graph: program.decompiler.graph, decompile(params) {
          const job = program.decompiler.decompile(params);
          const probe = held;
          if (probe?.entry !== params.entry || probe.started) return job;
          probe.started = true;
          return {
            result: job.result.then(async (value) => {
              await new Promise((resolve) => setTimeout(resolve, 1500));
              return value;
            }),
            cancel() { probe.cancelled++; job.cancel(); },
          };
        } },
      };
    },
  };
  return { controls, instrumented };
}
