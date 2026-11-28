// Scripted steps for the UI annotations (highlight, Follow agent), modelled on agent-autotest-client.mjs.
// Usage: `await uiSteps(client, { entry, other })` with an SDK Client already connected to the app. `entry` is a function address, `other` another one for the follow step.
// Pair with src/renderer/autotest/autotestAgentUi.ts (`runAgentUiChecks`), which watches the DOM. Throws on the first failed check.
const text = (r) => r.content.map((x) => x.text).join("\n");
const need = (c, m) => { if (!c) throw new Error("agent-ui: " + m); };

export async function uiSteps(client, { entry, other }) {
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }); return { text: text(r), error: !!r.isError }; };
  need((await client.listTools()).tools.some((t) => t.name === "highlight"), "tools/list lacks highlight");
  await call("goto", { address: entry });
  const h = await call("highlight", { addresses: [entry], lines: [{ function: entry, from: 1, to: 3 }], label: "autotest" });
  need(!h.error && /Highlighted 1 addresses and 1 line ranges/.test(h.text), "highlight: " + h.text);
  need((await call("highlight", {})).error, "an empty highlight must be refused");
  await new Promise((r) => setTimeout(r, 3000)); // the app checks the marks
  const c = await call("highlight", { clear: true });
  need(!c.error && /cleared/.test(c.text), "clear: " + c.text);
  await new Promise((r) => setTimeout(r, 1500));
  // with Follow agent on (the app turns it on itself), a read of `other` moves the user's view
  const d = await call("decompile", { function: other });
  need(!d.error, "decompile: " + d.text);
  for (const t = Date.now(); ; ) { const v = await call("get_view"); if (v.text.includes(`@${other}`)) break; need(Date.now() - t < 20_000, "the view never followed to " + other + ": " + v.text); await new Promise((r) => setTimeout(r, 300)); }
}
