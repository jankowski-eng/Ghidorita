# A second editing provider (design note, not built)

Status: proposal for a decision. Nothing here is implemented. Candidate engine: rizin (or radare2) behind a Node or Python provider process, the way `fixture` is a Node provider and PyGhidra a Python one.

## Target workflow, through the unchanged Electron UI

Stage 1 (what the second engine must pass first):

1. open a binary (import dialog or drop), analysis runs in the background
2. rename a function in the listing, function list or decompiler
3. undo, then redo (Edit menu labels, Changes panel, dirty marker follow)
4. save
5. quit the app
6. relaunch, reopen from **Programs in this project** (by ID, see Phase 1), the rename is there and the program is clean

Stage 2 (later): edit one decompiler variable (rename or retype), save, quit, reopen, the edit survives and the decompiler shows it.

The acceptance test is the existing `test_provider_contract.py` / `test_provider_ui.py` shape plus one new contract test that runs stage 1 against every provider that advertises `editing`, `undo`, `save` and `projects`, and the autotest's edit flow with no `if (engine)` in it.

## What the contract assumes today, and where that is PyGhidra

| Area | Today | Why it is engine-specific | What a second engine needs |
|---|---|---|---|
| Edit = transaction | Every edit is one Ghidra transaction named as the undo label (`Session.edit`); the label shows in the Edit menu (`UndoState.undoName`). | Transactions, rollback on failure and a named undo stack are Ghidra's `Program` model. rizin has no transactions and no undo stack. | The provider owns an **edit journal**: each edit is a recorded (do, undo) pair with a label, applied to its own store. Protocol text must say "one undoable step, labelled", not "transaction". Nothing in `protocol.ts` has to change for this. |
| Undo history | One linear stack, `undo`/`redo`, `InvalidArgument` when empty; **save clears both stacks** (`undoHistoryCleared`), and the client treats save as an undo barrier (ChangeLog, `reconcile`). | Ghidra's save drops history. A journal engine can keep history across saves. | Keep the contract: history may end at save; `undoHistoryCleared` already tells the client. An engine that keeps history just returns `false`. The client must not assume it is cleared (ChangeLog follows `undo`/`redo` calls and, since Phase 2, reconciles with the `undo` state of every `program_changed`; an engine that keeps history after save needs one UI test, see Risks). |
| Dirty | `UndoState.dirty` = `Program.isChanged()`; undoing back to the save point is clean again. | Ghidra tracks the save point in the stack. | The journal stores a save-point index. Must hold: undo to it is clean, redo past it dirty (pinned by `test_raw_import_options_save_reopen_dirty_undo`). |
| `programId` | `sha256(file)` or `sha256-<12 hex of the options hash>`, plus the `analysisDisable` list; the project file is named by it. Ghidra LanguageIDs, loader names and compiler specs are part of the key. | The key is computed by the sidecar from Ghidra's import options. The protocol already calls it opaque, and Phase 1 made the UI use it only as an opaque string (`open_program {programId}`). | Nothing in React depends on its shape any more. Document that the provider may use any stable string; `list_programs` is the only source of IDs. |
| Project catalog | `programs.json` beside the Ghidra project: `sourcePath`, `options`, `analysis`, `analysisProfile`, `lastOpened`. | Provider storage. | Each provider keeps its own (already required: "give each provider its own storage"). A rizin provider can store a project file plus its journal. |
| Import options | `import_candidates` returns Ghidra loaders and languages; `ImportOptions` carries `loader`, `language`, `compilerSpec`, `baseAddress`, `profile`. | Vocabulary is Ghidra's, but the UI treats them as opaque strings from the candidates (`requiresLanguage` already lets a loader skip the language). | A rizin provider returns its own candidates (`bin` plugin, arch/bits). The `compilerSpec` field is unused when `null`. OK as is. |
| Analysis | `analysis` capability: background run, `AnalysisState`, profiles `full`/`fast` (the **ids are opaque**, but the UI calls `"full"` the upgrade target and hard-codes `fast` in a few labels). | Ghidra's analyzer names appear in `progress.analyzer`; fast/full is Ghidra's `FAST_PROFILE`. | rizin's `aa`/`aaa` map to profiles. The client's "Run full analysis" assumes a profile called `full`. Either keep that name or let `provider_info` name the upgrade target (small additive field). |
| Edit operations by capability | `editing` covers rename, label, comment, create function, signature, define data, clear code; `typeEditing` the struct/enum/typedef editors; `variableEditing` the decompiler variable edits. | `typeEditing` is Ghidra's data-type manager. rizin's type system (`t`) is different. | Start with `editing` + `undo` + `save` only. The capability model already allows that (Phase 3 tests partial sets). Do not advertise `typeEditing`/`variableEditing` until built. |
| Addresses | Strings `0x…` or `space::0x…` (overlay etc.), unsigned 64-bit. | Ghidra address spaces. | rizin has flat addresses plus sections. Provider uses the default space only; no client change. |
| `program_changed` | `ranges`, `kinds`, `undo`; coalesced ~50 ms; a save fires one with empty ranges and kinds; for a discontiguous function the entry is added to the ranges (Phase 2). | The listener side is Ghidra's DomainObjectListener, the wire shape is not. | The journal emits it directly after each step. Must include the new `undo`. |
| Session | `sessionId` per open, `StaleSession` on mismatch, program requests fail fast during an open. | Not engine-specific, but the PyGhidra lane/queue model is the reference for it. | Reuse by copying `core/rpc.py`'s rules into a small shared module or a Node twin; do not re-derive them. |
| Crash safety | Recovery snapshot of unsaved changes through Ghidra's DB handle (`recovery` capability), autosave on close/shutdown. | Ghidra recovery files. | Optional capability. A journal provider can write the journal as it goes, which is stronger. Autosave on close and SIGTERM is required either way (contract). |
| Exports | `export_gzf` is a Ghidra archive; `export_symbols`/`export_header` are generic. | gzf. | Do not advertise `exportGzf`. |

