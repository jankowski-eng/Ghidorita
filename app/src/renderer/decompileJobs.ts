import type { Address } from "../../../protocol";
import type { Backend } from "./backend";

/** In-flight decompile per tab id. Starting a new one cancels the previous; `current()` is false once superseded or dropped. */
export function decompileJobs(backend: Backend) {
  const jobs = new Map<number, { cancel(): void }>();
  return {
    start(id: number, entry: Address) {
      jobs.get(id)?.cancel(); // superseded by this request
      const { result, cancel } = backend.callCancellable("decompile", { entry });
      const job = { cancel };
      jobs.set(id, job);
      return { result, current: () => jobs.get(id) === job, done: () => { if (jobs.get(id) === job) jobs.delete(id); } };
    },
    drop(id: number) { jobs.get(id)?.cancel(); jobs.delete(id); },
  };
}
