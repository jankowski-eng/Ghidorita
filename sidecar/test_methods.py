"""The RPC method table and each method's lane, locked down (no JVM). A new method means a new line here, in protocol.ts and in protocol.md."""
import os, re

from ghidorita.app import App

# lane: R (thread R), edit (prepare on S, commit on R), file (parse off R), scan (S pool), decomp (D pool), project (R, Busy during an open),
# project+busy_ok (same, but answered during an open), loop (asyncio loop), loop+scoped (asyncio loop after the session check), open (own thread O)
GOLDEN = {
    "provider_info": "loop", "active_session": "loop",
    "cancel_decompile": "loop", "cancel_search": "loop", "cancel_open": "loop", "cancel_analysis": "loop+scoped", "analysis_status": "loop+scoped",
    "open_binary": "open", "open_program": "open",
    "close_program": "project", "import_candidates": "project", "list_programs": "project", "delete_program": "project",
    "list_languages": "project+busy_ok",
    "search_symbols": "scan", "export_symbols": "scan", "export_header": "scan", "export_gzf": "R", "function_calls": "scan", "top_symbols": "scan", "list_symbols": "scan", "list_strings": "scan", "list_undefined_refs": "scan", "search_memory": "scan", "list_data_types": "scan", "list_bookmarks": "scan", "call_graph": "scan", "debug_values": "scan", "assemble_instruction": "scan",
    "decompile": "decomp", "variable_uses": "decomp", "function_graph": "decomp", "pcode": "decomp", "value_trail": "decomp",
    "rename_variable": "edit", "retype_variable": "edit", "auto_create_structure": "edit", "split_variable": "edit", "force_union_field": "edit", "load_coverage": "file",
    **{m: "R" for m in (
        "list_functions", "stack_frame", "listing_info", "listing_rows", "get_function_at", "get_bytes", "set_bookmark", "remove_bookmark", "xrefs_to", "xrefs_to_variable", "xrefs_from",
        "debug_attach", "debug_detach", "debug_status", "debug_breakpoint", "debug_continue", "debug_step", "debug_pause", "debug_memory",
        "undo_state", "get_comments", "rename_symbol", "create_label", "set_comment", "create_function",
        "set_function_signature", "set_equate", "set_function_no_return", "undo", "redo", "define_data", "clear_code", "save", "start_analysis", "dt_sources", "dt_children",
        "get_data_type", "create_data_type", "delete_data_type", "rename_data_type", "edit_struct", "edit_enum",
        "create_struct_from_data", "patch_instruction", "list_patches")},
}


def actual():
    """method -> lane, from the registry the running sidecar dispatches with."""
    return App(start=False).registry.describe()


def test_method_table_is_golden():
    assert actual() == GOLDEN


def test_every_protocol_method_is_registered():
    ts = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "protocol.ts")).read()
    body = ts[ts.index("export interface Methods {"):]
    body = body[:body.index("\n}")]
    declared = set(re.findall(r"^  ([a-z_]+):", body, re.M))
    assert declared and declared <= set(actual()), declared - set(actual())
