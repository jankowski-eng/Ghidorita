# Agent access over MCP: implementation plan

This plan implements [AGENTS_MCP.md](AGENTS_MCP.md). Steps in the same **wave** touch separate files and can run in parallel, each on its own branch or worktree. A wave starts only after the wave before it has merged. Sizes are relative: S, M, L.

Defaults chosen for the design's open questions, so the work isn't blocked (change them in step 0 if you disagree):

- **Access mode:** Edit after access is first enabled; Off before that.
- **Opening programs in app mode:** allowed, with an in-app confirm.
- **Headless projects dir:** shared with the app, with the handover in step F.

```
Phase 1     0 ──▶ [ A  B  C  D  E ] ──▶ 1 ──▶ 2
Phase 2     0b ──▶ [ F  G  H  I  J  K* L ] ──▶ 3   * K's sidecar half can start any time
```

Phase 2 is what used to be phases 2 and 3, run as one wave. The order between them was a priority, not a dependency: all streams build on phase 1, and none needs another's output. Stream L picks up a phase 1 follow-up.

## Phase 1: app mode, Read and Edit

### Step 0: contracts (serial, S, one person)

Everything else builds on these. Keep the step small and merge it fast.

- `app/src/agent/types.ts`:
  - `ToolDef` `{name, description, inputSchema, annotations, access: "read" | "edit" | "full", appOnly?, capability?, timeoutSecs, handler}`
  - `ToolCtx` `{ops, backend, ui?, signal, client}`
  - `AgentUi` `{view(), goto(addr), confirm(msg)}`
  - `AccessMode`
  - the IPC shapes `AgentCall`, `AgentReply`, `AgentCancel`
- `app/src/agent/tools/index.ts`: the tool table with only `status`. Later steps add their own files and one import line each.
- `app/src/agent/resolve.ts`: `resolveAddress` and `resolveFunction` on top of `parseGoto.ts`, with ambiguity errors that list candidates, plus `test/agent-resolve.test.mjs`. It lives here because C and D both need it.
- `app/src/agent/socketPath.ts`: the per-platform path, the `GHIDORITA_AGENT_SOCKET` override, and the long-path fallback. Main and the bridge both use it.
- `app/src/preload/index.ts`: add `onAgentCall`, `agentReply` and `onAgentCancel` to `Host` (types and the `ipcRenderer` wiring).
- Add the `@modelcontextprotocol/sdk` dependency. Check its current `Server` and stream-transport API, and pin the version.

### Wave 1: five parallel streams

| Step | Owns | Does | Size |
|---|---|---|---|
| **A** Bridge | `app/src/mcp/bridge.ts`, `scripts/build-bridge.mjs`, `package.json` build script, `packaging/` wrapper and `extraResources`, `test/agent-bridge.test.mjs` | Pipes stdio to the socket. `--launch` starts the app and waits for the socket. Without the app it serves its own `initialize` and `status` that say Ghidorita isn't running. Built like `build-fixture.mjs`. Test: a fake socket server echoes, and the "app not running" reply is checked | S |
| **B** Main MCP server | `app/src/main/agent.ts`, `app/src/main/menu.ts` (Agent menu, Help › Copy Agent Setup), small hook in `app/src/main/index.ts`, `test/agent-main.test.mjs` | Listens on the socket and handles stale sockets. One SDK `Server` per connection. `tools/list` filtered by mode and app-only flags. Calls forwarded over IPC with timeout and cancel. Mode saved in userData, `list_changed` sent on change, `clientInfo` passed to the renderer. Test: stub renderer with `stub-electron.mjs` | M |
| **C** Read tools | `app/src/agent/tools/read.ts`, `app/src/agent/format.ts`, `test/agent-read.test.mjs` | `list_functions`, `decompile`, `disassemble`, `xrefs`, `calls`, `call_graph`, `search`, `strings`, `read_bytes`, `stack_frame`, `data_type`, `search_types`, `wait_for_analysis`. Formatters, the ~30k-character cap, continuation lines, `Failure` → agent-facing messages, `Job.cancel` on `signal`. Test: an in-memory `ApplicationBackend` (as in `session.test.mjs`) | L |
| **D** Edit tools | `app/src/agent/tools/edit.ts`, `app/src/renderer/changeLog.ts`, `test/agent-edit.test.mjs`, `test/changelog.test.mjs` | The rename, retype, comment, signature, define data, create function and label, bookmark, and type tools. One retry on `cancelled`. `by` on `Change`, plus the agent-params `WeakSet` that `record` checks. `undo_agent_edit` with the newest-entry and `undoName` guard | M |
| **E** Renderer executor | `app/src/renderer/features/agent.ts`, `app/src/renderer/StatusBar.tsx`, `app/src/renderer/App.tsx` or `features/bootstrap.ts` wiring | `useAgent`: receives `agent-call`, binds `ops` to the active session, implements `AgentUi` (the view from the `views` store, `goto` through `useNavigation().go(addr, "agent")`, `confirm` through `Confirm.tsx`), keeps a cancel map, replies. Status-bar "Agent: <client>" with an activity pulse. Tested against the stub tool table from step 0 | M |

