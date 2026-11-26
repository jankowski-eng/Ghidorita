import { useEffect, useLayoutEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { Token } from "../../../protocol";
import { mapPos, type EditAction } from "./editActions";

type Ed = Parameters<OnMount>[0];
type Monaco = Parameters<OnMount>[1];

/**
 * One Monaco instance, one model per tab (path "tab-<id>"): the wrapper saves/restores scroll and cursor per path.
 * Call tokens of the active tab are underlined and clickable.
 */
export type CanEdit = { rename: boolean; retype: boolean; signature: boolean; xrefs: boolean };
export function Decompiler({ tabId, liveIds, text, tokens, highlight, onCallClick, editorRef, onEdit, canAt, onXrefs }: {
  tabId: number | null; liveIds: number[]; text: string; tokens: Token[]; highlight: Token[]; onCallClick: (line1: number, col1: number) => void; editorRef: { current: Ed | null };
  onEdit: (a: EditAction) => void; canAt: (line1: number, col1: number) => CanEdit; onXrefs: () => void;
}) {
  const decorations = useRef<ReturnType<Ed["createDecorationsCollection"]> | null>(null);
  const hlDecor = useRef<ReturnType<Ed["createDecorationsCollection"]> | null>(null);
  const hlKey = useRef("");
  const monacoRef = useRef<Monaco | null>(null);
  const clickRef = useRef(onCallClick); clickRef.current = onCallClick;
  const editRef = useRef(onEdit); editRef.current = onEdit;
  const canRef = useRef(canAt); canRef.current = canAt;
  const xrefsRef = useRef(onXrefs); xrefsRef.current = onXrefs;
  const keysRef = useRef<{ set(c: CanEdit): void } | null>(null);
  const syncKeys = () => { const p = editorRef.current?.getPosition(); if (p) keysRef.current?.set(canRef.current(p.lineNumber, p.column)); };
  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor; monacoRef.current = monaco;
    // Ghidra's keys through Monaco's action API (also the context menu); preconditions follow the token under the cursor
    const ck = { rename: editor.createContextKey<boolean>("gdRename", false), retype: editor.createContextKey<boolean>("gdRetype", false), signature: editor.createContextKey<boolean>("gdSignature", false), xrefs: editor.createContextKey<boolean>("gdXrefs", false) };
    keysRef.current = { set: (c) => { ck.rename.set(c.rename); ck.retype.set(c.retype); ck.signature.set(c.signature); ck.xrefs.set(c.xrefs); } };
    const act = (id: string, label: string, action: EditAction, order: number, precondition?: string, keybindings?: number[]) =>
      editor.addAction({ id: "gd." + id, label, keybindings, precondition, contextMenuGroupId: "gd", contextMenuOrder: order, run: () => editRef.current(action) });
    act("rename", "Rename…", "rename", 1, "gdRename && !findInputFocus && !replaceInputFocus", [monaco.KeyCode.KeyL]);
    act("retype", "Retype Variable…", "retype", 2, "gdRetype && !findInputFocus && !replaceInputFocus", [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL]);
    act("signature", "Edit Function Signature…", "signature", 3, "gdSignature && !findInputFocus && !replaceInputFocus");
    act("comment", "Set Comment…", "comment", 4, "!findInputFocus && !replaceInputFocus", [monaco.KeyCode.Semicolon]);
    editor.addAction({ id: "gd.xrefs", label: "Show References To", keybindings: [monaco.KeyCode.KeyX], precondition: "gdXrefs && !findInputFocus && !replaceInputFocus", contextMenuGroupId: "gd", contextMenuOrder: 5, run: () => xrefsRef.current() });
    editor.onDidChangeCursorPosition(syncKeys);
    decorations.current = editor.createDecorationsCollection();
    hlDecor.current = editor.createDecorationsCollection();
    editor.onMouseDown((e) => { if (e.target.position) clickRef.current(e.target.position.lineNumber, e.target.position.column); });
  };
  useEffect(() => () => { for (const m of monacoRef.current?.editor.getModels() ?? []) if (/tab-\d+$/.test(m.uri.path)) m.dispose(); }, []);
  useEffect(() => { // dispose models of closed tabs
    for (const m of monacoRef.current?.editor.getModels() ?? []) {
      const id = /tab-(\d+)$/.exec(m.uri.path)?.[1];
      if (id && !liveIds.includes(+id)) m.dispose();
    }
  }, [liveIds.join(",")]); // eslint-disable-line
  useEffect(syncKeys, [tokens, text, tabId]); // eslint-disable-line
  // Keep the user's place across a refresh of the same tab: snapshot before the wrapper swaps the text (layout effects run
  // before the wrapper's passive effect), then map cursor and top line onto the new text.
  const prev = useRef({ text, tabId });
  const snap = useRef<{ old: string; line: number; col: number; top: number; off: number } | null>(null);
  useLayoutEffect(() => {
    const ed = editorRef.current, p = prev.current;
    snap.current = null;
    if (ed && p.tabId === tabId && p.text && p.text !== text) {
      const pos = ed.getPosition(), top = ed.getVisibleRanges()[0]?.startLineNumber ?? 1;
      if (pos) snap.current = { old: p.text, line: pos.lineNumber, col: pos.column, top, off: ed.getScrollTop() - ed.getTopForLineNumber(top) };
    }
    prev.current = { text, tabId };
  }, [text, tabId]); // eslint-disable-line
  useEffect(() => {
    const s = snap.current, ed = editorRef.current;
    if (!s || !ed) return;
    snap.current = null;
    const np = mapPos(s.old, text, { line: s.line, col: s.col });
    ed.setPosition({ lineNumber: np.line, column: np.col });
    ed.setScrollTop(ed.getTopForLineNumber(mapPos(s.old, text, { line: s.top, col: 1 }).line) + s.off);
  }, [text, tabId]); // eslint-disable-line
  useEffect(() => {
    decorations.current?.set(tokens.filter((t) => t.targetFunction).map((t) => ({
      range: { startLineNumber: t.line + 1, startColumn: t.colStart + 1, endLineNumber: t.line + 1, endColumn: t.colEnd + 1 },
      options: { inlineClassName: "call-token" },
    })));
  }, [tokens, text, tabId]);
  useEffect(() => { // the token(s) of the use clicked in the references panel; scrolled into view once per new highlight
    const rng = (t: Token) => ({ startLineNumber: t.line + 1, startColumn: t.colStart + 1, endLineNumber: t.line + 1, endColumn: t.colEnd + 1 });
    hlDecor.current?.set(highlight.map((t) => ({ range: rng(t), options: { inlineClassName: "use-token" } })));
    const key = tabId + ":" + highlight.map((t) => t.line + "," + t.colStart).join(";");
    if (highlight.length && key !== hlKey.current) editorRef.current?.revealLineInCenterIfOutsideViewport(highlight[0].line + 1);
    hlKey.current = highlight.length ? key : "";
  }, [highlight, text, tabId]); // eslint-disable-line
  return (
    <Editor language="c" theme="vs-dark" path={`tab-${tabId ?? 0}`} value={text} onMount={onMount}
      options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, automaticLayout: true }} />
  );
}
