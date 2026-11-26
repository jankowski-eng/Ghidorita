# Manual test checklist (about 30 minutes)

These are the things the automated tests cannot do: real keystrokes, the real window buttons, a real trackpad, looking at the screen.
**Nothing here has been run by the author.** Tick a box only for what you actually saw. Write what went wrong under "Notes".

Setup (once): follow README "One-time setup", then `cd app && npm start` (dev build) or open the packaged `Ghidrette.app`.
Use a fresh projects dir for section 1 so the first launch is really a first launch:
`SIDECAR_PROJECTS_DIR=$(mktemp -d) npm start`. Test binary: `/bin/ls` (analysis takes ~15 s). Tester: ________  Date: ________  Build/commit: ________

## 1. First launch and the CSP status bar (3 min)
| # | Step | Expected | Pass | Fail |
|---|---|---|---|---|
| 1.1 | Start the app with a fresh projects dir. Look at the blue status bar at the bottom before doing anything. | Shows `– \| bytes: 0 \| funcs: 0 \| last listing page: – ms \| last decompile: – ms` on the left and `⌘K commands · ⌘G go to` on the right. No text mentioning `CSP blocked`. | ☐ | ☐ |
| 1.2 | Open `/bin/ls` (Open binary…, Enter on the import dialog). Wait until the listing shows. Open the decompiler on `main` (double-click it in the function list). | Code appears in the Monaco editor with syntax colours (Monaco loaded its workers). Status bar still has no `CSP blocked …` text, no error banner. | ☐ | ☐ |
| 1.2b | Drag `/bin/ls` from Finder onto the window (start screen, then again with a program open); try a folder and two files; drag a file while the opening card is showing. | A "Drop to open" overlay shows while dragging. One file shows the import card (with a program open, the current one is saved first). Folder: "That is a folder…"; two files: "Drop one file at a time."; during an open: a message says why, nothing changes. The start screen's drop area opens the file picker on click or Enter. | ☐ | ☐ |
| 1.3 | Open View > Data Type Manager, View > Strings, View > Symbol Table, then close them. | No `CSP blocked` text appears at any point. | ☐ | ☐ |

## 2. Quit and close with unsaved changes (6 min)
Make a change first: click a function name in the listing, press `L`, type `manual_test_1`, Enter. The window title gets a leading `• `.
| # | Step | Expected | Pass | Fail |
|---|---|---|---|---|
| 2.1 | Press **Cmd+Q**. | A dialog offers Save / Don't Save / Cancel. The app is still open behind it. | ☐ | ☐ |
| 2.2 | Click **Cancel**. | Dialog closes, app still open, the `• ` marker and the change are still there. | ☐ | ☐ |
| 2.3 | Click the **red close button** (top-left of the window). | The same Save / Don't Save / Cancel dialog (not a silent quit). Choose Cancel again; app stays open. | ☐ | ☐ |
| 2.4 | Cmd+Q again, choose **Save**. | App quits within a few seconds. `ps aux \| grep -E "sidecar/main.py\|decompile"` shows no leftover process after 10 s. | ☐ | ☐ |
| 2.5 | Start the app again (same projects dir), open `/bin/ls` from the "Programs in this project" list. | Opens in about 2-5 s (no re-analysis, no progress phases besides a quick load). The label `manual_test_1` is there (search for it with the Search… button). | ☐ | ☐ |
| 2.6 | Rename something else (`manual_test_2`), then click the red close button and choose **Don't Save**. Reopen `/bin/ls`. | App closed. After reopening, `manual_test_2` does **not** exist, `manual_test_1` does. (If `manual_test_2` exists, the app saved when it should not have: note it.) | ☐ | ☐ |
| 2.7 | With a change pending, open File > Close Program. | Per the documented behaviour the program is autosaved without a prompt and the welcome pane appears. Note whether that surprised you. | ☐ | ☐ |

## 3. Trackpad scrolling and fling in the listing (5 min)
Use a binary with many rows: the 66 MB `llvm-exegesis` if you have its analysis stored, otherwise `/bin/ls` (fewer rows, still fine).
| # | Step | Expected | Pass | Fail |
|---|---|---|---|---|
| 3.1 | Two-finger scroll slowly down, then up, in the listing. | Rows move smoothly line by line, no jumps backwards, no blank rows that stay blank. | ☐ | ☐ |
| 3.2 | Flick hard (fling) downwards and let it coast. | Scrolling coasts and stops. If it outruns the data you briefly see the last buffered row, never an empty gap that persists; rows fill in within about a second. | ☐ | ☐ |
| 3.3 | Fling upwards back to the start, then fling down again 3 times. | Same as 3.2 every time. The status bar `last listing page` stays below ~100 ms most of the time. | ☐ | ☐ |
| 3.4 | Drag the scrollbar thumb to the middle, then to the very end, then to the start. | The listing jumps to the matching place each time; at the end the last row is the highest address; at the start the first row is the lowest. | ☐ | ☐ |
| 3.5 | Scroll while a decompile runs (click a large function in the function list, then scroll the listing). | The listing keeps scrolling smoothly while the decompiler shows its "decompiling" state. | ☐ | ☐ |

