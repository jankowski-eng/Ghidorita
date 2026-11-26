"""The RPC method table and each method's lane, locked down (no JVM). A new method means a new line here, in protocol.ts and in protocol.md."""
import os, re

import main

# lane: R (thread R), R+job (R, cancellable by request id), scan (S pool), decomp (D pool), project (R, Busy during an open),
# project+busy_ok (same, but answered during an open), loop (asyncio loop), open (own thread O)
GOLDEN = {
    "cancel_decompile": "loop", "cancel_search": "loop", "cancel_open": "loop",
    "open_binary": "open",
    "close_program": "project", "import_candidates": "project", "list_programs": "project", "delete_program": "project",
    "list_languages": "project+busy_ok",
    "search_symbols": "scan", "list_symbols": "scan", "list_strings": "scan", "search_memory": "scan",
    "decompile": "decomp",
    "rename_variable": "R+job", "retype_variable": "R+job", "auto_create_structure": "R+job",
    **{m: "R" for m in (
        "list_functions", "listing_info", "listing_rows", "get_function_at", "xrefs_to", "xrefs_to_variable", "xrefs_from",
        "list_data_types", "undo_state", "get_comments", "rename_symbol", "create_label", "set_comment", "create_function",
        "set_function_signature", "undo", "redo", "define_data", "clear_code", "save", "dt_sources", "dt_children",
        "get_data_type", "create_data_type", "delete_data_type", "rename_data_type", "edit_struct", "edit_enum",
        "create_struct_from_data")},
}


def actual():
    """method -> lane as the code has it today (the tuples and the special cases in handle())."""
    S = main.Sidecar
    out = {m: "R" for m in S.R_METHODS}
    out.update({m: "R+job" for m in S.CANCELLABLE})
    out.update({m: "scan" for m in S.S_METHODS})
    out.update({m: "project" for m in S.P_METHODS})
    out["list_languages"] = "project+busy_ok"
    out.update(decompile="decomp", open_binary="open", cancel_decompile="loop", cancel_search="loop", cancel_open="loop")
    return out


def test_method_table_is_golden():
    assert actual() == GOLDEN


def test_every_protocol_method_is_registered():
    ts = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "protocol.ts")).read()
    body = ts[ts.index("export interface Methods {"):]
    body = body[:body.index("\n}")]
    declared = set(re.findall(r"^  ([a-z_]+):", body, re.M))
    assert declared and declared <= set(actual()), declared - set(actual())
