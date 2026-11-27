import { useEffect } from "react";
import type { Address } from "../../../../protocol";
import type { AutotestCtx, AutotestControls } from "../autotest/autotest";
import { isObsolete } from "../backend";
import { undoRoute, type EditAction } from "../editActions";
import { useSession } from "../store/session";
import { clearTrail } from "../store/views";
import { focusKind } from "./editing";
import { KEYS, matchesKey } from "../../keys";
import type { MenuCommand } from "../../preload/index";

export type TestDriver = Omit<AutotestCtx, "cancelFile" | "only" | "flow" | "expect" | keyof AutotestControls>;
/** The latest closures of the app's actions: handlers registered once (startup, menu, mouse) call through this. */
export interface Api {
  go(a: Address, source: "functions" | "goto" | "search" | "xrefs" | "listing" | "decompiler"): Promise<void>;
  back(): void; forward(): void; clickAt(line: number, col: number): void;
  edit(a: EditAction): Promise<void>;
  handleMenu(c: Parameters<AutotestCtx["command"]>[0]): void;
  selected(): Address | null;
}

/** Everything registered once on the window and the host: backend events, CSP violations, menu, mouse buttons, Cmd+Z, hint-only keys, pane focus, quit-save, and the autotest driver. */
export function useBootstrap(api: () => Api, onReady?: (driver: TestDriver) => void) {
  const s = useSession();
  useEffect(() => {
    const { caps, refs, store } = s;
    const offChanged = s.backend.events.onChange((id, p) => s.programChanged(id, p));
    const offError = s.backend.events.onError(s.fail);
    const offAnalysis = s.backend.events.onAnalysis(s.analysisChanged);
    const offDebug = s.backend.events.onDebug(s.debugChanged);
    const policyViolation = (e: SecurityPolicyViolationEvent) => {
      if (!(window as any).__expectCsp) s.fail("CSP blocked " + e.violatedDirective + ": " + e.blockedURI);
    };
    window.addEventListener("securitypolicyviolation", policyViolation);
    onReady?.({
      backend: s.backend, program: () => {
        const current = s.program();
        if (!current) throw new Error("No program open");
        return current.api;
      },
      open: (p) => s.open(p), openBg: (p, o) => s.open(p, o, undefined, "background"), analysis: () => store.getState().analysis, debug: () => store.getState().debug, command: (c) => api().handleMenu(c), lastMenu: () => s.menu.current, title: () => document.title,
      status: () => { const g = store.getState(); return { funcs: g.funcs.length, opened: !!g.program, opening: !!g.opening, phase: g.progress?.phase ?? "", notice: g.notice }; },
      select: (e) => api().go(e, "functions"), goAddr: (a) => api().go(a, "goto"), clickAt: (l, c) => api().clickAt(l, c),
      back: () => api().back(), forward: () => api().forward(), fail: s.fail, errors: s.errors,
      selected: () => api().selected(),
      editor: () => refs.editor.current, menu: (id) => window.host.autotestMenu(id), funcCount: () => store.getState().funcs.length, topAddr: () => refs.topAddr.current, editorText: () => refs.editor.current?.getValue() ?? "",
    });
    const off = window.host.onMenu((c) => api().handleMenu(c));
    const mouse = (e: MouseEvent) => { // buttons 4/5 = back/forward
      if (e.button === 3) { e.preventDefault(); api().back(); } else if (e.button === 4) { e.preventDefault(); api().forward(); }
    };
    window.addEventListener("mouseup", mouse);
    // Cmd+Z: the menu shows the accelerator without registering it, so the key arrives here. Text inputs keep their own undo.
    const undoKey = (e: KeyboardEvent) => {
      if (!caps.has("undo") || !(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "z") return;
      if (undoRoute(focusKind(document.activeElement)) === "text") return;
      e.preventDefault(); e.stopPropagation();
      void api().edit(e.shiftKey ? "redo" : "undo");
    };
    window.addEventListener("keydown", undoKey, true);
    // Hint-only keys (G go to, S search memory, Alt+Left/Right back/forward): handled here, not as menu accelerators, so they never fire inside text inputs or dialogs.
    // Capture phase: Monaco would take Alt+arrows as word movement.
    const hintKeys: [string, MenuCommand][] = [["goto", { type: "goto" }], ["dock:memsearch", { type: "dock", panel: "memsearch" }], ["nav-back", { type: "nav-back" }], ["nav-forward", { type: "nav-forward" }]];
    const hintKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!s.program() || t.closest('[role="dialog"], .dlg, .modal') || focusKind(t) === "input") return; // anywhere in the program UI except dialogs and text inputs
      const hit = hintKeys.find(([id]) => matchesKey(KEYS[id], e));
      if (hit) { e.preventDefault(); e.stopPropagation(); api().handleMenu(hit[1]); }
    };
    window.addEventListener("keydown", hintKey, true);
    // Esc clears the value trail, or the request still loading it (not while a dialog or the command bar is up: their Esc closes them)
    const trailEsc = (e: KeyboardEvent) => {
      const v = s.views.getState();
      if (e.key === "Escape" && !v.dlg && !v.formDlg && !v.searchOpen && !v.gotoOpen && !v.importFor) s.views.dispatch({ type: "set", patch: clearTrail });
    };
    window.addEventListener("keydown", trailEsc);
    const pane = (e: FocusEvent) => { const k = focusKind(e.target as Element); if (k === "listing" || k === "decompiler") refs.lastPane.current = k; };
    window.addEventListener("focusin", pane);
    // quit: save first (the status bar shows "Saving…"), then main stops the sidecar
    const offQuit = window.host.onQuitRequested(() => {
      const current = s.program();
      if (!caps.has("save") || !current) { void window.host.quitReady({ ok: true }); return; }
      store.dispatch({ type: "saving", on: true });
      current.api.history.save().then(
        () => window.host.quitReady({ ok: true }),
        (e) => {
          if (isObsolete(e)) return window.host.quitReady({ ok: true });
          store.dispatch({ type: "saving", on: false }); // the user may cancel the quit in main's "Saving failed" dialog; the app must stay usable
          s.fail(e);
          return window.host.quitReady({ ok: false, error: e instanceof Error ? e.message : String(e) });
        });
    });
    return () => { off(); offQuit(); offChanged(); offError(); offAnalysis(); offDebug(); window.removeEventListener("securitypolicyviolation", policyViolation); window.removeEventListener("mouseup", mouse); window.removeEventListener("keydown", undoKey, true); window.removeEventListener("keydown", hintKey, true); window.removeEventListener("keydown", trailEsc); window.removeEventListener("focusin", pane); };
  }, []); // eslint-disable-line
}
