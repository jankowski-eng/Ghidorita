import { rpc } from "./client";
import { ErrorCode } from "../../../protocol";
import { RpcError } from "./backend";
import { byLabel, press, sleep, waitFor, type AutotestCtx } from "./autotest";
import { LARGE_FUNCTION } from "./tabs";

// Focused flows (AUTOTEST_FLOW=<name>, driven by sidecar/test_ui.py): each checks one thing against the real sidecar, through the real DOM.
export async function runFocusedFlow(flow: string, file: string, c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  if (flow === "locked") return lockedFlow(c, result);
  if (flow === "big") return bigFlow(file, c, result);
  if (flow === "open-preserve") return openPreserveFlow(file, c, result);
  throw new Error("unknown AUTOTEST_FLOW " + flow);
}

async function openPreserveFlow(file: string, c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const functions = await c.open(file);
  const entry = functions?.find((f) => f.size > 0)?.entry;
  if (!entry) throw new Error("no test function");
  await c.select(entry);
  const title = c.title();
  const originalCall = rpc.call, onNotification = rpc.onNotification;
  let cancel: (() => void) | undefined;
  let editArrived = false, refreshDuringOpen = false, refreshed = false;
  rpc.call = (method, params) => {
    if (method === "open_binary") return new Promise((_, reject) => { cancel = () => reject(new RpcError(ErrorCode.Cancelled, "Cancelled")); });
    if (method === "list_functions") {
      if (c.status().opening) {
        refreshDuringOpen = true;
        return Promise.reject(new RpcError(ErrorCode.NoProgram, "open_binary in progress"));
      }
      refreshed = true;
    }
    return originalCall(method, params);
  };
  rpc.onNotification = (method, params) => {
    onNotification(method, params);
    if (method === "program_changed") editArrived = true;
  };
  try {
    const replacement = c.open(file);
    const finish = await waitFor(() => cancel, 5000, "replacement open");
    await rpc.call("rename_symbol", { address: entry, newName: "open_preserve_probe" });
    await waitFor(() => editArrived, 5000, "edit notification during open");
    finish();
    await replacement;
    await waitFor(() => c.lastMenu()?.dirty && refreshed, 5000, "preserved session refresh");
    result.openPreserve = {
      opened: c.status().opened, selection: c.selected(), title, activeTitle: c.title(),
      notice: c.status().notice, refreshDuringOpen, undo: await rpc.call("undo_state", {}),
    };
    return c.status().opened && c.selected() === entry && c.status().notice === "Open cancelled."
      && c.title().includes(title) && result.openPreserve.undo.canUndo && !refreshDuringOpen;
  } finally {
    rpc.call = originalCall;
    rpc.onNotification = onNotification;
  }
}

// Another Ghidrette holds the projects dir: the welcome pane must say so (the sidecar answers ProjectLocked to list_programs).
async function lockedFlow(c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const alert = await waitFor(() => document.querySelector<HTMLElement>('.welcome [role="alert"]'), 15000, "an alert in the programs pane");
  const code = await rpc.call("list_programs", {}).then(() => null, (e) => (e instanceof RpcError ? e.code : -1));
  result.locked = { text: alert.textContent, code, programsListed: document.querySelectorAll(".welcome .prog").length, openEnabled: !document.querySelector<HTMLButtonElement>('button[aria-label="Open binary"]')?.disabled };
  return /projects dir in use by another Ghidrette/.test(alert.textContent ?? "") && code === ErrorCode.ProjectLocked && result.locked.programsListed === 0;
}

