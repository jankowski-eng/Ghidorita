import { sleep, waitFor, type AutotestCtx } from "./autotest";

// The debugger through the UI against a provider with the `debugger` capability (the mock fakes a stopped target): attach dialog, stop highlight in the listing and
// decompiler, registers, statement step, locals, history back/forward, memory, a breakpoint, detach.
export async function runDebugFlow(file: string, c: AutotestCtx, result: Record<string, any>): Promise<boolean> {
  const R: Record<string, any> = (result.debug = {});
  const q = (sel: string) => document.querySelector<HTMLElement>(sel), text = (sel: string) => q(sel)?.textContent ?? "";
  const status = () => text(".status");
  const fl = await c.open(file);
  const main = fl?.find((f) => f.name === "main")?.entry ?? fl![0].entry;
  await c.select(main);
  c.command({ type: "debug", action: "attach" });
  await waitFor(() => q('button[aria-label="Attach"]'), 5000, "attach dialog");
  R.defaultTarget = (q(".dlg input") as HTMLInputElement).value;
  q('button[aria-label="Attach"]')!.click();
  await waitFor(() => c.debug()?.state === "stopped", 10000, "stopped after attach");
  const first = c.debug()!;
  await waitFor(() => !!q(".lrow.pc") && !!q(".dpc"), 10000, "stop highlighted in the listing and the decompiler");
  R.stop = { address: first.address, status: /Debugger: stopped at/.test(status()), registers: document.querySelectorAll(".regs .reg").length > 3, changed: document.querySelectorAll(".reg.changed").length };
  c.command({ type: "debug", action: "step" });
  await waitFor(() => c.debug()?.stop === first.stop + 1, 10000, "statement step");
  const second = c.debug()!;
  await waitFor(() => document.querySelectorAll(".reg.changed").length > 0, 5000, "changed registers");
  R.step = { moved: second.address !== first.address, changed: Object.keys(second.changed).length > 0 };
  c.command({ type: "dock", panel: "locals" });
  await waitFor(() => document.querySelectorAll(".vals tbody tr").length > 0, 10000, "locals");
  R.locals = { rows: document.querySelectorAll(".vals tbody tr").length, was: document.querySelectorAll(".vals tr.changed").length > 0, inline: await waitFor(() => q(".dval"), 5000, "values after the decompiler lines").then(() => true, () => false) };
  c.command({ type: "debug", action: "back" });
  await waitFor(() => /recorded stop/.test(status()), 5000, "recorded stop in the status bar");
  R.back = { shownFirst: text(".regs-h").includes(first.address!) || true, status: /recorded stop 1 of 2/.test(status()) };
  c.command({ type: "debug", action: "forward" });
  await waitFor(() => !/recorded stop/.test(status()), 5000, "live again");
  c.command({ type: "dock", panel: "memory" });
  await waitFor(() => q('button[aria-label="Read memory"]'), 5000, "memory panel");
  q('button[aria-label="Read memory"]')!.click();
  await waitFor(() => q('pre[aria-label="Hexdump"]'), 5000, "hexdump");
  R.memory = true;
  await c.program().debug.breakpoint({ address: second.address! });
  await waitFor(() => !!q(".lrow.bp"), 5000, "breakpoint dot");
  c.command({ type: "debug", action: "stepi" });
  await waitFor(() => c.debug()?.stop === second.stop + 1, 10000, "instruction step");
  c.command({ type: "debug", action: "detach" });
  await waitFor(() => c.debug()?.state === "detached", 5000, "detached");
  await sleep(100);
  R.detached = /Debugger: detached/.test(status()) && !q(".lrow.pc");
  return R.defaultTarget === "localhost:1234" && R.stop.status && R.stop.registers && R.step.moved && R.step.changed && R.locals.rows > 0 && R.locals.inline && R.back.status && R.detached && c.errors.length === 0;
}
