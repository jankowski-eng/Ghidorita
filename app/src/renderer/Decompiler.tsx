import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { Token } from "../../../protocol";

type Ed = Parameters<OnMount>[0];
type Monaco = Parameters<OnMount>[1];

/**
 * One Monaco instance, one model per tab (path "tab-<id>"): the wrapper saves/restores scroll and cursor per path.
 * Call tokens of the active tab are underlined and clickable.
 */
export function Decompiler({ tabId, liveIds, text, tokens, onCallClick, editorRef }: {
  tabId: number | null; liveIds: number[]; text: string; tokens: Token[]; onCallClick: (line1: number, col1: number) => void; editorRef: { current: Ed | null };
}) {
  const decorations = useRef<ReturnType<Ed["createDecorationsCollection"]> | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const clickRef = useRef(onCallClick); clickRef.current = onCallClick;
  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor; monacoRef.current = monaco;
    decorations.current = editor.createDecorationsCollection();
    editor.onMouseDown((e) => { if (e.target.position) clickRef.current(e.target.position.lineNumber, e.target.position.column); });
  };
  useEffect(() => () => { for (const m of monacoRef.current?.editor.getModels() ?? []) if (/tab-\d+$/.test(m.uri.path)) m.dispose(); }, []);
  useEffect(() => { // dispose models of closed tabs
    for (const m of monacoRef.current?.editor.getModels() ?? []) {
      const id = /tab-(\d+)$/.exec(m.uri.path)?.[1];
      if (id && !liveIds.includes(+id)) m.dispose();
    }
  }, [liveIds.join(",")]); // eslint-disable-line
  useEffect(() => {
    decorations.current?.set(tokens.filter((t) => t.targetFunction).map((t) => ({
      range: { startLineNumber: t.line + 1, startColumn: t.colStart + 1, endLineNumber: t.line + 1, endColumn: t.colEnd + 1 },
      options: { inlineClassName: "call-token" },
    })));
  }, [tokens, text, tabId]);
  return (
    <Editor language="c" theme="vs-dark" path={`tab-${tabId ?? 0}`} value={text} onMount={onMount}
      options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, automaticLayout: true }} />
  );
}
