Implement phase 1 of Ghidorita's agent access over MCP: app mode with read and edit tools.

The design is `docs/AGENTS_MCP.md`. The step-by-step plan is `docs/AGENTS_MCP_PLAN.md` (phase 1 = step 0, wave 1 with streams A–E, step 1, step 2). Read both completely before doing anything. Then read:

- `app/ARCHITECTURE.md` (the layering rules are enforced by tests)
- `protocol.md` (skim; it is the reference for what each sidecar method does)
- `app/src/renderer/backend.ts` and `rpc.ts`
- `app/src/renderer/changeLog.ts`
- `app/src/renderer/parseGoto.ts`
- `app/src/renderer/features/navigation.ts`
- `app/src/main/index.ts`, `menu.ts` and `providers.ts`
- `app/src/preload/index.ts`

The design and plan are the spec. If the code contradicts them, the code wins: adapt, and write the deviation into the design doc rather than forcing the design.

## How to work

You are the orchestrator. Do step 0 and the integration steps yourself, and delegate wave 1 to subagents.

### 1. Step 0, yourself

1. Create a branch `agent-mcp-phase1` from the current branch.
2. Before you add `@modelcontextprotocol/sdk`, check its current API: `Server`, `setRequestHandler` for tools/list and tools/call, a transport over an arbitrary duplex stream (a `net.Socket`), `notifications/cancelled` and `tools/list_changed`. Use the package's own README and types in `node_modules`, not memory, and pin the exact version.
3. Write the step 0 files exactly as the plan lists them. Make the types precise and documented: every stream builds against them without talking to the others.
4. Write `test/agent-resolve.test.mjs` in the repo's test style (esbuild transform or bundle of the TS source, `node:test`; see `test/changelog.test.mjs` and `test/capabilities.test.mjs`).
5. Run `npm --prefix app run typecheck` and `npm --prefix app test`. Both must pass.
6. Commit.

### 2. Wave 1: five subagents in parallel

Send all five Agent calls in one message, each with `isolation: "worktree"`, so they branch from the step 0 commit and can't trample each other's files or test runs.

Each subagent knows nothing but its prompt, so each prompt must contain:

- its step row from the plan, copied verbatim, plus the plan's notes that apply to it
- the paths of the two design docs and the step 0 files, to read first
- **file ownership:** the files it may create or change. Anything else is read-only, except one import line in `app/src/agent/tools/index.ts` for C and D, and the `"agent"` value in `nav.ts`'s `Source` type for E. If it believes a step 0 type must change, it stops and reports the needed change instead of editing it.
- **setup:** the worktree has no `node_modules`. Run `npm ci` in `app/` (or symlink `app/node_modules` from the main checkout if `npm ci` fails offline).
- **constraints:**
  - follow `app/ARCHITECTURE.md`; `src/agent/` imports only `backend.ts`, `protocol.ts` and step 0 files
  - validate every IPC payload in main, as the existing handlers do
  - no new dependencies beyond the step 0 one
  - keep the code style: dense, few comments, comments only for the why
- **done means:** its tests are written and pass, `typecheck` and the full `npm test` pass in its worktree, and the work is committed on its worktree branch.
- **report back:**
  - branch name
  - files changed
  - what it tested and how
  - deviations from the design, with the reason
  - anything left undone

Stream-specific points to put in the prompts:

- **A (bridge):**
  - The bridge is a byte pipe and must not parse MCP, except for the "app not running" fallback, which answers `initialize`, `tools/list` and `tools/call status` itself.
  - Build it to `out/mcp/bridge.cjs` the way `scripts/build-fixture.mjs` builds the fixture provider.
- **B (main):**
  - Test with a stub renderer through `test/stub-electron.mjs`.
  - Main must refuse calls outside the access mode even when the client never re-fetched the tool list.
  - Each call times out after the tool's `timeoutSecs` plus a margin, with a clear "window not ready" error when the renderer isn't listening.
- **C (read tools):**
  - Test against an in-memory `ApplicationBackend` (see how `test/session.test.mjs` builds one).
  - Cover output caps and continuation, name resolution through `resolve.ts`, `Failure` → message mapping, and cancellation (`signal` aborts → `Job.cancel()` called).
- **D (edit tools):**
  - Every edit name must stay known to `changeLog.ts`; `test/changelog.test.mjs` checks this. Extend it for the `by` tag and the `undo_agent_edit` guard.
  - Retry once on `cancelled` and only then report it.
- **E (renderer):**
  - Test the executor's call/reply/cancel handling against the stub tool table.
  - `goto` must go through `useNavigation().go`, never set view state directly.
  - `confirm` uses the existing `Confirm.tsx` dialog machinery.

While they run, don't do their work yourself. Wait for all five reports.

### 3. Step 1, yourself

1. Merge the five branches into `agent-mcp-phase1` one at a time (A, C, D, B, E). Run typecheck and tests after each merge and resolve conflicts.
2. Then do step 1 from the plan:
   - capability gating of tools
   - layering and boundary test extensions
   - `AUTOTEST_FLOW=agent` against the mock (`MOCK=1`), driven by a scripted MCP client through the real bridge and socket
   - the same flow in `sidecar/test_provider_ui.py` (needs the PyGhidra setup from `docs/DEVELOPMENT.md`; if it isn't available here, say so and skip it rather than faking it)
3. Then spawn one review subagent with no worktree. Give it the diff of `agent-mcp-phase1` against its base and the design doc, but not your own conclusions. Ask it to look for correctness bugs and security holes, with priority on:
   - the main ⇄ renderer IPC: validation, timeouts, cancel races, renderer reloads
   - access-mode enforcement
   - socket permissions and stale-socket handling
   - the `undo_agent_edit` guard
4. Fix what it confirms and re-run the tests.

### 4. Step 2

1. Run what you can yourself: MCP Inspector (`npx @modelcontextprotocol/inspector`) against `node app/out/mcp/bridge.cjs` with the app running on the mock.
2. Tune tool descriptions, caps and error messages from what you see.
3. Update the README and `app/ARCHITECTURE.md`, and set the status line in `docs/AGENTS_MCP.md`.
4. The real Claude Code and Codex sessions on a sample binary need me. Finish with the exact setup commands and a short test script (five or six prompts to try) for me to run.

## Rules

- Commit after each step on `agent-mcp-phase1`. Don't push or open a PR unless I ask.
- Don't weaken or skip existing tests to make new code pass.
- If something in the design turns out wrong or impossible (for example, the SDK can't serve over a raw socket), stop and tell me with a proposed alternative before building around it.
- The final report covers:
  - what works, verified and how
  - what is untested
  - every deviation from the design
  - follow-ups for phase 2
