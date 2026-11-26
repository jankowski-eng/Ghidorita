import type { Address, FunctionInfo } from "../../../protocol";
import { AddrMap } from "./addrmap";
import { rpc } from "./client";

/** What the scripted modes need from the running app. */
export interface AutotestCtx {
  open(path: string): Promise<FunctionInfo[] | undefined>;
  select(entry: Address): Promise<void>;
  clickAt(line1: number, col1: number): Promise<void> | void;
  back(): void;
  forward(): void;
  selected(): Address | null;
  topAddr(): Address;
  editorText(): string;
  errors: string[];
  fail(e: unknown): void;
  setPath(p: string): void;
}

export async function runAutotest(file: string, c: AutotestCtx) {
    const result: Record<string, unknown> = { ok: false };
    try {
      c.setPath(file);
      const fl = await c.open(file);
      if (!fl?.length) throw new Error("no functions");
      // pick main (or first), else walk the first few functions until one has a call token
      const order = [...fl.filter((f) => f.name === "main"), ...fl.slice(0, 10)];
      let clicked = false;
      for (const f of order) {
        const r = await rpc.call("decompile", { entry: f.entry });
        const tok = r.tokens.find((t) => t.targetFunction && t.targetFunction !== f.entry); // a real call to another function
        if (!tok) continue;
        await c.select(f.entry);
        await new Promise((r) => setTimeout(r, 300));
        result.startFunction = f.name;
        result.clickedToken = { line: tok.line, colStart: tok.colStart, target: tok.targetFunction };
        await c.clickAt(tok.line + 1, tok.colStart + 2); // same path as a Monaco mouse click
        clicked = true;
        break;
      }
      if (!clicked) throw new Error("no call token found");
      await new Promise((r) => setTimeout(r, 1000));
      result.selectedEntry = c.selected();
      result.expectedEntry = (result.clickedToken as any).target;
      result.listingTopAddress = c.topAddr();
      result.editorFirstLine = c.editorText().split("\n")[0];
      result.functions = fl.length; result.totalBytes = (await rpc.call("listing_info", {})).totalBytes;
      // Back returns to the start function (listing top row = its entry), Forward to the callee again
      const startEntry = fl.find((f) => f.name === result.startFunction)!.entry;
      c.back(); await new Promise((r) => setTimeout(r, 1000));
      result.afterBackTop = c.topAddr();
      c.forward(); await new Promise((r) => setTimeout(r, 1000));
      result.afterForwardTop = c.topAddr();
      result.navOk = result.afterBackTop === startEntry && result.afterForwardTop === result.expectedEntry;
      result.ok = result.navOk && result.expectedEntry !== fl.find((f) => f.name === result.startFunction)?.entry && result.selectedEntry === result.expectedEntry && result.listingTopAddress === result.selectedEntry && c.errors.length === 0;
    } catch (e) { c.fail(e); }
    result.errors = c.errors;
    window.host.autotestDone(result);
}

// BENCH=1 AUTOTEST=<file>: listing scroll + decompile measurements in the real renderer (step 6 of the spike)
export async function runBench(file: string, c: AutotestCtx) {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
    const q = (xs: number[], p: number) => { const a = [...xs].sort((x, y) => x - y); return a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))] * 100) / 100 : 0; };
    const summ = (xs: number[]) => ({ n: xs.length, median: q(xs, 0.5), p95: q(xs, 0.95), max: q(xs, 1) });
    const result: Record<string, any> = { ok: true };
    let gaps: number[] = [];
    let running = true;
    (async () => { let last = performance.now(); while (running) { const n = await frame(); gaps.push(n - last); last = n; } })();
    const frames = () => { const g = gaps; gaps = []; return { frames: g.length, ...summ(g) }; };
    try {
      c.setPath(file);
      const t0 = performance.now();
      const fl = await c.open(file);
      result.openMs = Math.round(performance.now() - t0);
      const info = await rpc.call("listing_info", {});
      const m = new AddrMap(info.ranges);
      result.functions = fl!.length; result.totalBytes = m.total;
      await sleep(1500);
      const L = (window as any).__listing;
      const randAddr = () => m.addr(Math.random() * (m.total - 1));

      frames();
      const lat: number[] = [];
      for (let i = 0; i < 300; i++) { const t = performance.now(); await L.jump(randAddr()); await frame(); lat.push(performance.now() - t); }
      result.randomJump300 = { ms: summ(lat), frameGapMs: frames() };

      const sw: number[] = []; const ts = performance.now();
      for (let i = 0; i < 1000; i++) { const t = performance.now(); await L.jump(m.addr((i / 999) * (m.total - 1))); await frame(); sw.push(performance.now() - t); }
      result.sweepStartToEnd1000 = { ms: summ(sw), totalS: Math.round(performance.now() - ts) / 1000, frameGapMs: frames() };

      // fling: 100 lines per frame (~6000 lines/s at 60 Hz) from the middle; a "stall" frame is one where the buffer could not supply the lines
      const fling = async (ms: number, until?: () => boolean) => {
        await L.jump(m.addr(m.total / 2)); await sleep(500); frames();
        const end = performance.now() + ms; let stall = 0, stallRun = 0, worst = 0, moved = 0, f = 0, t = performance.now();
        while (performance.now() < end && !(until?.())) {
          await frame(); f++;
          const d = L.scrollLines(100); moved += d;
          if (d < 100) { stall++; stallRun += performance.now() - t; worst = Math.max(worst, stallRun); } else stallRun = 0;
          t = performance.now();
        }
        return { frames: f, linesMoved: moved, stallFrames: stall, worstConsecutiveStallMs: Math.round(worst), frameGapMs: frames() };
      };
      result.fling20s = await fling(20000);
      (window as any).__lst.length = 0;

      let done = false; const dl: number[] = [];
      const picks = Array.from({ length: 50 }, () => fl![Math.floor(Math.random() * fl!.length)]);
      const dec = (async () => { for (const f of picks) { const t = performance.now(); try { await rpc.call("decompile", { entry: f.entry }); } catch (e) { c.errors.push(String(e)); } dl.push(performance.now() - t); } done = true; })();
      result.flingDuringDecompile50 = await fling(120000, () => done);
      await dec;
      result.decompileMs = summ(dl);
      const fwd = ((window as any).__lst as any[]).map((x) => x.ms);
      result.listingFetchMsDuringDecompile = summ(fwd);
    } catch (e) { c.fail(e); result.ok = false; }
    running = false;
    result.errors = c.errors;
    window.host.autotestDone(result);
}