Notes:
- C and D share only `resolve.ts`, which is already merged in step 0, and append one line each to `tools/index.ts`. That merge conflict is trivial.
- E needs a `"agent"` value in `nav.ts`'s `Source` type. It's a one-line change inside E's scope.
- If fewer people are available, B + E are the critical path (main ⇄ renderer). A, C and D fit around them.

### Step 1: integration (serial, M)

- Merge A–E, connect `tools/index.ts`, and add `capabilities.ts` gating so a tool whose provider capability is missing isn't listed. Extend `test/capabilities.test.mjs`.
- Extend `test/layering.test.mjs` and `test/backend-boundary.test.mjs`: `src/agent/` may import `backend.ts` and `protocol.ts`, never `rpc.ts`, `wire.ts`, React, or the store.
- `AUTOTEST_FLOW=agent` in `autotest/autotestFlows.ts`, against the mock (`mock/server.mjs`). A scripted MCP client goes through the real bridge and socket and runs status → `decompile` → `rename_variable` → `undo_agent_edit`. It checks the Changes panel entry and its `by` tag, and that the listing refreshed.
- Add the same flow to `sidecar/test_provider_ui.py` against PyGhidra.

### Step 2: shake-down (serial, S)

- Run MCP Inspector on the bridge, then real Claude Code and Codex sessions on `sidecar/testdata` samples. Tune tool descriptions, output caps and error wording from what the agents actually do.
- Docs: README "Use with an agent", `app/ARCHITECTURE.md` (the agent layer), and the status line in `AGENTS_MCP.md`.

## Phase 2: headless host, Full mode, debugger, UI annotations, C types

### Step 0b: shared executor (serial, S, one person)

`createAgentExecutor` in `renderer/features/agent.ts` is already React-free. Move it, with `changeView`, into `app/src/agent/host.ts`, with no behaviour change, so the headless host (F) can reuse it. Add an `onCall(tool, args, client)` observer to `ExecutorDeps` for J's "Follow agent". Update the layering test, run the tests and commit. Afterwards neither F nor J needs to change the executor, which removes their only real collision.

### Wave 2: seven parallel streams

