Implement phase 2 of Ghidorita's agent access over MCP: the headless host, Full mode, more reads, debugger tools, UI annotations, C type parsing and atomic agent undo.

Phase 1 (app mode, Read and Edit) is built on branch `agent-mcp-phase1`.

- **Spec:** `docs/AGENTS_MCP.md`, especially "Phase 1 as built" at the end. Where that section and the earlier design disagree, the as-built section is the truth.
- **Plan:** `docs/AGENTS_MCP_PLAN.md`. Phase 2 = step 0b, wave 2 with streams F–L, step 3.

Read both completely first. Then read the phase 1 code you'll build on:

- `app/src/agent/` (`types.ts`, `access.ts`, `tools/*`)
- `app/src/main/agent.ts` and `app/src/main/menu.ts`
- `app/src/mcp/bridge.ts`: it no longer launches the app at startup, and it switches to the app when the app appears
- `app/src/renderer/features/agent.ts`
- `app/src/renderer/rpc.ts` and `backend.ts`
- `app/ARCHITECTURE.md`, whose layering rules are enforced by `test/layering.test.mjs` and `test/backend-boundary.test.mjs`

If the code contradicts the plan, the code wins: adapt, and record the deviation in the design doc.

## How to work

You are the orchestrator. Do step 0b and step 3 yourself, and delegate wave 2 to subagents.

### 1. Baseline and step 0b, yourself

1. Create branch `agent-mcp-phase2` from `agent-mcp-phase1` (or from `main` if phase 1 has been merged there).
2. Run `npm --prefix app run typecheck` and `npm --prefix app test`, and the sidecar tests you can run. Note any failures that already exist, so streams don't get blamed for them.
3. Step 0b:
   - Move `createAgentExecutor` and `changeView` out of `renderer/features/agent.ts` into `app/src/agent/host.ts`, with no behaviour change. First confirm the executor really uses nothing renderer-only; if it does, inject that through `ExecutorDeps`.
   - Add an `onCall(tool, args, client)` observer to `ExecutorDeps`. It is called when a call starts, for J's "Follow agent".
   - Update the layering test so `src/agent/host.ts` follows the same import rules as the rest of `src/agent/`.
   - Tests pass, commit.

### 2. Wave 2: seven subagents in parallel

Send all seven Agent calls in one message, each with `isolation: "worktree"`, so each branches from the step 0b commit.

Each subagent knows nothing but its prompt, so each prompt must contain:

- its row from the plan's wave 2 table, copied verbatim, plus the ownership rules that apply to it
- the paths of the design doc (including "Phase 1 as built"), the plan, and the phase 1 files it builds on, to read first
- **file ownership:** the files it may create or change. Everything else is read-only, except one import + spread line in `app/src/agent/tools/index.ts`, and its own additions to `AUTOTEST_FLOW=agent` in a separate function the orchestrator will call. **No stream changes `src/agent/host.ts`.** If a stream needs a change there, or in `types.ts` beyond what its row allows, it stops and reports the change instead of making it.
- **who else touches shared files**, so it keeps its edits small and local:
  - F, K and L all touch `rpc.ts`
  - K and L both touch `protocol.md`, `protocol.ts`, `wire.ts`, `backend.ts`
  - G and J both touch `main/menu.ts`
- **setup:**
  - The worktree has no `node_modules`: run `npm ci` in `app/`, or symlink `app/node_modules` from the main checkout if that fails.
  - Streams with sidecar tests (K, L) use the main checkout's `sidecar/.venv/bin/python`, running pytest from the worktree's `sidecar/`. They set `GHIDRA_INSTALL_DIR` and `JAVA_HOME` as in `docs/DEVELOPMENT.md`, pointing at the main checkout's `ghidra-install`. `git worktree list` shows the main checkout's path.
