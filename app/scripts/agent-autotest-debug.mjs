// The debugger steps of AUTOTEST_FLOW=agent: a scripted MCP client against the mock's fake target (mock/server.mjs), Full access.
// Usage: import { debugSteps } and call it with a connected SDK `Client` while the app watches (renderer/autotest/autotestAgentDebug.ts).
// Throws an Error naming the failed check; resolves with a summary object.
const text = (r) => r.content.map((x) => x.text).join("\n");

export async function debugSteps(client) {
  const R = {};
  const check = (c, m) => { if (!c) throw new Error("debug steps: " + m); };
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }); return { text: text(r), error: !!r.isError }; };
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ["debug_attach", "debug_state", "debug_step", "debug_continue", "debug_pause", "debug_breakpoint", "debug_values", "debug_memory", "debug_detach"]) check(names.includes(n), `tools/list lacks ${n} (is the access mode Full and the provider's debugger capability on?): ${names}`);
  const at = (t) => /(?:Attached; stopped|Stopped) at (0x[0-9a-f]+)/.exec(t)?.[1];

  const attached = await call("debug_attach", {});
  check(!attached.error && at(attached.text), "attach: " + attached.text);
  check(/Registers: .*r0=/.test(attached.text), "attach shows registers: " + attached.text);
  const first = at(attached.text);
  R.attach = first;
  check((await call("debug_attach", {})).error, "a second attach must be refused");

  const st = await call("debug_state");
  check(at(st.text) === first, "debug_state: " + st.text);
  const vals = await call("debug_values");
  check(!vals.error && /^\S+ @0x[0-9a-f]+, pc /.test(vals.text) && /local|param/.test(vals.text), "debug_values: " + vals.text);
  const mem = await call("debug_memory", { address: first, length: 32 });
  check(!mem.error && /^32 bytes at /.test(mem.text) && mem.text.split("\n").length === 3, "debug_memory: " + mem.text);

  const step = await call("debug_step", { mode: "statement" });
  const second = at(step.text);
  check(!step.error && second && second !== first && /\* ?changed|\*/.test(step.text), "statement step: " + step.text);
  R.step = second;
  const stepi = await call("debug_step", { mode: "instruction" });
  const third = at(stepi.text);
  check(!stepi.error && third && third !== second, "instruction step: " + stepi.text);

  // a breakpoint four bytes on: continue stops there (the mock runs for 250 ms first)
  const bp = "0x" + (parseInt(third, 16) + 4).toString(16);
  check(/set at/.test((await call("debug_breakpoint", { address: bp })).text), "breakpoint set");
  const cont = await call("debug_continue", { waitSecs: 20 });
  check(at(cont.text) === bp, `continue should stop at ${bp}: ${cont.text}`);
  R.continued = bp;
  check(/cleared at/.test((await call("debug_breakpoint", { address: bp })).text), "breakpoint cleared");

  // nothing to stop it: the wait times out, the target keeps running, pause stops it
  const run = await call("debug_continue", { waitSecs: 1 });
  check(!run.error && /Still running.*debug_pause/.test(run.text), "continue without a breakpoint: " + run.text);
  check((await call("debug_state")).text === "Running.", "state while running");
  check((await call("debug_step")).error, "stepping a running target must be refused");
  const paused = await call("debug_pause");
  check(!paused.error && at(paused.text), "pause: " + paused.text);

  check(!(await call("debug_detach")).error, "detach");
  check((await call("debug_step")).text.includes("Not attached"), "step after detach");
  return R;
}