| Step | Owns | Does | Size |
|---|---|---|---|
| **F** Headless host | `app/src/main/index.ts` (the `--agent-host` branch), `app/src/main/agent.ts`, `app/src/mcp/bridge.ts` (`--headless`) | Electron with no window; providers launched through `providerLaunch`; a Node `WebSocketBackend` running the `src/agent/` handlers without UI. Owns the socket, exits on the last disconnect plus a grace period, and hands over to the app when the user launches it (quit, save, app takes over). E2E: two bridges share one host, then the app launches and takes over | L |
| **G** Full-mode tools | `app/src/agent/tools/full.ts`, `app/src/main/menu.ts` (offer Full in the Agent menu) | `patch` (assemble, report `overwrites`, apply), `list_patches`, `save`, `export`, `open_program` / `close_program` (confirm below Full in app mode), `load_coverage` | M |
| **H** More reads | `app/src/agent/tools/read2.ts` | `pcode`, `value_trail`, `function_graph`, bookmarks list, `list_undefined_refs` | S |
| **I** Debugger tools | `app/src/agent/tools/debug.ts` | `debug_attach`, `debug_step`, `debug_continue`, `debug_values`, `debug_memory`. They wait for the next `debug_state` stop with a timeout. E2E with the mock's debugger, like `AUTOTEST_FLOW=debug` | M |
| **J** UI annotations | `app/src/renderer/` (`Listing.tsx`, `Decompiler.tsx`, the `AgentUi` implementation), `app/src/agent/types.ts` (`AgentUi` additions), `app/src/agent/tools/ui.ts`, the "Follow agent" item in `app/src/main/menu.ts`; not the executor | A `highlight` tool (addresses or decompiler lines, reusing the value-trail highlighting) and a "Follow agent" toggle (the view tracks what the agent reads) | M |
| **K** C type parsing | Sidecar: `domains/datatypes.py`, `protocol.md`, `protocol.ts`, `test_datatypes.py`. App: `wire.ts`, `backend.ts`, `rpc.ts`, `app/src/agent/tools/types.ts` | A `parse_c_types` RPC with Ghidra's `CParser` (one transaction, undo label), then a `define_types` tool. **The sidecar half has no dependency on any agent work and can start right now**, in parallel with phase 1 | M |
| **L** Atomic agent undo | Sidecar: `domains/program.py` (`undo`), `protocol.md`, `protocol.ts`, sidecar tests. App: `wire.ts`, `backend.ts`, `rpc.ts` (the `undo` params only), `app/src/agent/tools/edit.ts` | An optional `expect` on `undo` (the undo name the caller saw): the sidecar undoes only if the top step still has that name, else `InvalidArgument`. `undo_agent_edit` passes it. This closes the gap phase 1 left between the guard's check and the undo. Capability-gated, so providers without it keep the phase 1 behaviour | S |

Ownership rules (they are what keeps the streams from colliding):

- **Nobody changes the executor in `src/agent/host.ts`** (step 0b). F builds a headless `ExecutorDeps` around it. J uses the `onCall` observer and adds `highlight` to `AgentUi`. A stream that finds it needs an executor change stops and reports it.
- **G and J both touch `main/menu.ts`**: G adds Full to the access items, J adds "Follow agent". Separate lines in the same menu.
- **F, K and L all touch `rpc.ts`** (and K and L also `protocol.*`, `wire.ts`, `backend.ts`). F only for whatever `WebSocketBackend` needs under Node's `WebSocket`; K only for its new method; L only for the `undo` params. Small, separate edits: tell each stream about the others.
- Everything else shared is trivial: one import line per stream in `src/agent/tools/index.ts`, and each stream's additions to the `AUTOTEST_FLOW=agent` flow, which step 3 combines.
- G does not wait for F. Its tools work in app mode; whether they also run headless is checked in step 3.

If seven streams are too many to merge and review at once, run F, J and K first (the large or risky ones) and G, H, I and L after (small, conflict-free).

### Step 3: integration (serial, M)

Merge F–L. Suggested order: K, L, G, H, I, then F, then J. Extend the agent autotest flow with a Full-mode run, a headless run (two bridges share one host, then the app takes over), the debugger steps against the mock, and a highlight. Update the docs.

## Running it

- One worktree per step in a wave, and one branch per step merged into a phase branch. Integration steps run on the phase branch.
- Every step leaves its own tests passing: `npm --prefix app run typecheck`, `npm --prefix app test`, and the sidecar tests for K.
- Highest risk: B ⇄ E. Agree the IPC shapes in step 0 so they can be built apart, and test each against a stub of the other.
