"""Entry point and section list of an ELF, PE or Mach-O file from its headers alone (a few reads, no Ghidra load): the import card's
summary. Anything unrecognised or malformed gives None; the card then shows neither."""
import math, struct
from collections import Counter

MAX_SECTIONS = 32
SAMPLE = 16384


def shannon(b):
    """Shannon entropy (bits/byte, 0-8) of `b`."""
    return abs(round(-sum(c / len(b) * math.log2(c / len(b)) for c in Counter(b).values()), 2)) if b else 0.0  # abs: a constant slice is -0.0


def _section(f, name, off, size):
    f.seek(off)
    return {"name": name, "size": size, "entropy": shannon(f.read(min(SAMPLE, size)))}


def _elf(f, h):
    e = "<" if h[5] == 1 else ">"
    if h[4] == 2:
        entry, shoff = struct.unpack_from(e + "QQ", h, 24)[0], struct.unpack_from(e + "Q", h, 40)[0]
        shentsize, shnum, shstrndx = struct.unpack_from(e + "HHH", h, 58)
    else:
        entry, shoff = struct.unpack_from(e + "I", h, 24)[0], struct.unpack_from(e + "I", h, 32)[0]
        shentsize, shnum, shstrndx = struct.unpack_from(e + "HHH", h, 46)
    f.seek(shoff)
    raw = f.read(shentsize * shnum)
    def sh(i):  # (name offset, type, offset, size)
        b = raw[i * shentsize:(i + 1) * shentsize]
        return struct.unpack_from(e + "II", b, 0) + ((struct.unpack_from(e + "QQ", b, 24)) if h[4] == 2 else struct.unpack_from(e + "II", b, 16))
    st = sh(shstrndx)
    f.seek(st[2])
    names = f.read(st[3])
    out = []
    for i in range(shnum):
        n, t, off, size = sh(i)
        if t not in (0, 8) and size and len(out) < MAX_SECTIONS:  # not NULL / NOBITS
            out.append(_section(f, names[n:names.index(b"\0", n)].decode("latin-1"), off, size))
    return entry, out


def _pe(f, h):
    pe = struct.unpack_from("<I", h, 0x3c)[0]
    f.seek(pe)
    c = f.read(24 + 240)
    if c[:4] != b"PE\0\0":
        return None
    nsec, optsz = struct.unpack_from("<H", c, 6)[0], struct.unpack_from("<H", c, 20)[0]
    magic, rva = struct.unpack_from("<H", c, 24)[0], struct.unpack_from("<I", c, 24 + 16)[0]
    base = struct.unpack_from("<Q", c, 24 + 24)[0] if magic == 0x20b else struct.unpack_from("<I", c, 24 + 28)[0]
    f.seek(pe + 24 + optsz)
    out = []
    for _ in range(min(nsec, MAX_SECTIONS)):
        s = f.read(40)
        raw, ptr = struct.unpack_from("<II", s, 16)
        if raw:
            pos = f.tell()
            out.append(_section(f, s[:8].rstrip(b"\0").decode("latin-1"), ptr, raw))
            f.seek(pos)
    return base + rva, out


def _macho(f, at):
    f.seek(at)
    h = f.read(32)
    magic = struct.unpack_from("<I", h, 0)[0]
    if magic not in (0xfeedface, 0xfeedfacf):
        return None
    w64 = magic == 0xfeedfacf
    ncmds = struct.unpack_from("<I", h, 16)[0]
    f.seek(at + (32 if w64 else 28))
    text, entryoff, out = 0, None, []
    for _ in range(min(ncmds, 256)):
        cmd, size = struct.unpack("<II", f.read(8))
        body = f.read(size - 8)
        if cmd in (0x19, 0x1):  # LC_SEGMENT_64 / LC_SEGMENT
            seg, vmaddr = body[:16].rstrip(b"\0"), struct.unpack_from("<Q" if w64 else "<I", body, 16)[0]
            nsects = struct.unpack_from("<I", body, 56 if w64 else 40)[0]
            if seg == b"__TEXT":
                text = vmaddr
            for i in range(nsects):
                s = body[(64 if w64 else 48) + i * (80 if w64 else 68):][:80 if w64 else 68]
                size, off = struct.unpack_from("<QI", s, 40) if w64 else struct.unpack_from("<II", s, 36)
                if size and off and len(out) < MAX_SECTIONS:
                    out.append((s[:16].rstrip(b"\0").decode("latin-1"), off, size))
        elif cmd == 0x80000028:  # LC_MAIN
            entryoff = struct.unpack_from("<Q", body, 0)[0]
    secs = [_section(f, n, at + o, s) for n, o, s in out]
    return (text + entryoff if entryoff is not None else None), secs


def file_layout(path):
    """{"entry": "0x…" or None, "sections": [{name, size, entropy}]} or None. A Mach-O universal file shows its first slice."""
    try:
        with open(path, "rb") as f:
            h = f.read(64)
            r = None
            if h[:4] == b"\x7fELF":
                r = _elf(f, h)
            elif h[:2] == b"MZ":
                r = _pe(f, h)
            elif h[:4] == b"\xca\xfe\xba\xbe" and struct.unpack_from(">I", h, 4)[0] < 32:  # fat (Java class files share the magic; their second word is a version)
                r = _macho(f, struct.unpack_from(">I", h, 16)[0])
            else:
                r = _macho(f, 0)
            if r is None:
                return None
            entry, secs = r
            return {"entry": hex(entry) if entry is not None else None, "sections": secs}
    except Exception:  # malformed or truncated headers: no summary
        return None
