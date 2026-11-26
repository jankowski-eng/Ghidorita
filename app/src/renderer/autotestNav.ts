import type { FunctionInfo } from "../../../protocol";
import { rpc } from "./client";
import { byLabel, press, sleep, typeInto, waitFor, type AutotestCtx } from "./autotest";

// Navigate-and-find flow of the autotest: the dock windows (symbols, strings, memory search) and the references panel, driven through the real
// DOM (typing, clicking, key events) after opening each window the way View > ... does (the menu's command handler).
const rowsOf = (g: Element) => [...g.querySelectorAll<HTMLElement>('[role="row"][aria-rowindex]')].filter((r) => !r.classList.contains("ph"));
const cell = (r: Element, key: string) => r.querySelector(`.c-${key}`)?.textContent ?? "";
const need = (ok: unknown, what: string) => { if (!ok) throw new Error("navfind: " + what); };

export async function runNavFlow(fl: FunctionInfo[], c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const R: Record<string, any> = (result.navFind = {});
  const errors0 = c.errors.length;
  const open = (panel: "symbols" | "strings" | "memsearch") => c.command({ type: "dock", panel });
  const grid = (label: string) => waitFor(() => byLabel("grid", label), 5000, `grid ${label}`);
  const status = (label: string) => byLabel("status", label)?.textContent ?? "";
  const field = (label: string) => document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  const click = (label: string) => document.querySelector<HTMLElement>(`button[aria-label="${label}"]`)!.click();
  const loaded = async (g: Element, what: string) => { await waitFor(() => rowsOf(g).length > 0, 20000, what + " rows"); return rowsOf(g); };
  // the listing shows the code unit containing the address (a string inside a Mach-O header struct is shown at the struct's start)
  const navigated = async (addr: string, what: string) => {
    await waitFor(() => { const r = (window as any).__listing?.rowAt(addr); return r && c.topAddr() === r.address; }, 10000,
      `${what}: listing at ${addr} (is ${c.topAddr()}; status: ${document.querySelector(".status")?.textContent?.slice(0, 60)})`);
  };

  // ---- Symbol table ----
  open("symbols");
  let g = await grid("Symbols");
  let rows = await loaded(g, "symbols");
  const total = (await rpc.call("list_symbols", { limit: 1 })).total;
  await waitFor(() => status("Symbol count").startsWith(`${total} symbols`), 10000, "symbol count " + total);
  need(total >= fl.length, "symbol total below function count");
  click("Sort by Name");
  const byName = await rpc.call("list_symbols", { sort: "name", limit: 3 });
  await waitFor(() => cell(rowsOf(g)[0] ?? document.body, "name") === byName.items[0].name && g.querySelector('[aria-sort="ascending"]'), 10000, "name sort first row");
  const first10 = rowsOf(g).slice(0, 10).map((r) => cell(r, "name").toLowerCase());
  need(first10.every((n, i) => i === 0 || first10[i - 1] <= n), "name order " + first10.join(","));
  click("Sort by Address");
  click("Sort by Address"); // second click = descending
  await waitFor(() => g.querySelector('[aria-sort="descending"]'), 5000, "descending");
  const desc = await rpc.call("list_symbols", { sort: "address", desc: true, limit: 1 });
  await waitFor(() => cell(rowsOf(g)[0] ?? document.body, "name") === desc.items[0].name, 10000, "descending first row");
  click("Sort by Address"); // back to ascending (a third click toggles)
  const nm = fl[Math.min(5, fl.length - 1)].name;
  typeInto(field("Filter symbols"), nm);
  const want = await rpc.call("list_symbols", { query: nm, limit: 1 });
  await waitFor(() => status("Symbol count").startsWith(`${want.total} symbols`), 10000, "filtered count " + want.total);
  rows = await loaded(g, "filtered symbols");
  need(rows.every((r) => cell(r, "name").toLowerCase().includes(nm.toLowerCase())), "filter result names");
  const target = rows.find((r) => cell(r, "address") !== "-")!;
  const tAddr = cell(target, "address"), tKind = cell(target, "kind");
  target.click(); // navigates the listing and opens the function's decompiler tab
  await navigated(tAddr, "symbol click");
  if (tKind === "function") await waitFor(() => c.selected() === tAddr, 20000, "decompiler tab of the clicked function symbol");
  R.symbols = { total, filter: nm, filtered: want.total, clicked: { addr: tAddr, kind: tKind } };
  typeInto(field("Filter symbols"), "");
  (document.querySelector<HTMLInputElement>('input[aria-label="Kind function"]')!).click();
  const fnTotal = (await rpc.call("list_symbols", { kinds: ["function"], limit: 1 })).total;
  await waitFor(() => status("Symbol count").startsWith(`${fnTotal} symbols`), 20000, "kind filter count " + fnTotal);
  rows = await loaded(g, "function symbols");
  need(rows.every((r) => cell(r, "kind") === "function"), "kind filter rows");
  document.querySelector<HTMLInputElement>('input[aria-label="Kind function"]')!.click();
  R.symbols.functions = fnTotal;

  // ---- Strings ----
  open("strings");
  g = await grid("Strings");
  rows = await loaded(g, "strings");
  const sTotal = (await rpc.call("list_strings", { limit: 1 })).total;
  await waitFor(() => status("String count").startsWith(`${sTotal} strings`), 20000, "string count " + sTotal);
  const s0 = rows[0], sAddr = cell(s0, "address"), sVal = cell(s0, "value");
  s0.click();
  await navigated(sAddr, "string click");
  const word = sVal.slice(0, Math.min(6, sVal.length));
  typeInto(field("Filter strings"), word.toUpperCase());
  const sw = await rpc.call("list_strings", { query: word, limit: 1 });
  await waitFor(() => status("String count").startsWith(`${sw.total} strings`), 10000, "string filter count " + sw.total);
  rows = await loaded(g, "filtered strings");
  need(rows.every((r) => cell(r, "value").toLowerCase().includes(word.toLowerCase())), "string filter values");
  typeInto(field("Minimum length"), "99999");
  await waitFor(() => status("String count").startsWith("0 strings"), 10000, "min length hides everything");
  typeInto(field("Minimum length"), "4"); typeInto(field("Filter strings"), "");
  await waitFor(() => status("String count").startsWith(`${sTotal} strings`), 10000, "string count restored");
  // strings -> code: "referenced only" narrows to what the sidecar says is referenced; a "Used by" button goes to the referencing code, not to the string
  const refTotal = (await rpc.call("list_strings", { referencedOnly: true, limit: 1 })).total;
  field("Referenced only").click();
  await waitFor(() => status("String count").startsWith(`${refTotal} strings`), 10000, "referenced-only count " + refTotal);
  rows = await loaded(g, "referenced strings");
  const used = rows[0].querySelector<HTMLButtonElement>(".c-refs button.lnk");
  need(used, "a referenced string shows its referrers");
  const refFrom = (await rpc.call("list_strings", { referencedOnly: true, limit: 1 })).items[0].refFrom![0].from;
  used!.click();
  await navigated(refFrom, "string referrer click");
  field("Referenced only").click();
  await waitFor(() => status("String count").startsWith(`${sTotal} strings`), 10000, "string count after referenced-only off");
  R.strings = { total: sTotal, filter: word, filtered: sw.total, clicked: sAddr, referenced: refTotal, referrer: refFrom };

  // the panel follows a real edit: clear a string with clear_code (through the RPC, as the listing's C key does), the panel must drop it without
  // being touched, and show it again after undo. The string is picked so that its text matches exactly one string (the filter then reads 1 -> 0 -> 1).
  const cands = (await rpc.call("list_strings", { minLength: 8, limit: 60 })).items.filter((i) => i.value.length >= 8 && i.value.length <= 40);
  let pick: (typeof cands)[number] | undefined;
  for (const i of cands) if ((await rpc.call("list_strings", { query: i.value, limit: 1 })).total === 1) { pick = i; break; }
  need(pick, "a string that is unique by its text");
  typeInto(field("Filter strings"), pick!.value);
  await waitFor(() => status("String count").startsWith("1 strings"), 10000, "unique string filter");
  await rpc.call("clear_code", { address: pick!.address });
  await waitFor(() => status("String count").startsWith("0 strings"), 10000, "strings panel to drop the cleared string");
  await rpc.call("undo", {});
  await waitFor(() => status("String count").startsWith("1 strings"), 10000, "strings panel to show the string again after undo");
  typeInto(field("Filter strings"), "");
  await waitFor(() => status("String count").startsWith(`${sTotal} strings`), 10000, "string count after the edit round trip");
  R.strings.refreshAfterEdit = { address: pick!.address };

  // ---- Memory search ----
  open("memsearch");
  await waitFor(() => byLabel("region", "Memory search"), 5000, "memory search panel");
  const f = fl[Math.min(10, fl.length - 1)];
  const lr = await rpc.call("listing_rows", { address: f.entry, count: 4 });
  const bytes = lr.flatMap((r) => r.bytes.split(" ")).slice(0, 4);
  need(bytes.length === 4, "need 4 bytes at " + f.entry);
  const count = async (p: Parameters<typeof rpc.call<"search_memory">>[1]) => {
    let n = 0, start: string | undefined, has = false;
    for (;;) { const r = await rpc.call("search_memory", { ...p, start, limit: 5000 }); n += r.items.length; has ||= r.items.some((i) => i.address === f.entry); if (!r.next) return { n, has }; start = r.next; }
  };
  const setMode = (mode: string) => {
    const sel = document.querySelector<HTMLSelectElement>('select[aria-label="Search type"]')!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, mode); sel.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const search = async (pattern: string, mode: string) => {
    setMode(mode);
    typeInto(field("Search pattern"), pattern);
    await waitFor(() => !document.querySelector<HTMLButtonElement>('button[aria-label="Search memory"]')!.disabled, 5000, "Search enabled");
    click("Search memory");
    await sleep(80); // let React render "searching" so a stale "done" of the previous search is not mistaken for this one
    await waitFor(() => /· (done|cancelled|stopped|error)/.test(status("Search state")), 60000, "search to finish");
    need(!/error/.test(status("Search state")), "search state: " + status("Search state"));
    return Number(/^(\d+) matches/.exec(status("Search state"))![1]);
  };
  const exact = bytes.join(" ");
  const nExact = await search(exact, "bytes"), eRef = await count({ pattern: exact });
  need(nExact === eRef.n && eRef.has, `exact search: panel ${nExact} vs rpc ${eRef.n}, entry found ${eRef.has}`);
  g = await grid("Search results");
  rows = await loaded(g, "search results");
  rows[0].click();
  await navigated(cell(rows[0], "address"), "search result click");
  const wild = `${bytes[0]} ?? ${bytes[2]} ${bytes[3]}`;
  const nWild = await search(wild, "bytes"), wRef = await count({ pattern: wild });
  need(nWild === wRef.n && nWild >= nExact && wRef.has, `wildcard search: panel ${nWild} vs rpc ${wRef.n}`);
  const str = (await rpc.call("list_strings", { minLength: 6, limit: 1 })).items[0];
  let nText = -1;
  if (str && /^[\x20-\x7e]+$/.test(str.value)) {
    nText = await search(str.value, "ascii");
    const t = await rpc.call("search_memory", { pattern: str.value, kind: "text", limit: 5000 });
    need(nText === t.items.length && t.items.some((i) => i.address === str.address), "text search for " + str.value);
  }
  const nU16 = await search("ab", "utf16le");
  // cancel: start a search with a lot of matches and cancel right away; either outcome is fine, none may be an error
  setMode("bytes"); typeInto(field("Search pattern"), "?? ?? ??"); await sleep(50); click("Search memory");
  for (let i = 0; i < 20 && !document.querySelector('button[aria-label="Cancel search"]'); i++) await sleep(5);
  const cancelBtn = document.querySelector<HTMLElement>('button[aria-label="Cancel search"]'); cancelBtn?.click();
  await sleep(80);
  await waitFor(() => /· (done|cancelled|stopped|error)/.test(status("Search state")), 60000, "search to stop after Cancel");
  need(!/error/.test(status("Search state")), "cancel state: " + status("Search state"));
  R.memsearch = { bytes: exact, exact: nExact, wildcard: nWild, text: nText, utf16: nU16, cancelClicked: !!cancelBtn, state: status("Search state") };

  // ---- References: to / from, pinned from a listing row and from a decompiler token ----
  let callee: { entry: string; from: string } | null = null;
  for (const fn of fl.slice(0, 400)) {
    const x = (await rpc.call("xrefs_to", { address: fn.entry })).find((r) => r.kind === "call");
    if (x) { callee = { entry: fn.entry, from: x.from }; break; }
  }
  need(callee, "no called function in the first 400");
  await c.select(callee!.entry);
  const xr = () => byLabel("region", "References to current address")!;
  const xrows = () => [...xr().querySelectorAll<HTMLElement>("button.xr")];
  await waitFor(() => xr().querySelector(".xh")?.textContent?.startsWith(`References to ${callee!.entry}`) && xrows().some((r) => r.querySelector(".xk")?.textContent === "call"), 15000, "references to the callee with a call");
  const cr = xrows().find((r) => r.querySelector(".xk")?.textContent === "call")!;
  const crFrom = cr.querySelector(".a")!.textContent!;
  cr.click();
  await navigated(crFrom, "reference click");
  await waitFor(() => xr().querySelector(".xh")?.textContent?.startsWith(`References to ${crFrom}`), 10000, "panel follows the cursor");
  click("Show references from");
  await waitFor(() => xr().querySelector(".xh")?.textContent?.startsWith(`References from ${crFrom}`) && xrows().some((r) => r.querySelector(".xk")?.textContent === "call"), 15000, "references from the call instruction");
  const callsOut = xrows().filter((r) => r.querySelector(".xk")?.textContent === "call").map((r) => r.querySelector(".a")!.textContent);
  click("Show references from"); // back to "to"
  // X in the listing: pin the cursor row
  const lb = document.querySelector<HTMLElement>(".lbox")!;
  const lrow = [...document.querySelectorAll<HTMLElement>(".lrow:not(.lbl)")][2];
  const lAddr = lrow.querySelector(".a")!.textContent!;
  lrow.click(); lb.focus(); press(lb, "x");
  await waitFor(() => xr().querySelector(".xh")?.textContent?.startsWith(`References to ${lAddr}`) && xr().querySelector('button[aria-label="Follow cursor"]'), 10000, "listing X pins " + lAddr);
  click("Follow cursor");
  await waitFor(() => !xr().querySelector('button[aria-label="Follow cursor"]'), 5000, "follow cursor unpins");
  // X on a decompiler token: a variable/param if the decompiler has one, else a call target
  let tokPick: { f: FunctionInfo; label: string; line: number; col: number; kind: string; text: string } | null = null;
  for (const fn of fl.slice(0, 80)) {
    const d = await rpc.call("decompile", { entry: fn.entry });
    const t = d.tokens.find((t) => (t.kind === "variable" || t.kind === "param") && t.varName) ?? d.tokens.find((t) => t.targetFunction && t.targetFunction !== fn.entry);
    if (t) { tokPick = { f: fn, label: t.varName ?? d.text.split("\n")[t.line].slice(t.colStart, t.colEnd), line: t.line + 1, col: t.colStart + 2, kind: t.varName ? "variable" : "call", text: d.text }; break; }
  }
  need(tokPick, "no decompiler token with references target");
  await c.select(tokPick!.f.entry);
  await waitFor(() => c.editorText() === tokPick!.text, 20000, "decompiler text of " + tokPick!.f.name); // not the previous tab's text, which may contain the same name
  const ed = c.editor();
  need(ed.getAction("gd.xrefs"), "Monaco has the Show References To action");
  ed.setPosition({ lineNumber: tokPick!.line, column: tokPick!.col }); ed.focus();
  await sleep(200);
  const ta = document.querySelector<HTMLElement>(".monaco-editor textarea")!; ta.focus();
  ta.dispatchEvent(new KeyboardEvent("keydown", { key: "x", code: "KeyX", keyCode: 88, which: 88, bubbles: true, cancelable: true } as KeyboardEventInit));
  await waitFor(() => xr().querySelector(".xh")?.textContent?.startsWith(`References to ${tokPick!.label}`) && xr().querySelector('button[aria-label="Follow cursor"]'), 10000, "decompiler X pins " + tokPick!.label);
  const tokRows = xrows().length;
  click("Follow cursor");
  R.xrefs = { callee: callee!.entry, fromAddr: crFrom, callsOut, listingRow: lAddr, token: { kind: tokPick!.kind, label: tokPick!.label, rows: tokRows } };

  click("Close dock");
  await waitFor(() => !byLabel("region", "Symbol table"), 5000, "dock closes");
  need(c.errors.length === errors0, "errors during the flow: " + c.errors.slice(errors0).join("; "));
  return true;
}
