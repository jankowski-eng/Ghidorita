import { isFailure, isObsolete, type Job } from "./backend";

/** Cancel the jobs owned by a view when its query changes or it unmounts. */
export function scanner() {
  const live = new Set<() => void>();
  return {
    run<T>({ result, cancel }: Job<T>): Promise<T> {
      live.add(cancel);
      return result.finally(() => live.delete(cancel));
    },
    cancelAll() { for (const cancel of live) cancel(); live.clear(); },
  };
}
export const isCancelled = (e: unknown) => isFailure(e, "cancelled");
export const isNoProgram = isObsolete;
