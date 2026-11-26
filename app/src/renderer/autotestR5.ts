import { rpc } from "./client";
import { byLabel, press, setSelect, sleep, typeInto, waitFor, type AutotestCtx } from "./autotest";

// Round 5 flow of the autotest, all through the UI: comment prefill per kind, a label on an
// unlabeled address, the import dialog's analysis profile (a real fast open, then the program browser). It undoes the edits it
// made and ends with the default import open.
export async function runR5Flow(file: string, c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const R: Record<string, any> = (result.r5 = {});
  const fl = await rpc.call("list_functions", {});
  const lb = () => document.querySelector<HTMLElement>(".lbox")!;
  const dialog = (t: string) => waitFor(() => byLabel("dialog", t), 5000, `dialog "${t}"`);
  const closed = (t: string) => waitFor(() => !byLabel("dialog", t), 8000, `dialog "${t}" to close`);
  const hasLabel = (n: string) => [...document.querySelectorAll(".lrow.lbl .l")].some((x) => x.textContent === n + ":");
  const undoN = async (n: number) => { for (let i = 0; i < n; i++) await rpc.call("undo", {}); await sleep(300); };
  const goTop = async (a: string) => { await c.goAddr(a); await waitFor(() => c.topAddr() === a, 8000, "listing at " + a); };

  // 3. Comment dialog: prefill per kind from get_comments, text follows the kind selector, drafts survive switching
  const entry = fl[Math.min(3, fl.length - 1)].entry;
  const before = await rpc.call("get_comments", { address: entry });
  const texts = { eol: "r5 eol", pre: "r5 pre", plate: "r5 plate" } as const;
  for (const [k, t] of Object.entries(texts)) await rpc.call("set_comment", { address: entry, kind: k as "eol", text: t });
  await goTop(entry);
  lb().focus(); press(lb(), ";");
  const d = await dialog("Set comment");
  const area = () => d.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')!;
  const sel = d.querySelector<HTMLSelectElement>('select[aria-label="Comment kind"]')!;
  const cm: Record<string, any> = (R.comment = {});
  cm.defaultKind = sel.value === "eol" && area().value === texts.eol;
  for (const k of ["pre", "plate", "post", "repeatable"] as const) { setSelect(sel, k); await sleep(60); cm[k] = area().value === ((texts as Record<string, string>)[k] ?? ""); }
  setSelect(sel, "post"); await sleep(60); typeInto(area(), "r5 post draft");
  setSelect(sel, "plate"); await sleep(60); const plateBack = area().value === texts.plate;
  setSelect(sel, "post"); await sleep(60); cm.draftKept = plateBack && area().value === "r5 post draft";
  setSelect(sel, "pre"); await sleep(60); typeInto(area(), "r5 pre edited"); press(area(), "Enter"); await closed("Set comment");
  await sleep(300);
  const after = await rpc.call("get_comments", { address: entry });
  cm.saved = after.pre === "r5 pre edited" && after.eol === texts.eol && after.plate === texts.plate && !after.post && !after.repeatable;
  await undoN(4);
  cm.restored = JSON.stringify(await rpc.call("get_comments", { address: entry })) === JSON.stringify(before);
  R.commentOk = Object.values(cm).every((v) => v === true);
  if (!R.commentOk) return false;

  // 4. L on an unlabeled address creates the label (Rename is for existing ones)
  const big = [...fl].sort((a, b) => b.size - a.size)[0];
  const unl = (await rpc.call("listing_rows", { address: big.entry, count: 12 })).slice(1).find((r) => !r.label);
  if (!unl) throw new Error("no unlabeled row");
  await goTop(unl.address);
  lb().focus(); press(lb(), "l");
  await dialog("Create label");
  const inp = await waitFor(() => document.querySelector<HTMLInputElement>('[aria-label="Label name"]'), 5000, "label input");
  typeInto(inp, "r5_label"); press(inp, "Enter"); await closed("Create label");
  await waitFor(() => hasLabel("r5_label"), 8000, "the new label in the listing");
  R.label = { address: unl.address };
  await undoN(1);
  await waitFor(() => !hasLabel("r5_label"), 8000, "label gone after undo");
  R.labelOk = true;

  // 6. Huge functions (mock only: it has a 40 KB function and one that times out at the default 30 s)
  const huge = fl.find((f) => f.size > 30 * 1024), slow = fl.find((f) => f.name === "fn_4001");
  if (huge && slow) {
    const pane = () => document.querySelector<HTMLElement>(".dec .empty")?.textContent ?? "";
    const btn = (l: string) => document.querySelector<HTMLButtonElement>(`.dec button[aria-label="${l}"]`);
    await c.select(huge.entry);
    await waitFor(() => /\d+ KB/.test(pane()) && btn("Decompile anyway"), 8000, "size warning");
    const warned = c.editorText() === ""; // nothing was started on its own
    btn("Decompile anyway")!.click();
    await waitFor(() => btn("Cancel decompile"), 5000, "Cancel while decompiling anyway");
    btn("Cancel decompile")!.click();
    await waitFor(() => /cancelled/i.test(pane()) && btn("Decompile anyway"), 5000, "cancelled state");
    btn("Decompile anyway")!.click();
    await waitFor(() => c.editorText().includes("fn_4000"), 15000, "decompile after anyway");
    await c.select(slow.entry);
    await waitFor(() => /timed out/.test(pane()) && btn("Decompile anyway"), 15000, "timeout message");
    btn("Decompile anyway")!.click();
    await waitFor(() => c.editorText().includes("fn_4001"), 15000, "decompile after timeout");
    R.huge = { warned };
    if (!warned) return false;
  }

  // 7. Electron hardening seen from the page: CSP enforced (eval refused), window.open denied, no Node globals, navigation prevented
  (window as any).__expectCsp = true; // these probes violate the policy on purpose
  const hd: Record<string, boolean> = (R.hardening = {});
  hd.evalBlocked = (() => { try { new Function("return 1"); return false; } catch { return true; } })();
  hd.openDenied = window.open("https://example.com/") === null;
  hd.noNode = typeof (window as any).require === "undefined" && typeof (window as any).process === "undefined";
  location.assign("https://example.com/"); await sleep(700);
  hd.navigationPrevented = location.protocol === "file:" && !!document.querySelector(".app");
  (window as any).__expectCsp = false;
  if (!Object.values(hd).every(Boolean)) return false;

  // 5. Import dialog: profile choice; Fast is sent as profile "fast", a real fast open shows in the program browser
  const importDlg = async (path: string) => { c.command({ type: "open-path", path }); return waitFor(() => byLabel("dialog", "Import binary"), 10000, "import dialog"); };
  const pr = (dd: Element) => dd.querySelector<HTMLSelectElement>('select[aria-label="Analysis profile"]')!;
  const progs = await rpc.call("list_programs", {});
  if (progs.some((p) => p.sourcePath?.startsWith("/mock/"))) { // mock only: a 30 MB file defaults to Fast (the real default needs a real >20 MB file; npm test covers the rule)
    const dd = await importDlg("/mock/big.bin");
    await waitFor(() => pr(dd), 10000, "big dialog ready"); // a .bin file is Raw Binary: no language yet, so Open stays disabled
    R.bigDefaultsFast = pr(dd).value === "fast";
    press(dd, "Escape"); await closed("Import binary");
    if (!R.bigDefaultsFast) return false;
  }
  const dd = await importDlg(file);
  await waitFor(() => !dd.querySelector<HTMLButtonElement>("button.primary")!.disabled, 10000, "import dialog ready");
  R.smallDefaultsFull = pr(dd).value === "full" && /Fast \(skips switch analysis, call-convention ID, stack\)/.test(pr(dd).textContent!);
  setSelect(pr(dd), "fast");
  press(dd.querySelector<HTMLElement>('[aria-label="Loader"]')!, "Enter");
  await waitFor(() => c.status().opening, 10000, "fast open to start");
  await waitFor(() => !c.status().opening && c.status().opened, 600000, "fast open to finish");
  const fastId = (await rpc.call("list_programs", {})).find((p) => p.options.profile === "fast")?.programId;
  R.fastOpenStored = !!fastId;
  c.command({ type: "close-program" });
  await waitFor(() => !c.status().opened && !document.querySelector(".main"), 10000, "welcome after close");
  const base = file.split("/").pop()!;
  await waitFor(() => [...document.querySelectorAll<HTMLElement>(".welcome .open")].some((b) => b.textContent!.includes(base) && b.textContent!.includes("fast analysis")), 10000, "program browser to show the fast profile");
  R.browserShowsFast = true;
  R.importProfileOk = R.smallDefaultsFull && R.fastOpenStored && R.browserShowsFast;
  await c.open(file);
  return R.commentOk && R.labelOk && R.importProfileOk === true;
}