## The decompiler variable problem (stage 2)

`rename_variable` / `retype_variable` / `auto_create_structure` identify a variable by **`{entry, name}`**, the name as printed in the decompiler's current output (`iVar1`, `local_10`, `param_1`). That is a Ghidra habit: the sidecar decompiles first, looks the symbol up by name in the fresh `HighFunction`, and commits it with `HighFunctionDBUtil`. Consequences for another engine:

- Names are not stable identities. After a rename, the next decompile prints the new name; a different engine's decompiler (r2ghidra, rz-ghidra, or rizin's own pseudo-C) prints different names and has no commit step.
- `Token.varName` and `Token.varAddress` are the only variable identity the client sees. `variable_uses` and `xrefs_to_variable` take the same `{entry, name}`.
- Persistence of the edit is the provider's job, but "what survives" is defined by the engine: Ghidra stores the user's name on the function's stack/register symbol, so it survives a re-decompile. For rizin it means the provider must store its own `{function, storage location} -> name/type` table and apply it to every decompile result.

Contract change that makes the client engine-neutral and is cheap to do now: add an optional **`varId?: string`** to `Token` (opaque, stable for the same storage location across decompiles, e.g. `stack:-0x10`, `reg:rdi`, `param:0`), and accept `{entry, varId}` in the variable methods next to `{entry, name}`. `name` stays the display text and the fallback. The UI already holds the token it clicked, so it can send `varId` when the token has one. No React branch per engine: it sends whichever identity the token carried.

## Contract changes needed, in order

Nothing below changes what PyGhidra does; each is additive and capability- or field-gated.

1. **Wording, no code.** `protocol.md` edit section: "one undoable step" instead of "one Ghidra transaction"; undo/dirty/save-point rules stated as the contract (they are tested already). Say that `undoHistoryCleared: false` is legal.
2. **Reopen by ID is part of `projects`** (done in Phase 1). A second provider must implement `open_program` to advertise `projects`; the fixture does not.
3. **`provider_info` names the analysis upgrade** (optional): `analysisProfiles?: {id, label, upgradeFrom?}`. Only needed if the engine's profiles are not `fast`/`full`. Today the client hard-codes those two ids in "Run full analysis".
4. **`Token.varId`** and `varId` params as above, before stage 2 only.
5. **A provider-neutral edit test** (`test_provider_edit_contract.py`): open, rename a function, undo, redo, save, close, `open_program`, assert name and clean. Parametrised like `test_provider_contract.py`, skipped when the provider lacks `editing`. This is the real gate; the PyGhidra run is the reference.

## What stays out of scope here

- A rizin provider itself, and any decision on rizin vs radare2 vs both. The provider process contract (stdout port, token path, stdin EOF) is engine-neutral and already documented in `PROVIDERS.md`.
- A decompiler for the second engine. Stage 1 needs none: `decompile` is a capability, the listing and function list carry the rename, and Phase 3 made the workbench work without it.
- Typed data (`typeEditing`) and the data-type manager.

## Risks

- **Undo across save.** A journal engine that keeps history over a save will show an undo that Ghidra would not; the ChangeLog and dirty logic are written for "history may be empty after save", not for "history survives", so one UI test is needed for that case before shipping such a provider.
- **Function identity.** Rename-by-address assumes the function entry is stable across reopen; a different analyser may find different functions on a re-analysis. Reopen by ID avoids re-analysis, but only if the provider persists its analysis results, not just its edits.
- **Single process, single project dir.** PyGhidra's project lock means one sidecar per projects dir (`ProjectLocked`). A second provider needs its own directory; Electron already scopes storage per provider.

## Decision wanted

Build stage 1 only (steps 1 to 5 above plus the provider-neutral edit test), or also stage 2 (needs `varId` and a decompiler)? My recommendation is stage 1 first: it exercises every contract assumption except variable identity, and costs no protocol change beyond wording.
