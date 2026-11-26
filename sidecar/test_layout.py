"""Entry point and sections from file headers (no Ghidra needed)."""
import os, struct

from ghidrette.domains.layout import file_layout

BIN = "/bin/ls"


def test_elf64_entry_and_sections(tmp_path):
    data = bytes(range(256)) * 4  # section body, entropy 8
    names = b"\0.text\0.shstrtab\0"
    body_off, str_off, sh_off = 64, 64 + len(data), 64 + len(data) + len(names)
    hdr = bytearray(64)
    hdr[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<Q", hdr, 24, 0x401000)  # e_entry
    struct.pack_into("<Q", hdr, 40, sh_off)
    struct.pack_into("<HHH", hdr, 58, 64, 3, 2)  # shentsize, shnum, shstrndx
    def sh(name, typ, off, size):
        b = bytearray(64)
        struct.pack_into("<II", b, 0, name, typ)
        struct.pack_into("<QQ", b, 24, off, size)
        return bytes(b)
    p = tmp_path / "t.elf"
    p.write_bytes(bytes(hdr) + data + names + sh(0, 0, 0, 0) + sh(1, 1, body_off, len(data)) + sh(7, 3, str_off, len(names)))
    lay = file_layout(str(p))
    assert lay["entry"] == "0x401000"
    assert [s["name"] for s in lay["sections"]] == [".text", ".shstrtab"]
    assert lay["sections"][0] == {"name": ".text", "size": 1024, "entropy": 8.0}


def test_unrecognised_or_truncated_is_none(tmp_path):
    p = tmp_path / "x"
    p.write_bytes(b"\x7fELF\x02\x01" + b"\0" * 10)  # truncated header
    assert file_layout(str(p)) is None
    p.write_bytes(b"hello world")
    assert file_layout(str(p)) is None


def test_bin_ls_has_layout():
    lay = file_layout(BIN)
    assert lay and lay["sections"] and all(0 <= s["entropy"] <= 8 and s["size"] > 0 for s in lay["sections"])
