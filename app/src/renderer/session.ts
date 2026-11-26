import type { ActiveSession, FunctionInfo, ListingRow, OpenResult } from "../../../protocol";
import type { OpenJob, ProgramLifecycle, ProgramOperations } from "./backend";
import { AddrMap } from "./addrmap";

/** Window title: "• name — Ghidrette" while there are unsaved changes. */
export const windowTitle = (name: string | null, dirty: boolean): string =>
  (name ? `${dirty ? "• " : ""}${name} — ` : "") + "Ghidrette";

export type Replacement =
  | { kind: "opened"; session: OpenResult }
  | { kind: "failed"; session: ActiveSession | null; error: unknown }
  | { kind: "unknown"; error: unknown; reconciliationError: unknown };

export async function resolveOpen(job: OpenJob, lifecycle: Pick<ProgramLifecycle, "active">): Promise<Replacement> {
  try {
    return { kind: "opened", session: await job.result };
  } catch (error) {
    try { return { kind: "failed", session: await lifecycle.active(), error }; }
    catch (reconciliationError) { return { kind: "unknown", error, reconciliationError }; }
  }
}

export const FIRST_LISTING_PAGE = 100;
export interface BrowsingData {
  map: AddrMap;
  rows: ListingRow[];
  functions: FunctionInfo[];
}
export async function readBrowsing({ listing, functions }: Pick<ProgramOperations, "listing" | "functions">): Promise<BrowsingData> {
  const [info, list] = await Promise.all([listing.info(), functions.list()]);
  const map = new AddrMap(info.ranges);
  const rows = map.total ? await listing.rows({ address: map.addr(0), count: FIRST_LISTING_PAGE, direction: "forward" }) : [];
  return { map, rows, functions: list };
}
