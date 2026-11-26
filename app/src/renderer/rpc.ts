import { ErrorCode, type ActiveSession, type AnalysisState, type Capability, type DebugState, type Methods, type Notifications, type UndoState } from "../../../protocol";
import {
  BackendError, type AnalysisMode, type ApplicationBackend, type Failure, type ImportSelection, type Job, type OpenJob, type OpenProgress, type ProgramChange,
  type ProgramLifecycle, type ProgramOperations, type ProjectCatalog, type ProviderEvents,
} from "./backend";
import { notifications, object, results, knownCapabilities } from "./wire";

const kinds: Record<number, Failure> = {
  [ErrorCode.NoProgram]: "noProgram", [ErrorCode.Cancelled]: "cancelled", [ErrorCode.Timeout]: "timeout",
  [ErrorCode.NotFound]: "notFound", [ErrorCode.Busy]: "busy", [ErrorCode.ProjectLocked]: "projectLocked",
  [ErrorCode.StaleSession]: "stale", [ErrorCode.Target]: "target", [ErrorCode.InvalidArgument]: "invalid", [ErrorCode.MethodNotFound]: "unsupported",
};
type Method = keyof Methods;
type Params<M extends Method> = Methods[M]["params"];
type Result<M extends Method> = Methods[M]["result"];
type Pending = { sessionId?: string; accept(value: unknown): void; reject(error: Error): void };
type Hooks = {
  onEdit?(command: string, params: unknown, result: unknown): void;
  onSessionChanged?(): void;
  onHistory?(undo: UndoState): void; // the undo state every program_changed of the current session carries
  onRequest?(method: string, params: unknown): void;
};

export class WebSocketBackend implements ApplicationBackend {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private sessionId: string | undefined;
  private sessionRevision = 0;
  private pending = new Map<number, Pending>();
  private progress = new Map<number, (event: OpenProgress) => void>();
  private changes = new Set<(sessionId: string, event: ProgramChange) => void>();
  private errors = new Set<(message: string) => void>();
  private analyses = new Set<(sessionId: string, state: AnalysisState) => void>();
  private debugs = new Set<(sessionId: string, state: DebugState) => void>();
  capabilities: ReadonlySet<Capability> = new Set();
  recovery?: { snapshotIntervalSeconds: number };

  constructor(private hooks: Hooks = {}) {}

