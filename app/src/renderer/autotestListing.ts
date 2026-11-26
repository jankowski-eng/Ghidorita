import type { FunctionInfo, ListingRow } from "../../../protocol";
import { rpc } from "./client";
import { sleep, waitFor, type AutotestCtx } from "./autotest";
import { addrAdd } from "./address";

// Listing completeness flow of the autotest (round 8): function header, plate comment through an edit that refreshes only its rows,
// a navigation right after an edit (the old re-jump race), an xref click, folding data components, the run cache and the thumb drag guard,
// and (where the program has them) the address spaces. Mock and real sidecar.
const need = (ok: unknown, what: string) => { if (!ok) throw new Error("listing: " + what); };
const L = () => (window as any).__listing;
const lst = () => ((window as any).__lst ??= []) as { ms: number; direction: string; count: number; address: string; rows: number }[];
const lineText = (cls: string) => [...document.querySelectorAll(`.lrow.${cls}`)].map((x) => x.textContent ?? "");

export async function runListingFlow(fl: FunctionInfo[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const R: Record<string, any> = (result.listing = {});
  const errors0 = c.errors.length;
  const at = (entry: string) => L().rowAt(entry) as ListingRow | undefined;
  const topIs = (addr: string) => { const r = at(addr); return !!r && c.topAddr() === r.address; };
  const shows = (addr: string, what: string, ms = 10000) => waitFor(() => topIs(addr), ms, `${what}: listing at ${addr} (top ${c.topAddr()})`);

  // 1. function header at the entry of a function with callers
  let f = fl[Math.min(2, fl.length - 1)], callers = await rpc.call("xrefs_to", { address: f.entry, limit: 50 });
  for (const g of fl.slice(0, 400)) { const x = await rpc.call("xrefs_to", { address: g.entry, limit: 50 }); if (x.length) { f = g; callers = x; break; } }
  await c.select(f.entry); await shows(f.entry, "select");
  const row = await waitFor(() => at(f.entry), 5000, "entry row buffered");
  need(row!.header && row!.header.signature.includes(f.name), "function header names " + f.name + ": " + JSON.stringify(row!.header));
  await waitFor(() => lineText("k-header").some((t) => t.includes(f.name)), 5000, "header line in the DOM");
  R.header = { entry: f.entry, signature: row!.header!.signature, convention: row!.header!.convention ?? null };

  // 2. xref annotation: count agrees with xrefs_to, items are clickable and navigate
  need(row!.xrefs && row!.xrefs.count >= callers.length && row!.xrefs.items.length > 0, "xref annotation " + JSON.stringify(row!.xrefs));
  await waitFor(() => lineText("k-xref").some((t) => t.startsWith(`XREF[${row!.xrefs!.count}]:`)), 5000, "xref line in the DOM");
  const link = document.querySelector<HTMLElement>(`.lrow.k-xref [aria-label^="Go to reference"]`)!;
  const from = link.getAttribute("aria-label")!.replace("Go to reference ", "");
  link.click();
  await waitFor(() => { const r = at(from); return !!r && c.topAddr() === r.address; }, 10000, `xref click navigates to ${from} (top ${c.topAddr()})`);
  R.xrefClick = { from, count: row!.xrefs!.count };
  await c.select(f.entry); await shows(f.entry, "back to the function");

  // 3. plate comment through an edit: only the intersecting rows are refetched, the view stays
  await waitFor(() => !L().busy(), 5000, "listing idle"); await sleep(300); // the jump's own prefetch must not count as the edit's refetch
  const top0 = c.topAddr(), n0 = lst().length;
  await rpc.call("set_comment", { address: f.entry, kind: "plate", text: "Autotest plate" });
  await waitFor(() => lineText("k-plate").some((t) => t.includes("Autotest plate")), 10000, "plate comment line");
  const fetched = lst().slice(n0);
  need(fetched.length >= 1 && fetched.length <= 2 && fetched.every((x) => x.direction === "forward" && x.count < 100), "edit refetched only its rows: " + JSON.stringify(fetched));
  need(c.topAddr() === top0, "the view stayed after the edit");
  R.plateRefresh = { fetches: fetched.map((x) => ({ count: x.count, rows: x.rows })) };

  // 4. a navigation ~100 ms after an edit must not be lost (SPIKE_REPORT round 5 "Test timing")
  const other = fl.find((g) => g.entry !== f.entry && at(g.entry) === undefined) ?? fl[fl.length - 1];
  await rpc.call("set_comment", { address: f.entry, kind: "pre", text: "Autotest pre" });
  await sleep(100);
  await c.select(other.entry);
  await shows(other.entry, "navigation after an edit");
  await sleep(800); // the late program_changed refresh must not move it back
  need(topIs(other.entry), "navigation survived the late refresh: top " + c.topAddr());
  R.navAfterEdit = { to: other.entry };
  await rpc.call("undo", {}); await rpc.call("undo", {}); // both comments
  await c.select(f.entry); await shows(f.entry, "after undo");
  await waitFor(() => !lineText("k-plate").some((t) => t.includes("Autotest plate")) && !lineText("k-pre").some((t) => t.includes("Autotest pre")), 10000, "comments gone after undo");

  // 5. run cache: jumping back into rows shown earlier does not fetch
  const far = fl[fl.length - 1].entry, mid = fl[Math.floor(fl.length / 2)].entry;
  await c.select(far); await shows(far, "far");
  await c.select(mid); await shows(mid, "mid");
  const n1 = lst().length, runs = L().runs();
  await c.select(far); await shows(far, "far again");
  await sleep(300);
  need(runs >= 1, "a run was kept: " + runs);
  // the jump itself fetches nothing; the prefetch that tops the restored run up to its margin may (it starts at the run's edge, not at the target)
  const after = lst().slice(n1), jumpFetch = after.filter((x) => x.direction === "forward" && x.count >= 100 && at(far) && x.address === at(far)!.address);
  need(jumpFetch.length === 0, "jump back into a kept run fetched the target again: " + JSON.stringify(after));
  R.runCache = { runs, prefetches: after.map((x) => `${x.direction} ${x.rows}`) };

  // 6. the thumb stays where the user holds it
  L().dragging(true);
  const th = L().thumb();
  L().scrollLines(7); await sleep(50);
  need(L().thumb() === th, "thumb moved while dragging");
  L().dragging(false);

  // 7. data components: fold / unfold (a program with defined structure or array data in view; the mock has none until one is applied)
  const info = await rpc.call("listing_info", {});
  const first = info.ranges[0].start;
  let withParts: ListingRow | undefined, next = info.ranges[0].start;
  for (let k = 0; k < 20 && !withParts; k++) {
    const rows = await rpc.call("listing_rows", { address: next, count: 500 });
    withParts = rows.find((r) => r.parts && r.parts.length);
    if (rows.length < 500) break;
    next = addrAdd(rows[rows.length - 1].address, rows[rows.length - 1].length);
  }
  if (withParts) {
    await c.goAddr(withParts.address); await waitFor(() => lineText("k-main").length > 0 && !!at(withParts!.address) && topIs(withParts!.address), 10000, "data row");
    need(lineText("k-part").length === 0, "folded by default");
    document.querySelector<HTMLElement>('.lrow .fold[aria-label="Unfold components"]')!.click();
    await waitFor(() => lineText("k-part").length >= Math.min(withParts!.parts!.length, 3), 5000, "components shown");
    R.parts = { at: withParts.address, parts: withParts.parts!.length, first: lineText("k-part")[0] };
    document.querySelector<HTMLElement>('.lrow .fold[aria-label="Fold components"]')!.click();
    await waitFor(() => lineText("k-part").length === 0, 5000, "components folded again");
  } else R.parts = "none in the first 10k rows";

  // 8. address spaces (programs that have more than one range space, e.g. the mock): navigate into each, qualified/unsigned addresses
  const odd = info.ranges.filter((r) => !/^0x[0-9a-f]{1,13}$/i.test(r.start)); // qualified or above 2^52
  for (const r of odd) {
    await c.goAddr(r.start as any);
    await waitFor(() => { const x = at(r.start); return !!x && c.topAddr() === x.address; }, 10000, `go to ${r.start} (top ${c.topAddr()})`);
  }
  R.spaces = odd.map((r) => r.start);
  const ok = c.errors.length === errors0;
  R.ok = ok;
  return ok;
}
