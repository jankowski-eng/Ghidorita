import { useEffect } from "react";
import type { Address } from "../../../../protocol";
import type { AutotestCtx, AutotestControls } from "../autotest";
import { isObsolete } from "../backend";
import { undoRoute, type EditAction } from "../editActions";
import { useSession } from "../store/session";
import { focusKind } from "./editing";

export type TestDriver = Omit<AutotestCtx, "cancelFile" | "only" | "flow" | "expect" | keyof AutotestControls>;
/** The latest closures of the app's actions: handlers registered once (startup, menu, mouse) call through this. */
export interface Api {
  go(a: Address, source: "functions" | "goto" | "search" | "xrefs" | "listing" | "decompiler"): Promise<void>;
  back(): void; forward(): void; clickAt(line: number, col: number): void;
  edit(a: EditAction): Promise<void>;
  handleMenu(c: Parameters<AutotestCtx["command"]>[0]): void;
  selected(): Address | null;
}

/** Everything registered once on the window and the host: backend events, CSP violations, menu, mouse buttons, Cmd+Z, pane focus, quit-save, and the autotest driver. */
export function useBootstrap(api: () => Api, onReady?: (driver: TestDriver) => void) {
  const s = useSession();
  useEffect(() => {
    const { caps, refs, store } = s;
    const offChanged = s.backend.events.onChange((id, p) => s.programChanged(id, p));
    const offError = s.backend.events.onError(s.fail);
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
      open: (p) => s.open(p), command: (c) => api().handleMenu(c), lastMenu: () => s.menu.current, title: () => document.title,
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
    return () => { off(); offQuit(); offChanged(); offError(); window.removeEventListener("securitypolicyviolation", policyViolation); window.removeEventListener("mouseup", mouse); window.removeEventListener("keydown", undoKey, true); window.removeEventListener("focusin", pane); };
  }, []); // eslint-disable-line
}
