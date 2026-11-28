import { Confirm } from "../Confirm";
import { EditDialog } from "../EditDialog";
import { FormDialog } from "../FormDialog";
import { ImportDialog } from "../ImportDialog";
import { OpenDialog } from "../OpenDialog";
import { useProgram, useSession, useViews } from "../store/session";
import { cancelImport, confirmImport } from "./dialogs";

/** The modal dialogs: opening progress, import options, and the edit and form dialogs the editing feature queues in the views store. */
export function DialogHost() {
  const s = useSession();
  const opening = useProgram((p) => p.opening), progress = useProgram((p) => p.progress), program = useProgram((p) => p.program);
  const importFor = useViews((v) => v.importFor), dlg = useViews((v) => v.dlg), formDlg = useViews((v) => v.formDlg), agentAsk = useViews((v) => v.agentAsk);
  const types = s.caps.has("dataTypes") ? program?.api.types.listDataTypes : undefined;
  return (
    <>
      {opening && <OpenDialog path={opening.path} progress={progress} startedAt={opening.startedAt} cancelling={opening.cancelling} onCancel={s.cancelOpen} />}
      {importFor && !opening && <ImportDialog imports={s.backend.imports} key={importFor} path={importFor} onOpen={(o) => confirmImport(s, importFor, o)} onCancel={() => cancelImport(s)} />}
      {dlg && <EditDialog typeSearch={types} spec={dlg.spec} onSubmit={dlg.submit} onClose={() => { if (s.views.getState().dlg === dlg) s.views.dispatch({ type: "set", patch: { dlg: null } }); }} />}
      {formDlg && <FormDialog typeSearch={types} title={formDlg.title} submit={formDlg.submit} fields={formDlg.fields} preview={formDlg.preview} onSubmit={formDlg.go} onClose={() => { if (s.views.getState().formDlg === formDlg) s.views.dispatch({ type: "set", patch: { formDlg: null } }); }} />}
      {agentAsk && <Confirm title={`${agentAsk.client} asks`} message={agentAsk.message} actions={[{ label: "Allow", primary: true, onClick: () => agentAsk.answer(true) }]} onCancel={() => agentAsk.answer(false)} />}
    </>
  );
}