## 4. Data type manager, keyboard only (7 min)
Do not touch the mouse from step 4.1 on (except where noted).
| # | Step | Expected | Pass | Fail |
|---|---|---|---|---|
| 4.1 | Press **Cmd+Shift+T**. | The data type manager opens and keyboard focus is inside it (visible focus ring). | ☐ | ☐ |
| 4.2 | Tab through the panel: filter box, tree, buttons. Shift+Tab back. | Focus moves in a sensible order, every control gets a visible focus ring, nothing traps focus. | ☐ | ☐ |
| 4.3 | In the tree: Up/Down moves, Right expands a category, Left collapses it, Home/End jump. | Each key does what it says; the selected row is always visible. | ☐ | ☐ |
| 4.4 | Use the New / Create button by keyboard to make a struct `ManualStruct` (type the name, Enter). | The struct appears in the tree and is selected, the editor shows it. | ☐ | ☐ |
| 4.5 | In the struct editor, add a field (keyboard only): type `int`, name `a`. Add a second, `char[8]` named `b`. | Two rows with offsets 0 and 4; sizes 4 and 8. | ☐ | ☐ |
| 4.6 | Rename a field inline (Enter/F2 on the cell, type, Enter). Cancel an inline edit with Escape. | Rename sticks; Escape leaves the old value. | ☐ | ☐ |
| 4.7 | Delete the second field with the keyboard (Delete or the Delete button). | Field removed; struct shrinks. | ☐ | ☐ |
| 4.8 | Cmd+Z three times (outside a text field). | Delete, rename and add are undone one step each. Cmd+Shift+Z redoes them. | ☐ | ☐ |
| 4.9 | Escape closes dialogs first, then the panel. | Each Escape closes the innermost thing only; focus returns to where it was before the panel opened. | ☐ | ☐ |

## 5. Language picker with hundreds of entries (5 min)
| # | Step | Expected | Pass | Fail |
|---|---|---|---|---|
| 5.1 | Choose a small non-executable file (for example a `.txt` file) with File > Open Binary… (or Cmd+K, then pick it). In the import dialog choose loader **Raw Binary**. | A language list appears with hundreds of entries (scroll to the bottom to see how many). The dialog does not freeze while it fills. | ☐ | ☐ |
| 5.2 | Type `x86` in the language filter. | List shrinks to x86 variants at once (no lag you can feel). | ☐ | ☐ |
| 5.3 | Clear the filter, type `6502`, pick the entry with the keyboard (Down, Enter or Tab to the Open button). | The entry is selected and the compiler spec follows; Open becomes enabled. | ☐ | ☐ |
| 5.4 | Scroll the full list with the trackpad and with PageUp/PageDown. | Smooth; the selected entry stays highlighted; no duplicate or missing rows when you filter and clear again. | ☐ | ☐ |
| 5.5 | Open it with base address `0x1000`. | The program opens; the listing starts at `0x1000`. | ☐ | ☐ |

## 6. Sundry (4 min)
| # | Step | Expected | Pass | Fail |
|---|---|---|---|---|
| 6.1 | Open `/bin/ls` and, while it is analysing for the first time (fresh projects dir), click Cancel in the progress dialog. | Dialog closes, the welcome pane shows "Open cancelled." (not an error). | ☐ | ☐ |
| 6.2 | Start a second copy of the app against the same projects dir (`SIDECAR_PROJECTS_DIR=<same> npm start` in another terminal). | The second window's "Programs in this project" shows the red text `projects dir in use by another Ghidrette (<dir>)`. | ☐ | ☐ |
| 6.3 | Open a program you opened before, rename its file, then choose it under File > Open Recent. | An error/notice "Could not open <path>". A failed open leaves the previously open program (and its unsaved edits) as it was; with none open you stay on the welcome pane. | ☐ | ☐ |
| 6.4 | Open `/bin/ls`, click a listing row, then the decompiler, then press Space for the graph, then click the function list. Press `Cmd+K`, type `>`. | The status bar's right side changes with the focused view (listing: `L rename · X refs · Space graph …`; decompiler: `… ⌘L retype …`; graph: `Space back · wheel zoom …`; function list: `⌘K commands · ⌘G go to`) and never wraps. The command bar shows `L` next to Rename and `⌘⇧G` next to Toggle Call Graph. Function list dots: off-white solid = named by you, amber ring = analysis, blue solid = imports, grey dashed ring = `FUN_…`. Graph edges: true solid, false dashed, loop-back dotted. Binary map: functions light blue, renamed ones off-white. | ☐ | ☐ |

## Notes
