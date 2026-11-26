/** Top bar: Open, and the one command bar (Cmd+K). Back/Forward live in the status bar; Go to, symbols, strings and actions are all in the bar. */
export function Toolbar({ onPick, onCommand, canCommand, busy }: { onPick: () => void; onCommand: () => void; canCommand: boolean; busy: boolean }) {
  return (
    <div className="bar">
      <button onClick={onPick} disabled={busy} aria-label="Open binary">Open binary…</button>
      <button className="cmdhint" onClick={onCommand} disabled={!canCommand || busy} aria-label="Command bar" title="Command bar (Cmd+K): symbols, strings, addresses, > actions">
        Search symbols, strings, addresses — &gt; for actions <kbd>⌘K</kbd>
      </button>
    </div>
  );
}
