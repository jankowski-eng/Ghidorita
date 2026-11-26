# Renderer architecture

The wire contract is `../protocol.md` / `../protocol.ts`; the backend's layering is `../sidecar/ARCHITECTURE.md`; how a provider plugs in is `../PROVIDERS.md`. This page is the renderer's (`app/src/renderer/`): one boundary to the provider, one store for the open program, hooks that route user intent, components that render, and an `App` that only wires.

## Layout

`src/keys.ts` (shared with the main process) is the one table of keys: the application menu (`main/menu.ts`) reads accelerators and label hints from it, the command bar (`SearchPanel`) shows the key of each action, and `StatusBar` builds the key hint line for the focused view (`hintLine`, filtered by `allowsCommand`). `renderer/palette.ts` holds the colour language (naming dots, coverage marks) that the function list, call graph, binary map and coverage views share.

```
src/renderer/
  main.tsx             entry: Monaco setup, WebSocketBackend, render <App backend=…/>; dynamic-imports autotest/ only in AUTOTEST/BENCH mode
  App.tsx              composition and layout only: creates the session, builds the feature hooks, passes them to the panes
  backend.ts           the boundary: ApplicationBackend and the operations by domain (listing, functions, decompiler, references, searches, types, edits, history, coverage, exports)
  rpc.ts wire.ts       the one adapter: WebSocketBackend (JSON-RPC, session ids, errors -> Failure) and the payload checks; nothing else may import them
  store/               state that outlives a component
    createStore.ts     state + pure reducer + subscribe + useStore (useSyncExternalStore); no dependency
    program.ts         ProgramState and programReducer: the active program (session, operations, function lookup), open lifecycle, progress, closing, functions, address map, first listing page, undo/dirty, the background analysis state (`analysis` capability), saving, stats, messages
    views.ts           Views and viewsReducer: history, current function, scroll/refetch signals, versions, pinned xref target, dock, search/go-to/type manager, dialogs, pane visibility
    session.ts         createSession(backend): the program store, the views store and the actions that move them (open, cancelOpen, close, save, undo, program_changed); SessionProvider, useSession, useProgram, useViews
  features/            hooks and modules that route user intent
    navigation.ts      useNavigation: history, current function, the one go() every navigation takes, the decompiler tab that follows it
    editing.ts         useEditing: edit commands on the listing cursor row / decompiler token, show references, what the context menu may offer
    dialogs.ts         requestOpen / confirmImport / cancelImport (the import dialog comes before an open when the provider offers options)
    DialogHost.tsx     renders the modal dialogs: opening progress, import, edit, form
    drop.tsx           drag and drop: window listeners and the "Drop to open" overlay; a drop goes through `host.checkDrop` (preload: `webUtils.getPathForFile`, then main `drop-check` -> `main/drop.ts`: one regular file, absolute path) and `requestOpen`; refused while an open runs or a dialog is up (`dropAllowed.ts`)
    menu.ts            routeMenu (every menu/command-bar command), useMenuState (pushed to main), useWindowTitle, useBusy
    coverage.ts        load / clear coverage runs and repaint
    exports.ts         File > Export (symbol map, C header, Ghidra archive)
    copy.ts            useCopy: copy address / bytes (hex, C array) / decompiled text from the focused pane; clipboard.ts has the writer (navigator.clipboard, then the validated IPC)
    debug.ts           useDebug: jump to every stop, the first address F9 uses, the attach dialog (the pure helpers are in ../debug.ts; the state is `debug` in the program store, the actions are session.debugAction)
    exports.ts         File > Export
    reactions.ts       useProgramReactions: program_changed -> tabs, listing rows, xrefs, function list (the decisions are in changes.ts); tabs reset with the program
    bootstrap.ts       useBootstrap: backend events, window and host handlers (menu, mouse, Cmd+Z, Space, focus), quit-save, the autotest driver
  useTabs.ts tabs.ts   decompiler tabs and their results (tabs.ts is the pure part)
  session.ts           open helpers used by store/session.ts: resolveOpen, readBrowsing (first listing page), windowTitle
  Workbench.tsx        the three panes of the open program; WelcomePane.tsx the program browser; Shell.tsx toolbar, search/go-to bars, dock, status bar, type manager
  autotest/            AUTOTEST=<file> / BENCH=1 scripted modes; a separate chunk, loaded only in those modes
  *.tsx *.ts           components (Listing, Decompiler, panels, dialogs) and pure logic with unit tests (nav, changes, rowcache, address, addrmap, editActions, openOptions, coverage, ...)
```

## The rules

- **Only `main.tsx` (and the adapter itself) touches `rpc.ts` / `wire.ts`.** Everything else works on `ApplicationBackend` operations bound to the active session (`backend.program(session)`). `test/backend-boundary.test.mjs` fails otherwise (it scans every file, `store/` and `features/` included).
- **One session per backend.** `createSession(backend)` owns the program store and the views store; components read them with `useProgram(selector)` / `useViews(selector)`, code outside React with `store.getState()` (async code always sees the current state, no ref mirrors).
- **Events down, not callbacks across.** The session announces `onReset` (the program is opened, replaced or closed) and `onChanged` (program_changed: edits, undo, redo; a save only updates undo). The views store resets itself on a reset (the pane layout, the control-flow and call graph toggles and counters stay); `features/reactions.ts` is the one subscriber that reacts to a change with fetches. Same shape as `Events.subscribe` in the sidecar.
- **A failed open keeps the active program.** `selectSession` only resets when the session id changes; a held `program_changed` during an open is replayed for the session that is still active.
- **Components render and call hooks.** `App` builds the feature hooks once and hands them to `Workbench`; handlers registered once (menu, mouse, keys) call the latest closures through `api.current`. Never `useA() || useB()`: use `useBusy()`.
- **Scripted modes are not in the product chunk.** Only `main.tsx` imports `autotest/`, by dynamic `import()`; elsewhere only `import type`. `test/layering.test.mjs` checks it (verify in `app/out/renderer/assets`: `autotest-*.js` is its own file).

## Stores and what resets them

| store | holds | reset by |
|---|---|---|
| `session.store` (`program.ts`) | active program, open lifecycle, progress, functions, address map, first rows, undo/dirty, saving, stats, messages | `program` action when the session id changes |
| `session.views` (`views.ts`) | history, current function, scroll/refetch signals, versions, pinned xref target, dock, bars, dialogs | `reset`: all but pane visibility, the control-flow and call graph toggles, counters and the pending import |
| `useTabs` | decompiler tabs and results | `onReset` (reactions.ts) |
| `coverage` (module) | coverage runs | `coverage.clear()` in the session's reset |

## Tests

`npm test`: the pure logic, plus `store.test.mjs` (reducers), `session.test.mjs` (open/replace/fail/cancel/close and program_changed against an in-memory backend) and `layering.test.mjs`. Scripted end to end: `AUTOTEST=/bin/ls npm start` (mock: `MOCK=1`), `AUTOTEST_PHASE=2` for persistence, and `sidecar/test_provider_ui.py`.
