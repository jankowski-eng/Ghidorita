import { createRoot } from "react-dom/client";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { loader } from "@monaco-editor/react";
import { App } from "./App";
import "./style.css";

// Bundle Monaco locally (no CDN).
(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

createRoot(document.getElementById("root")!).render(<App />);
