import { sleep, waitFor, type AutotestCtx } from "./autotest";

// Round 7 flow, all through the UI: a background open shows the program while the analysis runs (listing rows, status bar indicator), Cancel
// stops it ("Resume analysis" appears), Resume runs it to the end and the function list grows. Uses the fast profile of the same file: a different
// program key, so it is a fresh import even after the default open. Ends with the default import open again.
export async function runAnalysisFlow(file: string, c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const R: Record<string, any> = (result.analysis = {});
  const btn = (l: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${l}"]`);
  const bar = () => document.querySelector<HTMLElement>('[role="status"][aria-label="Analysis"]');
  const state = () => c.analysis()?.state;
  const t0 = Date.now();
  await c.openBg(file, { profile: "fast" }); // returns when the import is saved and published
  R.openMs = Date.now() - t0;
  R.runningAtOpen = state() === "running";
  await waitFor(() => document.querySelectorAll(".lbox .lrow").length > 0, 15000, "listing rows");
  R.listingWhileRunning = state() === "running";
  R.indicator = await waitFor(() => /Analyzing/.test(bar()?.textContent ?? "") && !!btn("Cancel analysis"), 10000, "analysis indicator").then(() => true);
  const f0 = c.funcCount();
  btn("Cancel analysis")!.click();
  await waitFor(() => state() === "cancelled", 60000, "analysis cancelled");
  await waitFor(() => btn("Resume analysis"), 5000, "Resume analysis button");
  R.cancelled = /cancelled/i.test(bar()?.textContent ?? "") && c.analysis()?.analysis === "partial";
  await sleep(1500); // the program_changed after the end refreshes the function list
  const fCancel = c.funcCount();
  btn("Resume analysis")!.click();
  await waitFor(() => state() === "running", 10000, "analysis running again");
  await waitFor(() => state() === "done", 240000, "analysis done");
  await sleep(1500);
  const fEnd = c.funcCount();
  R.functions = { atOpen: f0, atCancel: fCancel, atEnd: fEnd };
  R.grew = fEnd > f0 && fEnd >= fCancel;
  R.fastOffersFull = !!btn("Run full analysis") && c.analysis()?.analysis === "done";
  await c.open(file); // the default import (analysis done) is open from here on
  R.ok = R.runningAtOpen && R.listingWhileRunning && R.indicator && R.cancelled && R.grew && R.fastOffersFull;
  return R.ok === true;
}
