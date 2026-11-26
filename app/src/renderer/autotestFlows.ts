import { isFailure } from "./backend";
import { byLabel, press, sleep, typeInto, waitFor, type AutotestCtx } from "./autotest";
import { LARGE_FUNCTION } from "./tabs";
import { runShotFlow } from "./autotestShots";

// Focused flows (AUTOTEST_FLOW=<name>, driven by sidecar/test_ui.py): each checks one thing against the real sidecar, through the real DOM.
export async function runFocusedFlow(flow: string, file: string, c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  if (flow.startsWith("shot-")) return runShotFlow(flow, file, c, result);
  if (flow === "browsing") return browsingFlow(file, c, result);
  if (flow === "replacement") return replacementFlow(c, result);
  if (flow === "open-preserve") return openPreserveFlow(file, c, result);
  if (flow === "locked") return lockedFlow(c, result);
  if (flow === "big") return bigFlow(file, c, result);
  throw new Error("unknown AUTOTEST_FLOW " + flow);
}

// An edit event for the old session arrives while a replacement open is pending, then the open fails: the old session keeps its view,
// is not refreshed during the open (its RPCs wait for the swap), and is refreshed once afterwards.
async function openPreserveFlow(file: string, c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const functions = await c.open(file);
  const entry = functions?.find((f) => f.size > 0)?.entry;
  if (!entry) throw new Error("no test function");
  await c.select(entry);
  const title = c.title();
  const release = c.holdNextOpen();
  const count = () => c.requests.filter(({ method }) => method === "list_functions").length;
  const replacement = c.open(file);
  await waitFor(() => c.status().opening, 5000, "replacement open");
  const before = count();
  await c.program().edits.renameSymbol({ address: entry, newName: "open_preserve_probe" });
  await sleep(500); // the event is coalesced, not applied, while the open is pending
  const during = count() - before;
  release();
  await replacement;
  await waitFor(() => c.lastMenu()?.dirty && count() > before, 5000, "preserved session refresh");
  const undo = await c.program().history.state();
  result.openPreserve = { opened: c.status().opened, selection: c.selected(), title, activeTitle: c.title(), notice: c.status().notice, refreshesDuringOpen: during, undo };
  return c.status().opened && c.selected() === entry && c.status().notice === "Open cancelled."
    && c.title().includes(title) && undo.canUndo && during === 0;
}

