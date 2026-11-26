import { allowsEdit } from "../capabilities";
import type { Capability } from "../../../protocol";
import { useEffect, useLayoutEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { Address, Token } from "../../../protocol";
import { coverage } from "./coverage";
import { mapPos, type EditAction } from "./editActions";

type Ed = Parameters<OnMount>[0];
type Monaco = Parameters<OnMount>[1];

/**
 * One Monaco instance, one model per tab (path "tab-<id>"): the wrapper saves/restores scroll and cursor per path.
 * Call tokens of the active tab are underlined and clickable.
 */
export type CanEdit = { rename: boolean; retype: boolean; signature: boolean; xrefs: boolean };
export function Decompiler({ tabId, liveIds, text, tokens, highlight, covVersion, pcLine, pcSeq, bpLines, values, onGutter, onCallClick, editorRef, onEdit, canAt, onXrefs, onCopy, canEdit }: {
  values?: { line: number; text: string }[]; // debugger: text after a line (the variables' values at the stop)
  pcLine?: number | null; pcSeq?: number; bpLines?: number[]; onGutter?: (line1: number) => void; // debugger: the stop line (0-based) and which stop it is, the breakpoint lines, a click in the glyph margin
  tabId: number | null; covVersion: number; liveIds: number[]; text: string; tokens: Token[]; highlight: Token[]; onCallClick: (line1: number, col1: number) => void; editorRef: { current: Ed | null };
  canEdit: ReadonlySet<Capability>; onEdit: (a: EditAction) => void; canAt: (line1: number, col1: number) => CanEdit; onXrefs: () => void; onCopy: (what: "address" | "decompiled") => void;
}) {
  const decorations = useRef<ReturnType<Ed["createDecorationsCollection"]> | null>(null);
  const hlDecor = useRef<ReturnType<Ed["createDecorationsCollection"]> | null>(null);
  const covDecor = useRef<ReturnType<Ed["createDecorationsCollection"]> | null>(null);
  const widgets = useRef<Parameters<Ed["addContentWidget"]>[0][]>([]);
  const pcDecor = useRef<ReturnType<Ed["createDecorationsCollection"]> | null>(null);
  const hlKey = useRef(""), pcKey = useRef("");
  const gutterRef = useRef(onGutter); gutterRef.current = onGutter;
  const monacoRef = useRef<Monaco | null>(null);
  const clickRef = useRef(onCallClick); clickRef.current = onCallClick;
  const editRef = useRef(onEdit); editRef.current = onEdit;
  const canRef = useRef(canAt); canRef.current = canAt;
  const xrefsRef = useRef(onXrefs); xrefsRef.current = onXrefs;
  const copyRef = useRef(onCopy); copyRef.current = onCopy;
  const keysRef = useRef<{ set(c: CanEdit): void } | null>(null);
  const syncKeys = () => { const p = editorRef.current?.getPosition(); if (p) keysRef.current?.set(canRef.current(p.lineNumber, p.column)); };
  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor; monacoRef.current = monaco; 
    // Ghidra's keys through Monaco's action API (also the context menu); preconditions follow the token under the cursor
    const ck = { rename: editor.createContextKey<boolean>("gdRename", false), retype: editor.createContextKey<boolean>("gdRetype", false), signature: editor.createContextKey<boolean>("gdSignature", false), xrefs: editor.createContextKey<boolean>("gdXrefs", false) };
    keysRef.current = { set: (c) => { ck.rename.set(c.rename); ck.retype.set(c.retype); ck.signature.set(c.signature); ck.xrefs.set(c.xrefs); } };
    const act = (id: string, label: string, action: EditAction, order: number, precondition?: string, keybindings?: number[]) =>
      allowsEdit(canEdit, action) && editor.addAction({ id: "gd." + id, label, keybindings, precondition, contextMenuGroupId: "gd", contextMenuOrder: order, run: () => editRef.current(action) });
    act("rename", "Rename…", "rename", 1, "gdRename && !findInputFocus && !replaceInputFocus", [monaco.KeyCode.KeyL]);
    act("retype", "Retype Variable…", "retype", 2, "gdRetype && !findInputFocus && !replaceInputFocus", [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL]);
    act("signature", "Edit Function Signature…", "signature", 3, "gdSignature && !findInputFocus && !replaceInputFocus");
    act("comment", "Set Comment…", "comment", 4, "!findInputFocus && !replaceInputFocus", [monaco.KeyCode.Semicolon]);
    if (canEdit.has("references")) editor.addAction({ id: "gd.xrefs", label: "Show References To", precondition: "gdXrefs && !findInputFocus && !replaceInputFocus", contextMenuGroupId: "gd", contextMenuOrder: 5, run: () => xrefsRef.current() });
    // Cmd+C stays Monaco's own copy of the selection; these two are menu-only (the Edit menu has their keys)
    editor.addAction({ id: "gd.copyAddress", label: "Copy Address", contextMenuGroupId: "gd", contextMenuOrder: 6, run: () => copyRef.current("address") });
    editor.addAction({ id: "gd.copyDecompiled", label: "Copy Decompiled Function", contextMenuGroupId: "gd", contextMenuOrder: 7, run: () => copyRef.current("decompiled") });
    editor.onDidChangeCursorPosition(syncKeys);
    decorations.current = editor.createDecorationsCollection();
    hlDecor.current = editor.createDecorationsCollection();
    covDecor.current = editor.createDecorationsCollection();
    pcDecor.current = editor.createDecorationsCollection();
    editor.onMouseDown((e) => { if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) { gutterRef.current?.(e.target.position.lineNumber); return; } if (e.target.position) clickRef.current(e.target.position.lineNumber, e.target.position.column); });
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
  useEffect(() => { // coverage tint, same classes as the listing's rows; a line without any token address stays untinted
    const byLine = new Map<number, Address[]>();
    if (coverage.shown) for (const t of tokens) if (t.address) { const l = byLine.get(t.line); if (l) l.push(t.address); else byLine.set(t.line, [t.address]); }
    covDecor.current?.set([...byLine].flatMap(([line, addrs]) => {
      const c = coverage.markAny(addrs).trim();
      return c ? [{ range: { startLineNumber: line + 1, startColumn: 1, endLineNumber: line + 1, endColumn: 1 }, options: { isWholeLine: true, className: "d" + c, linesDecorationsClassName: c === "cov-a" ? "gcov-a" : c === "cov-b" ? "gcov-b" : undefined } }] : [];
    }));
  }, [tokens, text, tabId, covVersion]);
  useEffect(() => { // the values after the lines that name a variable: content widgets (injected text and inlay hints did not render in this editor)
    const ed = editorRef.current, monaco = monacoRef.current;
    if (!ed || !monaco) return;
    for (const w of widgets.current) ed.removeContentWidget(w);
    const model = ed.getModel();
    widgets.current = (values ?? []).filter((v) => model && v.line + 1 <= model.getLineCount()).map((v) => {
      const node = document.createElement("span");
      node.className = "dval"; node.textContent = v.text;
      return { getId: () => "gd.val." + v.line, getDomNode: () => node, allowEditorOverflow: false,
        getPosition: () => ({ position: { lineNumber: v.line + 1, column: model!.getLineMaxColumn(v.line + 1) }, preference: [monaco.editor.ContentWidgetPositionPreference.EXACT] }) };
    });
    for (const w of widgets.current) ed.addContentWidget(w);
  }, [(values ?? []).map((v) => v.line + v.text).join("|"), text, tabId]); // eslint-disable-line
  useEffect(() => { // the stop line and the breakpoint glyphs; the view follows a new stop (once per stop)
    const whole = (line0: number, options: object) => ({ range: { startLineNumber: line0 + 1, startColumn: 1, endLineNumber: line0 + 1, endColumn: 1 }, options });
    pcDecor.current?.set([...(bpLines ?? []).map((l) => whole(l, { glyphMarginClassName: "dbp" })), ...(pcLine != null ? [whole(pcLine, { isWholeLine: true, className: "dpc" })] : [])]);
    const key = pcLine != null ? `${tabId}:${pcLine}:${pcSeq}` : "";
    if (key && key !== pcKey.current) editorRef.current?.revealLineInCenterIfOutsideViewport(pcLine! + 1);
    pcKey.current = key;
  }, [pcLine, pcSeq, (bpLines ?? []).join(","), text, tabId]); // eslint-disable-line
  useEffect(() => { // the token(s) of the use clicked in the references panel; scrolled into view once per new highlight
    const rng = (t: Token) => ({ startLineNumber: t.line + 1, startColumn: t.colStart + 1, endLineNumber: t.line + 1, endColumn: t.colEnd + 1 });
    hlDecor.current?.set(highlight.map((t) => ({ range: rng(t), options: { inlineClassName: "use-token" } })));
    const key = tabId + ":" + highlight.map((t) => t.line + "," + t.colStart).join(";");
    if (highlight.length && key !== hlKey.current) editorRef.current?.revealLineInCenterIfOutsideViewport(highlight[0].line + 1);
    hlKey.current = highlight.length ? key : "";
  }, [highlight, text, tabId]); // eslint-disable-line
  return (
    <Editor language="c" theme="vs-dark" path={`tab-${tabId ?? 0}`} value={text} onMount={onMount}
      options={{ readOnly: true, glyphMargin: !!onGutter, minimap: { enabled: false }, fontSize: 13, lineDecorationsWidth: 16, scrollBeyondLastLine: false, automaticLayout: true }} />
  );
}
