"""The RPC method table and each method's lane, locked down (no JVM). A new method means a new line here, in protocol.ts and in protocol.md."""
import os, re

from ghidrette.app import App

# lane: R (thread R), edit (prepare on S, commit on R), file (parse off R), scan (S pool), decomp (D pool), project (R, Busy during an open),
# project+busy_ok (same, but answered during an open), loop (asyncio loop), open (own thread O)
GOLDEN = {
    "provider_info": "loop", "active_session": "loop",
    "cancel_decompile": "loop", "cancel_search": "loop", "cancel_open": "loop",
    "open_binary": "open",
    "close_program": "project", "import_candidates": "project", "list_programs": "project", "delete_program": "project",
    "list_languages": "project+busy_ok",
    "search_symbols": "scan", "top_symbols": "scan", "list_symbols": "scan", "list_strings": "scan", "search_memory": "scan", "list_data_types": "scan",
    "decompile": "decomp", "variable_uses": "decomp", "function_graph": "decomp",
    "rename_variable": "edit", "retype_variable": "edit", "auto_create_structure": "edit", "load_coverage": "file",
    **{m: "R" for m in (
        "list_functions", "listing_info", "listing_rows", "get_function_at", "xrefs_to", "xrefs_to_variable", "xrefs_from",
        "undo_state", "get_comments", "rename_symbol", "create_label", "set_comment", "create_function",
        "set_function_signature", "undo", "redo", "define_data", "clear_code", "save", "dt_sources", "dt_children",
        "get_data_type", "create_data_type", "delete_data_type", "rename_data_type", "edit_struct", "edit_enum",
        "create_struct_from_data")},
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
