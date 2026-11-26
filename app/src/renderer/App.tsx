import { useMemo, useRef } from "react";
import type { ApplicationBackend } from "./backend";
import { AppStatusBar, AppToolbar, BottomDock, Notice, TopBars, TypeManager } from "./Shell";
import { WelcomePane } from "./WelcomePane";
import { Workbench } from "./Workbench";
import { DialogHost } from "./features/DialogHost";
import { useBootstrap, type Api, type TestDriver } from "./features/bootstrap";
import { coverageActions } from "./features/coverage";
import { useCopy } from "./features/copy";
import { useEditing } from "./features/editing";
import { routeMenu, useMenuState, useWindowTitle } from "./features/menu";
import { useNavigation } from "./features/navigation";
import { useProgramReactions } from "./features/reactions";
import { createSession, SessionProvider, useProgram, useSession } from "./store/session";
import { useTabs } from "./useTabs";

/** Composition and layout only: the state is in store/ (the open program, the views), the behaviour in features/, the provider behind `backend`. */
export function App({ backend, autotest = false, onReady }: { backend: ApplicationBackend; autotest?: boolean; onReady?: (driver: TestDriver) => void }) {
  const session = useMemo(() => createSession(backend, { autotest }), [backend]); // eslint-disable-line
  return <SessionProvider value={session}><Main onReady={onReady} /></SessionProvider>;
}

function Main({ onReady }: { onReady?: (driver: TestDriver) => void }) {
  const s = useSession();
  const program = useProgram((p) => p.program);
  const tabs = useTabs(s.caps.has("decompile") ? program?.api.decompiler : undefined, s.fail, (ms) => s.store.dispatch({ type: "stats", patch: { decompileMs: ms } }),
    (entry) => s.store.getState().funcs.find((f) => f.entry === entry)?.size ?? 0);
  const nav = useNavigation(tabs);
  const editing = useEditing(tabs);
  const copy = useCopy(tabs);
  const coverage = useMemo(() => coverageActions(s), [s]);

  // Handlers registered once (startup, menu, mouse) call the latest closures through this.
  const api = useRef<Api>(null!);
  const handleMenu: Api["handleMenu"] = (c) => routeMenu(s, c, { back: nav.back, forward: nav.forward, goTab: nav.goTab, closeActive: tabs.closeActive, edit: editing.edit, showXrefs: editing.showXrefs, coverage, copy: copy.copy });
  api.current = { go: nav.go, back: nav.back, forward: nav.forward, clickAt: nav.clickAt, edit: editing.edit, handleMenu, selected: () => tabs.state.tabs.find((x) => x.id === tabs.state.active)?.entry ?? null };

  useBootstrap(() => api.current, onReady);
  useProgramReactions(tabs);
  useMenuState(nav.nav.back.length > 0, nav.nav.forward.length > 0);
  useWindowTitle();

  return (
    <div className="app">
      <AppToolbar />
      <TopBars go={nav.go} run={(c) => api.current.handleMenu(c)} />
      {program ? <Workbench tabs={tabs} nav={nav} editing={editing} copy={copy} testMode={!!onReady} /> : <WelcomePane />}
      <Notice />
      <BottomDock go={nav.go} />
      <AppStatusBar nav={nav} />
      <TypeManager />
      <DialogHost />
    </div>
  );
}
