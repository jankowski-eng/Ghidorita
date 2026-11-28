// Scripted-client steps for define_types (AUTOTEST_FLOW=agent). The orchestrator passes the connected MCP SDK `Client` of agent-autotest-client.mjs:
//   import { defineTypesSteps } from "./agent-autotest-types.mjs";  const summary = await defineTypesSteps(client, { fail, check });
// Run it while the agent's own edit is the newest change (it ends with undo_agent_edit). The C uses only types both the mock and Ghidra know.
const text = (r) => r.content.map((x) => x.text).join("\n");

export async function defineTypesSteps(client, { fail = (m) => { throw new Error(m); } } = {}) {
  const check = (c, m) => { if (!c) fail(m); };
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }); return { text: text(r), error: !!r.isError }; };
  const R = {};
  check((await client.listTools()).tools.some((t) => t.name === "define_types"), "tools/list lacks define_types");

  const ok = await call("define_types", { c: "struct AgentHdr {\n  int magic;\n  char name[8];\n};" });
  check(!ok.error && /Created:\s+\/AgentHdr/.test(ok.text), "define_types: " + ok.text);
  const dt = await call("data_type", { path: "/AgentHdr" });
  check(!dt.error && /magic/.test(dt.text) && /name/.test(dt.text), "data_type does not show the struct: " + dt.text);
  R.defined = "/AgentHdr";

  // the same C again changes nothing; a different body replaces
  const same = await call("define_types", { c: "struct AgentHdr { int magic; char name[8]; };" });
  check(!same.error && /No type changed/.test(same.text), "an identical redefinition: " + same.text);
  const repl = await call("define_types", { c: "struct AgentHdr { int magic; char name[8]; int flags; };" });
  check(!repl.error && /Replaced:\s+\/AgentHdr/.test(repl.text), "a changed body must say replaced: " + repl.text);

  // a parse error after a valid struct: an instruction with the line, and nothing of the valid struct is defined
  const err = await call("define_types", { c: "struct AgentGood { int a; };\nstruct AgentBad { int b; " });
  check(err.error && /Nothing was defined/.test(err.text) && /line \d+/.test(err.text), "the parse error text: " + err.text);
  const gone = await call("data_type", { path: "/AgentGood" });
  check(gone.error, "the valid struct before the parse error must not exist: " + gone.text);

  // our replace is the newest change: undo_agent_edit takes exactly it back (the struct returns to the first body)
  const undo = await call("undo_agent_edit");
  check(!undo.error && /Define types from C/.test(undo.text), "undo_agent_edit: " + undo.text);
  const back = await call("data_type", { path: "/AgentHdr" });
  check(!back.error && !/flags/.test(back.text), "the undo did not restore the first body: " + back.text);
  return R;
}