  async connect(port: number, token: string): Promise<void> {
    const ws = this.ws = new WebSocket(`ws://127.0.0.1:${port}/${token}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new BackendError("connection", "Could not connect to the backend"));
      ws.onmessage = (ev) => this.receive(ev.data);
      ws.onclose = () => {
        const error = new BackendError("connection", "The backend connection closed");
        reject(error);
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
      };
    });
    try {
      const info = await this.send(this.nextId++, "provider_info", {});
      this.capabilities = knownCapabilities(info.capabilities);
      this.recovery = this.capabilities.has("recovery") ? info.recovery : undefined;
    } catch (error) {
      ws.close();
      throw new BackendError("protocol", `Backend discovery failed. A provider supporting protocol version 1 is required. ${error instanceof Error ? error.message : error}`);
    }
  }

  private receive(data: unknown) {
    let reply: unknown;
    try { reply = typeof data === "string" ? JSON.parse(data) : null; } catch { reply = null; }
    if (!object(reply) || reply.jsonrpc !== "2.0") {
      const error = new BackendError("protocol", "Invalid response from the backend");
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
      for (const listener of this.errors) listener(error.message);
      this.ws?.close();
      return;
    }
    if (reply.id === undefined) {
      if (reply.method === "progress" && notifications.progress(reply.params)) {
        const p = reply.params as Notifications["progress"];
        this.progress.get(p.openId)?.(p);
      } else if (reply.method === "program_changed" && notifications.program_changed(reply.params)) {
        const { sessionId, ...event } = reply.params as Notifications["program_changed"];
        if (sessionId === this.sessionId) { this.hooks.onHistory?.(event.undo); for (const listener of this.changes) listener(sessionId, event); }
      } else if (reply.method === "analysis_state" && notifications.analysis_state(reply.params)) {
        const { sessionId, ...state } = reply.params as Notifications["analysis_state"];
        if (sessionId === this.sessionId) for (const listener of this.analyses) listener(sessionId, state);
      } else if (reply.method === "debug_state" && notifications.debug_state(reply.params)) {
        const { sessionId, ...state } = reply.params as Notifications["debug_state"];
        if (sessionId === this.sessionId) for (const listener of this.debugs) listener(sessionId, state);
      } else if (reply.method === "error" && notifications.error(reply.params)) {
        for (const listener of this.errors) listener((reply.params as Notifications["error"]).message);
      }
      return;
    }
    const id = reply.id;
    if (typeof id !== "number") return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.sessionId !== undefined && p.sessionId !== this.sessionId) p.reject(this.stale());
    else if (object(reply.error) && typeof reply.error.code === "number" && typeof reply.error.message === "string") {
      p.reject(new BackendError(kinds[reply.error.code] ?? "internal", reply.error.message));
    } else p.accept(reply.result);
  }

  private open<M extends "open_binary" | "open_program">(method: M, params: Omit<Params<M>, "analysis">, onProgress: (event: OpenProgress) => void, mode?: AnalysisMode): OpenJob {
    const unsupported = method === "open_program" && !this.capabilities.has("projects");
    if (unsupported) return { result: Promise.reject(this.unsupported("projects")), cancel: async () => false };
    const id = this.nextId++;
    this.progress.set(id, onProgress);
    const result = this.send(id, method, { ...params, ...(mode && this.capabilities.has("analysis") ? { analysis: mode } : {}) } as Params<M>).then((session) => {
      this.adopt(session);
      return session;
    }).finally(() => this.progress.delete(id));
    return { result, cancel: async () => this.progress.has(id) && (await this.send(this.nextId++, "cancel_open", { id })).cancelled };
  }

  private stale() { return new BackendError("stale", "Program session is no longer active"); }

  private adopt(session: ActiveSession | null) {
    if (session?.sessionId === this.sessionId) return;
    this.sessionId = session?.sessionId;
    this.sessionRevision++;
    for (const [id, p] of this.pending) {
      if (p.sessionId === undefined || p.sessionId === this.sessionId) continue;
      this.pending.delete(id);
      p.reject(this.stale());
    }
    this.hooks.onSessionChanged?.();
  }

  readonly lifecycle: ProgramLifecycle = {
    open: (path, options, onProgress, mode) => this.open("open_binary", { ...options, path }, onProgress, mode),
    active: async () => {
      const revision = this.sessionRevision;
      const session = await this.send(this.nextId++, "active_session", {});
      if (revision !== this.sessionRevision) throw this.stale();
      this.adopt(session);
      return session;
    },
    close: async (session) => {
      await this.send(this.nextId++, "close_program", {}, session.sessionId);
      this.adopt(null);
    },
  };
  readonly events: ProviderEvents = {
    onChange: (listener) => { this.changes.add(listener); return () => this.changes.delete(listener); },
    onError: (listener) => { this.errors.add(listener); return () => this.errors.delete(listener); },
    onAnalysis: (listener) => { this.analyses.add(listener); return () => this.analyses.delete(listener); },
    onDebug: (listener) => { this.debugs.add(listener); return () => this.debugs.delete(listener); },
  };
  readonly projects: ProjectCatalog = {
    list: () => this.request("projects", "list_programs", {}),
    remove: (params) => this.request("projects", "delete_program", params),
    reopen: ({ programId }, progress, mode) => this.open("open_program", { programId }, progress, mode),
  };
  readonly imports: ImportSelection = {
    choices: (params) => this.request("importOptions", "import_candidates", params),
    languages: () => this.request("importOptions", "list_languages", {}),
  };

  program({ sessionId }: ActiveSession): ProgramOperations {
    const read = <M extends Method>(method: M, params: Params<M>, cap?: Capability) => this.request(cap, method, params, sessionId);
    const job = <M extends Method>(cap: Capability, method: M, params: Params<M>, cancelWith: "cancel_search" | "cancel_decompile"): Job<Result<M>> => {
      const id = this.nextId++;
      const result = this.capabilities.has(cap)
        ? this.send(id, method, params, sessionId)
        : Promise.reject(this.unsupported(cap));
      return { result, cancel: () => {
        if (this.pending.has(id)) this.send(this.nextId++, cancelWith, { id }).catch(() => {});
      } };
    };
    const edit = async <M extends Method>(cap: Capability, command: string, method: M, params: Params<M>) => {
      const result = await read(method, params, cap);
      if (sessionId !== this.sessionId) throw this.stale();
      this.hooks.onEdit?.(command, params, result);
      return result;
    };

    return {
      listing: { info: () => read("listing_info", {}), rows: (p) => read("listing_rows", p), bytes: (p) => read("get_bytes", p, "bytes") },
      functions: { list: () => read("list_functions", {}), containing: (p) => read("get_function_at", p), stackFrame: (p) => read("stack_frame", p, "stackFrame") },
      decompiler: { decompile: (p) => job("decompile", "decompile", p, "cancel_decompile"), graph: (p) => job("controlFlowGraph", "function_graph", p, "cancel_decompile"), pcode: (p) => job("pcode", "pcode", p, "cancel_decompile"), valueTrail: (p) => job("valueTrail", "value_trail", p, "cancel_decompile") },
      references: {
        xrefsTo: (p) => read("xrefs_to", p, "references"),
        xrefsFrom: (p) => read("xrefs_from", p, "references"),
        xrefsToVariable: (p) => read("xrefs_to_variable", p, "variableReferences"),
        variableUses: (p) => job("variableReferences", "variable_uses", p, "cancel_decompile"),
        callGraph: (p) => job("callGraph", "call_graph", p, "cancel_search"),
        calls: (p) => job("calls", "function_calls", p, "cancel_search"),
      },
      searches: {
        searchSymbols: (p) => job("symbolSearch", "search_symbols", p, "cancel_search"),
        topSymbols: (p) => job("suggestions", "top_symbols", p, "cancel_search"),
        listSymbols: (p) => job("symbolTable", "list_symbols", p, "cancel_search"),
        listStrings: (p) => job("strings", "list_strings", p, "cancel_search"),
        listUndefinedRefs: (p) => job("undefinedRefs", "list_undefined_refs", p, "cancel_search"),
        searchMemory: (p) => job("memorySearch", "search_memory", p, "cancel_search"),
      },
      types: {
        listDataTypes: (p) => job("dataTypes", "list_data_types", p, "cancel_search"),
        dtSources: () => read("dt_sources", {}, "dataTypes"),
        dtChildren: (p) => read("dt_children", p, "dataTypes"),
        getDataType: (p) => read("get_data_type", p, "dataTypes"),
      },
      typeEdits: {
        createDataType: (p) => edit("typeEditing", "createDataType", "create_data_type", p),
        deleteDataType: (p) => edit("typeEditing", "deleteDataType", "delete_data_type", p),
        renameDataType: (p) => edit("typeEditing", "renameDataType", "rename_data_type", p),
        editStruct: (p) => edit("typeEditing", "editStruct", "edit_struct", p),
        editEnum: (p) => edit("typeEditing", "editEnum", "edit_enum", p),
      },
      bookmarks: {
        list: (p) => job("bookmarks", "list_bookmarks", p, "cancel_search"),
        set: (p) => edit("bookmarks", "setBookmark", "set_bookmark", p),
        remove: (p) => edit("bookmarks", "removeBookmark", "remove_bookmark", p),
      },
      patch: {
        assemble: (p) => job("patch", "assemble_instruction", p, "cancel_search"),
        apply: (p) => edit("patch", "patchInstruction", "patch_instruction", p),
        list: () => read("list_patches", {}, "patch"),
      },
      edits: {
        getComments: (p) => read("get_comments", p, "editing"),
        renameSymbol: (p) => edit("editing", "renameSymbol", "rename_symbol", p),
        createLabel: (p) => edit("editing", "createLabel", "create_label", p),
        setComment: (p) => edit("editing", "setComment", "set_comment", p),
        createFunction: (p) => edit("editing", "createFunction", "create_function", p),
        setFunctionSignature: (p) => edit("editing", "setFunctionSignature", "set_function_signature", p),
        renameVariable: (p) => edit("variableEditing", "renameVariable", "rename_variable", p),
        retypeVariable: (p) => edit("variableEditing", "retypeVariable", "retype_variable", p),
        setEquate: (p) => edit("decompilerEdits", "setEquate", "set_equate", p),
        setFunctionNoReturn: (p) => edit("decompilerEdits", "setFunctionNoReturn", "set_function_no_return", p),
        splitVariable: (p) => edit("decompilerEdits", "splitVariable", "split_variable", p),
        forceUnionField: (p) => edit("decompilerEdits", "forceUnionField", "force_union_field", p),
        defineData: (p) => edit("typeEditing", "defineData", "define_data", p),
        clearCode: (p) => edit("editing", "clearCode", "clear_code", p),
        createStructFromData: (p) => edit("typeEditing", "createStructFromData", "create_struct_from_data", p),
        autoCreateStructure: (p) => edit("variableEditing", "autoCreateStructure", "auto_create_structure", p),
      },
      history: {
        state: () => read("undo_state", {}, "undo"),
        undo: () => edit("undo", "undo", "undo", {}),
        redo: () => edit("undo", "redo", "redo", {}),
        save: () => edit("save", "save", "save", {}),
      },
      coverage: { load: (p) => read("load_coverage", p, "coverage") },
      exports: { symbols: (p) => read("export_symbols", p, "export"), header: (p) => read("export_header", p, "export"), gzf: (p) => read("export_gzf", p, "exportGzf") },
      analysis: {
        status: () => read("analysis_status", {}, "analysis"),
        start: (profile) => read("start_analysis", profile ? { profile } : {}, "analysis"),
        cancel: () => read("cancel_analysis", {}, "analysis"),
      },
      debug: {
        attach: (p) => read("debug_attach", p, "debugger"), detach: () => read("debug_detach", {}, "debugger"), breakpoint: (p) => read("debug_breakpoint", p, "debugger"),
        continue: () => read("debug_continue", {}, "debugger"), step: (p) => read("debug_step", p ?? {}, "debugger"), pause: () => read("debug_pause", {}, "debugger"),
        status: () => read("debug_status", {}, "debugger"), memory: (p) => read("debug_memory", p, "debugger"),
        values: (p) => job("debugger", "debug_values", p, "cancel_search"),
      },
    };
  }

  private unsupported(cap: Capability) { return new BackendError("unsupported", `The backend does not support ${cap}`); }

  private request<M extends Method>(cap: Capability | undefined, method: M, params: Params<M>, sessionId?: string) {
    return cap && !this.capabilities.has(cap)
      ? Promise.reject(this.unsupported(cap))
      : this.send(this.nextId++, method, params, sessionId);
  }

  private send<M extends Method>(id: number, method: M, params: Params<M>, sessionId?: string): Promise<Result<M>> {
    return new Promise((resolve, reject) => {
      if (sessionId !== undefined && sessionId !== this.sessionId) return reject(this.stale());
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new BackendError("connection", "The backend connection closed"));
      this.pending.set(id, { sessionId, reject, accept: (value) => {
        if (results[method](value)) resolve(value as Result<M>);
        else reject(new BackendError("protocol", `Invalid ${method} response from the backend`));
      } });
      try {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params, sessionId }));
        this.hooks.onRequest?.(method, params);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}