// Another Ghidrette holds the projects dir: the welcome pane must say so (the sidecar answers ProjectLocked to list_programs).
async function lockedFlow(c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const alert = await waitFor(() => document.querySelector<HTMLElement>('.welcome [role="alert"]'), 15000, "an alert in the programs pane");
  const code = await c.backend.projects.list().then(() => null, (e) => (isFailure(e, "projectLocked") ? "projectLocked" : "unexpected"));
  result.locked = { text: alert.textContent, code, programsListed: document.querySelectorAll(".welcome .prog").length, openEnabled: !document.querySelector<HTMLButtonElement>('button[aria-label="Open binary"]')?.disabled };
  return /projects dir in use by another Ghidrette/.test(alert.textContent ?? "") && code === "projectLocked" && result.locked.programsListed === 0;
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
  const cands = await c.backend.imports.choices({ path: file });
  R.sizeMB = Math.round(cands.sizeBytes / 1048576);
  R.defaultProfile = prof.value;
  if (cands.sizeBytes <= 20 * 1048576 || prof.value !== "fast") return false;
  const sentStart = c.openAttempts.length;
  const t0 = performance.now();
  press(dlg.querySelector<HTMLElement>('[aria-label="Loader"]')!, "Enter");
  await waitFor(() => c.status().opening, 10000, "open to start");
  await waitFor(() => !c.status().opening && c.status().opened, 900000, "open to finish");
  R.openSecs = Math.round((performance.now() - t0) / 100) / 10;
  R.openSent = c.openAttempts[sentStart];
  const progs = await c.backend.projects.list();
  R.storedFast = progs.some((p) => p.options.profile === "fast" && p.sourcePath === file);
  if (R.openSent?.profile !== "fast" || !R.storedFast) return false;

  // 2. functions: the smallest one over the size limit, and the largest one under it that really takes longer than the test timeout
  const fl = await c.program().functions.list();
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
    const code = await c.program().decompiler.decompile({ entry: f.entry, timeoutSecs: 1 }).result.then(() => null, (e) => (isFailure(e, "timeout") ? "timeout" : "unexpected"));
    if (code === "timeout") { slow = f; break; }
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

async function browsingFlow(file: string, c: AutotestCtx, result: Record<string, unknown>) {
  const expectReadOnly = !c.backend.capabilities.has("decompile");
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  const openButton = document.querySelector<HTMLButtonElement>('button[aria-label="Open binary"]');
  check(openButton && !openButton.disabled, "Welcome must offer Open");
  c.command({ type: "open-path", path: file }); // the native file dialog's result takes this same route
  if (c.backend.capabilities.has("importOptions")) {
    const confirm = await waitFor(() => {
      const button = byLabel("dialog", "Import binary")?.querySelector<HTMLButtonElement>("button.primary");
      return button && !button.disabled && button;
    }, 15000, "provider import choices");
    confirm.click();
  }
  const listing = await waitFor(() => {
    const retry = [...document.querySelectorAll("button")].find((button) => button.textContent === "Retry listing");
    if (retry) throw new Error(retry.parentElement?.innerText ?? "Initial listing failed");
    if (c.errors.length) throw new Error(c.errors.join("; "));
    return document.querySelector<HTMLElement>(".lbox");
  }, 45000, "listing");
  const functions = await c.program().functions.list();
  const target = expectReadOnly
    ? functions.find(({ name }) => name === "overlay_return")!
    : functions[Math.floor(functions.length / 2)];
  check(target, "fixture must have a named function");
  const filter = document.querySelector<HTMLInputElement>('input[aria-label="Filter functions"]')!;
  typeInto(filter, target.name);
  const option = await waitFor(() => document.getElementById(`fn-${target.entry}`), 10000, "filtered function");
  // Exercise the function-list keyboard handler and verify the actual rendered row.
  const listbox = byLabel("listbox", "Functions")!;
  listbox.focus();
  if (listbox.getAttribute("aria-activedescendant") === option.id) press(listbox, "Enter");
  else option.click();
  await waitFor(() => {
    const row = listing.querySelector('.lrow.k-main[aria-current="true"] .a');
    return row?.textContent?.includes(target.entry) && option.getAttribute("aria-selected") === "true";
  }, 10000, "function navigation and listing cursor");

  const at = c.topAddr();
  const wheel = (deltaY: number) => listing.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }));
  wheel(160);
  const down = await waitFor(() => c.topAddr() !== at && c.topAddr(), 5000, "forward scroll");
  wheel(-160);
  await waitFor(() => c.topAddr() !== down && c.topAddr(), 5000, "backward scroll");
  const pages = c.requests.filter(({ method }) => method === "listing_rows").map(({ params }) => params as { direction: string });
  check(pages.some((p) => p.direction === "forward") && pages.some((p) => p.direction === "backward"), "listing must page in both directions");

  if (expectReadOnly) {
    check(!document.querySelector(".dec, .welcome, .xrefs, button[aria-label='Data types']"), "optional views should be absent");
    listing.focus();
    for (const key of ["l", "t", "x", ";", "c", "f"]) press(listing, key);
    press(listing, "z", { metaKey: true });
    press(listing, "s", { metaKey: true });
    check(!document.querySelector(".dlg"), "editing shortcuts should not open a dialog");
    for (const item of ["rename", "undo", "save", "decompiler", "strings", "datatypes", "xrefs", "search-symbols"]) {
      check(!await c.menu(item), `unsupported menu item was enabled: ${item}`);
    }
    check(await c.menu("command-bar"), "Command Bar menu item should be enabled");
    const commands = await waitFor(() => byLabel("dialog", "Command bar"), 5000, "Command Bar");
    const actions = [...commands.querySelectorAll('[role="option"]')].map((option) => option.textContent);
    check(actions.some((label) => label?.includes("Go to Address")), "command bar should offer navigation");
    check(!actions.some((label) => /rename|save|undo|references|data type/i.test(label ?? "")), "unsupported commands appeared");
    press(commands, "Escape");
  }

  check(await c.menu("close-program"), "Close Program menu item should be enabled");
  await waitFor(() => !c.status().opened && !document.querySelector(".lbox"), 10000, "return to welcome");
  check(!(await c.backend.lifecycle.active()), "the provider should have no active session");
  if (expectReadOnly) {
    const browsing = new Set(["provider_info", "active_session", "open_binary", "listing_info", "listing_rows", "list_functions", "get_function_at", "close_program"]);
    const unexpected = c.requests.map(({ method }) => method).filter((method) => !browsing.has(method));
    check(!unexpected.length, `unexpected read-only requests: ${unexpected.join(", ")}`);
  }
  result.browsing = { landing: target.entry, forwardReads: pages.filter((p) => p.direction === "forward").length,
    backwardReads: pages.filter((p) => p.direction === "backward").length, methods: [...new Set(c.requests.map(({ method }) => method))] };
  return true;
}

async function replacementFlow(c: AutotestCtx, result: Record<string, unknown>) {
  const a = await c.open("/program-a");
  const entry = a![0].entry;
  await c.select(entry);
  await waitFor(() => c.editorText().length > 0, 10000, "program A's decompiler tab");
  const tabs = () => (document.querySelector(".dec .tabstrip")?.textContent ?? "").trim();
  const oldTabs = tabs();
  const old = await c.backend.lifecycle.active();
  await c.program().edits.setComment({ address: entry, kind: "eol", text: "pending edit" });
  await waitFor(() => c.title().startsWith("•") && c.lastMenu()?.dirty, 10000, "dirty marker");
  await c.open("/program-b"); // the mock fails one autosave, retaining A
  const kept = await c.backend.lifecycle.active();
  const retained = old?.sessionId === kept?.sessionId && c.title() === "• program-a — Ghidrette" &&
    tabs() === oldTabs && !!oldTabs && c.selected() === entry && c.lastMenu()?.dirty &&
    !c.requests.some(({ method }) => method === "close_program");
  if (!retained) throw new Error("failed replacement did not preserve A, its tabs and its dirty state");
  c.errors.splice(0); // the expected autosave failure was shown to the user

  await c.open("/program-b"); // A saves this time. B opens, but fails its first row read.
  const button = await waitFor(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Retry listing"), 10000, "retry listing");
  const b = await c.backend.lifecycle.active();
  const attempts = c.openAttempts.length;
  button.click();
  await waitFor(() => document.querySelector(".lbox .lrow.k-main"), 10000, "first listing page on retry");
  const sameSession = b?.name === "program-b" && b.sessionId === (await c.backend.lifecycle.active())?.sessionId &&
    c.openAttempts.length === attempts && !c.lastMenu()?.dirty;
  if (!sameSession) throw new Error("listing retry did not keep B's session");
  if (!await c.menu("close-program")) throw new Error("close command unavailable after retry");
  await waitFor(() => !c.status().opened, 10000, "close after listing retry");
  result.replacement = { retainedA: retained, retriedB: sameSession };
  return true;
}
