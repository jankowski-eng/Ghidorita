import type { Tabs } from "./tabs";

export function TabStrip({ tabs, name, onActivate, onClose, onPin }: {
  tabs: Tabs; name: (entry: string) => string; onActivate: (id: number) => void; onClose: (id: number) => void; onPin: (id: number) => void;
}) {
  const move = (i: number, d: number) => {
    const t = tabs.tabs[(i + d + tabs.tabs.length) % tabs.tabs.length];
    onActivate(t.id);
    requestAnimationFrame(() => document.getElementById(`tab-${t.id}`)?.focus());
  };
  return (
    <div className="tabstrip" role="tablist" aria-label="Decompiler tabs">
      {tabs.tabs.map((t, i) => (
        <div key={t.id} className={"tab" + (t.id === tabs.active ? " active" : "") + (t.pinned ? "" : " preview")}>
          <button id={`tab-${t.id}`} role="tab" aria-selected={t.id === tabs.active} tabIndex={t.id === tabs.active ? 0 : -1}
            title={t.entry + (t.pinned ? "" : " (preview, double-click to keep)")}
            onClick={() => onActivate(t.id)} onDoubleClick={() => onPin(t.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") { e.preventDefault(); move(i, 1); }
              else if (e.key === "ArrowLeft") { e.preventDefault(); move(i, -1); }
              else if (e.key === "Delete") { e.preventDefault(); onClose(t.id); }
              else if (e.key === "Enter" && e.shiftKey) onPin(t.id);
            }}>{name(t.entry)}</button>
          <button className="x" tabIndex={-1} aria-label={`Close tab ${name(t.entry)}`} onClick={() => onClose(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
