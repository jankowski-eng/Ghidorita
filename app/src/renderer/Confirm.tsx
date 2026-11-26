import { useRestoreFocus, trapTab } from "./hooks";

export interface ConfirmAction { label: string; onClick: () => void; primary?: boolean }

/** Modal choice dialog (Save / Don't Save / Cancel, Delete / Cancel). Escape = onCancel; the primary action has initial focus. */
export function Confirm({ title, message, error, busy, actions, onCancel }: {
  title: string; message: string; error?: string; busy?: boolean; actions: ConfirmAction[]; onCancel: () => void;
}) {
  useRestoreFocus();
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => { trapTab(e); if (e.key === "Escape" && !busy) { e.stopPropagation(); onCancel(); } }}>
      <div className="card">
        <div className="title">{title}</div>
        <div>{message}</div>
        {error && <div className="err" role="alert">{error}</div>}
        <div className="row">
          {actions.map((a) => <button key={a.label} autoFocus={a.primary} className={a.primary ? "primary" : undefined} disabled={busy} onClick={a.onClick}>{a.label}</button>)}
          <button autoFocus={!actions.some((a) => a.primary)} disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