// A real file over 20 MB, its analysis already stored (fast profile, see test_ui.py): default-Fast rule, size warning, "Decompile anyway", cancel, and a real Timeout.
async function bigFlow(file: string, c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const R: Record<string, any> = (result.big = {});
  const dialog = (t: string) => byLabel("dialog", t);
  // 1. default-Fast rule: the dialog comes up with Fast selected because import_candidates reports sizeBytes > 20 MB
  c.command({ type: "open-path", path: file });
  const dlg = await waitFor(() => dialog("Import binary"), 15000, "import dialog");
  const prof = await waitFor(() => dlg.querySelector<HTMLSelectElement>('select[aria-label="Analysis profile"]'), 15000, "profile select");
  await waitFor(() => !dlg.querySelector<HTMLButtonElement>("button.primary")!.disabled, 15000, "import dialog ready");
  const cands = await rpc.call("import_candidates", { path: file });
  R.sizeMB = Math.round(cands.sizeBytes / 1048576);
  R.defaultProfile = prof.value;
  if (cands.sizeBytes <= 20 * 1048576 || prof.value !== "fast") return false;
  const sent: any[] = [], orig = (rpc as any).call.bind(rpc);
  (rpc as any).call = (m: string, p: any) => { if (m === "open_binary") sent.push(p); return orig(m, p); };
  const t0 = performance.now();
  press(dlg.querySelector<HTMLElement>('[aria-label="Loader"]')!, "Enter");
  await waitFor(() => c.status().opening, 10000, "open to start");
  await waitFor(() => !c.status().opening && c.status().opened, 900000, "open to finish");
  (rpc as any).call = orig;
  R.openSecs = Math.round((performance.now() - t0) / 100) / 10;
  R.openSent = sent[0];
  const progs = await rpc.call("list_programs", {});
  R.storedFast = progs.some((p) => p.options.profile === "fast" && p.sourcePath === file);
  if (R.openSent?.profile !== "fast" || !R.storedFast) return false;

  // 2. functions: the smallest one over the size limit, and the largest one under it that really takes longer than the test timeout
  const fl = await rpc.call("list_functions", {});
  const pane = () => document.querySelector<HTMLElement>(".dec .empty")?.textContent ?? "";
  const btn = (l: string) => document.querySelector<HTMLButtonElement>(`.dec button[aria-label="${l}"]`);
  const large = fl.filter((f) => f.size > LARGE_FUNCTION).sort((a, b) => a.size - b.size)[0];
  if (!large) throw new Error("no function over 30 KB in " + file);
  R.large = { entry: large.entry, size: large.size };
  await c.select(large.entry);
  await waitFor(() => /\d+ KB/.test(pane()) && btn("Decompile anyway"), 10000, "size warning");
  R.warnedWithoutStarting = c.editorText() === "";
  btn("Decompile anyway")!.click();
  await waitFor(() => btn("Cancel decompile"), 5000, "Cancel while decompiling anyway");
  btn("Cancel decompile")!.click();
  await waitFor(() => /cancelled/i.test(pane()) && btn("Decompile anyway"), 10000, "cancelled state");
  btn("Decompile anyway")!.click();
  await waitFor(() => c.editorText().length > 100, 300000, "the real decompile after Decompile anyway");
  R.decompiledAnyway = c.editorText().split("\n").length;

  // 3. a real Timeout: with the test timeout (AUTOTEST_DECOMPILE_TIMEOUT), a function under the limit that takes longer fails with Timeout and offers "Decompile anyway"
  const under = fl.filter((f) => f.size <= LARGE_FUNCTION && f.size > 8 * 1024).sort((a, b) => b.size - a.size).slice(0, 8);
  let slow: (typeof under)[number] | undefined;
  for (const f of under) {
    const code = await rpc.call("decompile", { entry: f.entry, timeoutSecs: 1 }).then(() => null, (e) => (e instanceof RpcError ? e.code : -1));
    if (code === ErrorCode.Timeout) { slow = f; break; }
  }
  if (!slow) throw new Error("no function under 30 KB takes longer than 1 s");
  R.slow = { entry: slow.entry, size: slow.size };
  await c.select(slow.entry);
  await waitFor(() => /timed out/i.test(pane()) && btn("Decompile anyway"), 30000, "the Timeout message");
  R.timeoutText = pane();
  btn("Decompile anyway")!.click();
  await waitFor(() => c.editorText().length > 100, 300000, "decompile after the Timeout");
  R.afterTimeout = true;
  await sleep(200);
  return R.warnedWithoutStarting && R.decompiledAnyway > 5 && R.afterTimeout;
}
