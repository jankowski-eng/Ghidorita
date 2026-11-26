import type { Address, SymbolKind } from "../../../protocol";

/** A command-bar candidate. `refs`: places that reference it; `group` only on the empty bar's suggestions. */
export interface Cand { kind: SymbolKind | "string"; name: string; address: Address; refs?: number; group?: "entry" | "import" | "function"; used?: string }
export interface Ranked extends Cand { why: string; score?: number } // score: only on the empty bar

const places = (n: number) => `used in ${n.toLocaleString()} place${n === 1 ? "" : "s"}`;

// ---- Lead score (the empty command bar): score = kind weight + 10 * log2(1 + references) ----
export const W_ENTRY = 100; // the program's entry point: where reading starts
export const W_INPUT_IMPORT = 70; // an import that reads input: attacker- or user-controlled data enters here
export const W_DANGEROUS_IMPORT = 60; // an import with a classic unsafe use (unbounded copy, format string, shell)
export const W_CRYPTO_IMPORT = 50; // an import of a crypto library: keys, ciphers, hashes
export const W_STRING = 40; // a defined string (not a source path): messages and prompts name what the code does
export const W_OTHER_IMPORT = 30; // any other import (an ordinary libc / API call)
export const W_FUNCTION = 20; // a function of the program itself; only its callers rank it
export const REF_FACTOR = 10; // points per doubling of the reference count

export type ImportClass = "input" | "dangerous" | "crypto" | null;
// Hand-picked, not read from a tool: the usual unsafe-libc / "banned API" names and the common input and crypto entry points of libc, POSIX, Win32 and OpenSSL.
const INPUT = new Set(["read", "pread", "readv", "fread", "fgets", "fgetc", "getc", "getchar", "gets", "scanf", "fscanf", "sscanf", "vscanf", "recv", "recvfrom", "recvmsg", "readline", "readfile", "readfileex", "readconsolea", "readconsolew", "wsarecv", "internetreadfile"]);
const DANGEROUS = new Set(["strcpy", "strcat", "stpcpy", "sprintf", "vsprintf", "gets", "system", "popen", "execl", "execlp", "execle", "execv", "execvp", "execve", "winexec", "createprocessa", "createprocessw", "shellexecutea", "shellexecutew", "wcscpy", "lstrcpya", "lstrcpyw"]);
const CRYPTO = /^(evp_|aes_|rsa_|des_|sha\d*(_|$)|md[245](_|$)|hmac|rc4|chacha|bcrypt|crypt(encrypt|decrypt|hashdata|createhash|acquirecontext|genkey)|cccrypt|cchmac|ccdigest|ssl_|tls_|crypto_)/;

/** Imports come with decoration: `_read`, `read@plt`, `read$stub`, `__imp_ReadFile`, `__isoc99_scanf`, `__sprintf_chk`; strip it before matching. */
const bare = (name: string) => name.toLowerCase().replace(/^__imp_/, "").replace(/^__isoc99_/, "").replace(/^_+/, "").replace(/(@plt|\$stub|@\d+)$/, "").replace(/_chk$/, "");
/** The highest-weighted class an import name falls in: input reading beats dangerous beats crypto. */
export function classifyImport(name: string): ImportClass {
  const n = bare(name);
  return INPUT.has(n) ? "input" : DANGEROUS.has(n) ? "dangerous" : CRYPTO.test(n) ? "crypto" : null;
}
const CLASS_WHY: Record<Exclude<ImportClass, null>, string> = { input: "reads input", dangerous: "dangerous call", crypto: "crypto" };

const weight = (c: Cand): number => {
  if (c.group === "entry") return W_ENTRY;
  if (c.group === "import") { const k = classifyImport(c.name); return k === "input" ? W_INPUT_IMPORT : k === "dangerous" ? W_DANGEROUS_IMPORT : k === "crypto" ? W_CRYPTO_IMPORT : W_OTHER_IMPORT; }
  if (c.kind === "string") return W_STRING;
  return c.kind === "function" ? W_FUNCTION : 0;
};
/** Published rule for a lead's rank on the empty bar: kind weight + 10 x log2(1 + references), rounded for display. */
export const score = (c: Cand): number => Math.round(weight(c) + REF_FACTOR * Math.log2(1 + (c.refs ?? 0)));

export const why = (c: Cand): string => {
  const k = c.group === "import" ? classifyImport(c.name) : null;
  return [c.group === "entry" ? "entry point" : "", k ? CLASS_WHY[k] : "", c.group !== "entry" && c.refs ? places(c.refs) : ""].filter(Boolean).join(" · ");
};

// usefulness tier for a typed query: the entry point, then strings and imports, then other functions, then the rest
const tier = (c: Cand) => (c.group === "entry" ? 0 : c.kind === "string" || c.group === "import" ? 1 : c.kind === "function" ? 2 : 3);

/**
 * Orders candidates by usefulness. Nothing typed: by `score` (kind weight + 10 x log2(1 + references)), highest first. With a typed name:
 * exact then prefix (case-insensitive) matches first, then the entry point, strings and imports, functions, each by reference count. Stable otherwise.
 */
export function rank(q: string, cands: Cand[]): Ranked[] {
  const t = q.trim().toLowerCase();
  if (!t) return cands.map((c, i) => ({ c, i, s: score(c) })).sort((a, b) => b.s - a.s || a.i - b.i).map(({ c, s }) => ({ ...c, why: why(c), score: s }));
  const m = (c: Cand) => (c.kind !== "string" ? (c.name.toLowerCase() === t ? 0 : c.name.toLowerCase().startsWith(t) ? 1 : 2) : 2);
  return cands.map((c, i) => ({ c, i })).sort((a, b) => m(a.c) - m(b.c) || tier(a.c) - tier(b.c) || (b.c.refs ?? 0) - (a.c.refs ?? 0) || a.i - b.i).map(({ c }) => ({ ...c, why: why(c) }));
}

/** Whether a string is worth suggesting as a lead on the empty bar: not a source-file path (`__FILE__` in asserts and logs, referenced
 * from everywhere) and not a very short bare word (`main` as a `__func__`), both of which otherwise outrank every real lead by use count. */
export const isLeadString = (v: string) => !/^\S*\/[^\s/]+\.(c|cc|cpp|cxx|h|hh|hpp|m|mm|swift|rs|go|java|kt|py)$/i.test(v) && !/^\w{1,4}$/.test(v);
