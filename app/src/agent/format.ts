import type { Address } from "../../../protocol";
import { addrAdd, parseAddr } from "../renderer/address";

// Pure text helpers of the read tools. Everything that comes from the binary goes through `esc` so it cannot forge a line of the tool's own format.

export const MAX_CHARS = 30_000;

// C0, DEL, C1 (incl. NEL), line/paragraph separators and bidi controls
const CONTROL = /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu; // Cf: zero-width and tag characters, invisible to a reader but not to a model
const NAMED: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };
const escapeControl = (s: string) => s.replace(CONTROL, (c) => { const n = c.codePointAt(0)!; return NAMED[c] ?? (n < 256 ? "\\x" + n.toString(16).padStart(2, "0") : n < 0x10000 ? "\\u" + n.toString(16).padStart(4, "0") : "\\u{" + n.toString(16) + "}"); });

/** Untrusted text on one line: control characters escaped, cut at `max` UTF-16 units with a note; `quote` wraps it in double quotes (backslash and quote escaped). */
export function esc(value: unknown, max = 200, quote = false): string {
  const s = String(value ?? "");
  let cut = s.length > max ? s.slice(0, max) : s;
  if (cut.length < s.length && /[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  let out = escapeControl(quote ? cut.replace(/\\/g, "\\\\").replace(/"/g, '\\"') : cut);
  if (quote) out = `"${out}"`;
  return cut.length < s.length ? `${out}…(+${s.length - cut.length} chars)` : out;
}
export const quoted = (value: unknown, max = 200) => esc(value, max, true);

/** Clamp an untrusted number argument to an integer in [lo, hi]; anything that is not a finite number is `def`. */
export const int = (v: unknown, def: number, lo: number, hi: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : def;
  return Math.min(hi, Math.max(lo, n));
};

/** Columns aligned with two spaces between; the last column is not padded. */
export function table(rows: string[][]): string[] {
  const w: number[] = [];
  for (const r of rows) r.forEach((c, i) => { if (i < r.length - 1) w[i] = Math.max(w[i] ?? 0, c.length); });
  return rows.map((r) => r.map((c, i) => (i < r.length - 1 ? c.padEnd(w[i]) : c)).join("  ").trimEnd());
}

/** How many leading items fit in `maxChars` (at least one), each costing its length plus a newline. */
export function fits(lines: string[], maxChars = MAX_CHARS): number {
  let n = 0, chars = 0;
  for (; n < lines.length; n++) {
    const len = lines[n].length + 1;
    if (n > 0 && chars + len > maxChars) break;
    chars += len;
  }
  return n;
}

/**
 * Cut `lines` (one page the caller already has, the first being line `base`) at the character cap and end with a continuation line.
 * `more` = lines that exist beyond this page (the backend's total minus what it returned).
 */
export function capPage(lines: string[], base: number, more = 0, maxChars = MAX_CHARS): string {
  const n = fits(lines, maxChars);
  const left = lines.length - n + more;
  const out = lines.slice(0, n);
  if (left > 0) out.push(`… ${left} more lines: call again with offset=${base + n}`);
  return out.join("\n");
}

/** `lines` from `offset`, at most `limit` of them, cut at the character cap; the continuation names the offset to call again with. */
export function capText(lines: string[], offset = 0, limit = Infinity, maxChars = MAX_CHARS): string {
  const start = Math.max(0, Math.trunc(offset) || 0);
  if (!lines.length) return "(none)";
  if (start >= lines.length) return `(offset ${start} is past the end: ${lines.length} lines in all)`;
  const end = Math.min(lines.length, start + Math.max(1, limit));
  return capPage(lines.slice(start, end), start, lines.length - end, maxChars);
}

/** Zero-pad the offset of `a` to `width` hex digits (space prefix kept). */
export function padAddr(a: Address, width: number): Address {
  const p = parseAddr(a);
  return p ? (p.space || "0x") + p.off.toString(16).padStart(width, "0") : a;
}

/** `addr  hex bytes  |ascii|`, 16 bytes a line; `hex` is the backend's "48 8b 05". Addresses share one width. */
export function hexdump(address: Address, hex: string): string[] {
  const bytes = hex.trim() ? hex.trim().split(/\s+/) : [];
  const starts: Address[] = [];
  for (let i = 0; i < bytes.length; i += 16) starts.push(addrAdd(address, i));
  const width = Math.max(0, ...starts.map((a) => parseAddr(a)?.off.toString(16).length ?? 0));
  return starts.map((a, k) => {
    const row = bytes.slice(k * 16, k * 16 + 16);
    const ascii = row.map((b) => { const c = parseInt(b, 16); return c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : "."; }).join("");
    return `${padAddr(a, width)}  ${row.join(" ").padEnd(47)}  |${ascii}|`;
  });
}

export const nextAddr = (a: Address, length: number): Address => addrAdd(a, Math.max(1, length));