- **constraints:**
  - follow `app/ARCHITECTURE.md`; `src/agent/` imports only what the layering test allows
  - main validates every IPC payload
  - every new tool sets `access`, `capability`, `appOnly` and all annotations correctly
  - output is capped through `format.ts`
  - binary-derived text is escaped as phase 1 does
  - errors are agent-facing instructions (`errors.ts`)
  - no new dependencies
  - keep the code style: dense, comments only for the why
  - a new sidecar method gets a mock implementation in `app/mock/server.mjs` if the autotest flow needs it
- **done means:** its tests are written and pass, `typecheck` and the full `npm test` pass (plus the sidecar tests it touched), and the work is committed on its worktree branch.
- **report back:**
  - branch name
  - files changed
  - what it tested and how
  - deviations from the design, with reasons
  - anything left undone
  - any change it needs in a file it doesn't own

Stream-specific points to put in the prompts:

- **F (headless host), the largest and riskiest stream:**
  - **Startup.** `Ghidorita --agent-host` runs with no window and the dock icon hidden. It launches the provider through `providerLaunch` and creates a `WebSocketBackend` in main. The boundary test then has to allow exactly that one import of `rpc.ts` outside `main.tsx`: change the test explicitly, don't weaken it in general.
  - **Executor.** Build a headless `ExecutorDeps` around `createAgentExecutor` from `src/agent/host.ts`:
    - no `ui`, so `appOnly` tools aren't listed (`visibleTools(..., {headless: true})`)
    - `functions()` from `ops.functions.list()`
    - its own `ChangeLog` instance, fed through `WebSocketBackend`'s `onEdit` hook, so attribution and `undo_agent_edit` work headless
  - **How the bridge starts it.** Read how the bridge behaves today: it never launches at startup, falls back while the app is absent, and switches to the app when it appears. Make `--headless` (and the fallback's `status` tool, as with `launch`) start the host instead of the app. The host then owns the socket, and every later bridge connects to it.
  - **Lifetime.** The host exits after the last connection closes plus a grace period. The sidecar saves on shutdown.
  - **Handover.** When the user launches the app while a host runs, the app asks the host to quit over the socket. Pick a mechanism (a control message that isn't MCP, or a second control socket, protected by the same file permissions) and document it. The host saves and exits, the app takes over, and connected bridges switch to the app through their existing logic. The app and the host are the same executable, so a single-instance lock must not simply block the app while a host runs.
  - **Phase 1 follow-ups F also owns:**
    - a single-instance guard against two apps racing for a stale socket after a crash
    - checking the socket's owner when `GHIDORITA_AGENT_SOCKET` or `XDG_RUNTIME_DIR` is used
  - **E2E:** two bridges share one host; the app launches and takes over without losing an agent's edit; the host exits after the last client.
- **G (Full mode):**
  - Offer Full in the Agent menu.
  - `patch`: assembles first and reports `overwrites`. It writes past the unit only with an explicit `overwriteFollowing: true`.
  - `save`: Full only, and its description says that it ends the user's undo history.
  - `export`: absolute paths only.
  - `open_program` / `close_program`: `access: "edit"`. Below Full in app mode they call `ctx.ui.confirm` first, naming the program being replaced. In Full mode, or headless, there's no prompt.
  - `load_coverage`: returns a per-function coverage summary only. Tinting the app is out of scope; note it as a follow-up.
- **H (more reads):**
  - `pcode`, `value_trail` (by variable name, or by decompiler line and column), `function_graph`, bookmarks list, `list_undefined_refs`.
  - Same output style and paging as `tools/read.ts`.
- **I (debugger):**
  - All tools are Full only (attach connects to a network host).
  - They wait for the next `debug_state` stop through `ctx.backend.events.onDebug`, filtered to the session, with a timeout and honouring `ctx.signal`.
  - Statement stepping needs boundaries from the decompiler's line mapping. Reuse the pure helpers in `renderer/debug.ts` if the layering test can allow them (pure modules only); otherwise compute them in the tool.
  - E2E against the mock's debugger, like `AUTOTEST_FLOW=debug`.
- **J (UI annotations):**
  - A `highlight` tool (app only): addresses or decompiler lines, tinted with the existing value-trail highlighting. It is cleared by a new highlight, an explicit clear, or a program change.
  - "Follow agent" in the Agent menu: when on, the view navigates to the function a read tool targets, using the step 0b `onCall` observer and `useNavigation().go`. It is off by default.
  - J must not change `src/agent/host.ts`.
- **K (C type parsing):**
  - A sidecar `parse_c_types {c, category?}` using Ghidra's `CParser` into the program's data type manager.
  - One transaction with an undo label, firing `program_changed` kind `type`.
  - Returns the created or replaced type paths.
  - Parse errors are `InvalidArgument` with Ghidra's message and line.
  - Gated by a new capability. Documented in `protocol.md` and `protocol.ts`, added to `wire.ts` / `backend.ts` / `rpc.ts`, plus a mock implementation.
  - Then a `define_types` tool (`access: "edit"`) whose change-log entry is attributed like the other edits. `changeLog.ts` must know the new edit name.
- **L (atomic agent undo):**
  - An optional `expect` on the sidecar's `undo` (`domains/program.py`): undo only if the top step's name still equals it, else `InvalidArgument`. Gated by a capability, plus the mock.
  - `undo_agent_edit` passes the undo name it checked, and keeps the phase 1 behaviour when the provider lacks the capability.

While they run, don't do their work yourself. Wait for all seven reports. If a stream reports a needed change in a file it doesn't own, make it yourself on `agent-mcp-phase2` after the merges, or hand it back to that stream with SendMessage.

### 3. Step 3, yourself

1. Merge in this order: K, L, G, H, I, F, J. Run typecheck and tests after each merge and resolve conflicts.
2. Combine the streams' autotest additions into `AUTOTEST_FLOW=agent`: a Full-mode run, a headless run, the debugger steps against the mock, a highlight, `define_types`, and `undo_agent_edit` with `expect`. Run it against the mock, and against PyGhidra through `sidecar/test_provider_ui.py` if the setup is available here. If it isn't, say so; don't fake it.
3. Spawn one review subagent with no worktree. Give it the diff of `agent-mcp-phase2` against `agent-mcp-phase1` and the design doc, but not your conclusions. Ask it for correctness bugs and security holes, prioritising:
   - the headless handover and anything that could lose unsaved edits or let two sidecars share a projects dir
   - socket ownership and the single-instance guard
   - Full-mode gating (`save`, `patch`, `export`, debugger attach), and the confirm path for open/close below Full
   - the debugger wait (leaked listeners, stale-session stops, cancellation)
   - `parse_c_types` transaction handling and rollback on a parse error
4. Fix what it confirms and re-run the tests.

### 4. Shake-down

1. MCP Inspector against the bridge in both modes: the app running on the mock in Full mode, then `--headless`.
2. Tune descriptions and error wording from what you see.
3. Update the README ("Use with an agent", including headless), `app/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, and in `docs/AGENTS_MCP.md` the status line plus a "Phase 2 as built" section (deviations, known limits, follow-ups).
4. Real Claude Code and Codex sessions need me. Finish with the exact setup commands for app mode and headless, and a short test script of six to eight prompts covering:
   - a headless triage of a sample
   - a patch
   - `define_types` from a C struct
   - a debugger session on the mock
   - a highlight

## Rules

- Commit after each step on `agent-mcp-phase2`. Don't push or open a PR unless I ask.
- Don't weaken or skip existing tests to make new code pass.
- If something in the design turns out wrong or impossible (for example, Ghidra's `CParser` can't run headless in the sidecar, or a clean handover isn't possible), stop and tell me, with a proposed alternative, before building around it.
- The final report covers:
  - what works, verified and how
  - what is untested
  - every deviation from the design
  - remaining follow-ups
