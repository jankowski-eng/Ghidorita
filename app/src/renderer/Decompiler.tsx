import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { Token } from "../../../protocol";

type Ed = Parameters<OnMount>[0];

/** Monaco view of one decompile result; call tokens are underlined and clickable. */
export function Decompiler({ text, tokens, onCallClick, editorRef }: {
  text: string; tokens: Token[]; onCallClick: (line1: number, col1: number) => void; editorRef: { current: Ed | null };
}) {
  const decorations = useRef<ReturnType<Ed["createDecorationsCollection"]> | null>(null);
  const clickRef = useRef(onCallClick); clickRef.current = onCallClick;
  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    decorations.current = editor.createDecorationsCollection();
    editor.onMouseDown((e) => { if (e.target.position) clickRef.current(e.target.position.lineNumber, e.target.position.column); });
  };
  useEffect(() => {
    decorations.current?.set(tokens.filter((t) => t.targetFunction).map((t) => ({
      range: { startLineNumber: t.line + 1, startColumn: t.colStart + 1, endLineNumber: t.line + 1, endColumn: t.colEnd + 1 },
      options: { inlineClassName: "call-token" },
    })));
  }, [tokens, text]);
  return (
    <Editor language="c" theme="vs-dark" value={text} onMount={onMount}
      options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false }} />
  );
}
