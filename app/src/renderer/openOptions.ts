import type { ImportCandidate, ImportOptions, ProgramEntry } from "../../../protocol";

/** Raw Binary needs no loader recognition. shortcut: assumed to accept a base address (real list comes from import_candidates when it is offered), upgrade if a sidecar says otherwise. */
export const RAW_CANDIDATE: ImportCandidate = { loader: "Raw Binary", language: null, compilerSpec: null, preferred: true, acceptsBaseAddress: true };

/** Base address input: "" = none; "0x1000" or "1000" -> normalised "0x1000"; must fit 64 bits. */
export function parseBase(s: string): { ok: true; value: string } | { ok: false; error: string } {
  const t = s.trim();
  if (!t) return { ok: true, value: "" };
  const h = /^0x([0-9a-f]+)$/i.exec(t)?.[1] ?? (/^[0-9a-f]+$/i.test(t) ? t : null);
  if (h === null) return { ok: false, error: "Enter a hex address such as 0x08000000" };
  const v = BigInt("0x" + h);
  if (v >= 1n << 64n) return { ok: false, error: "Address does not fit in 64 bits" };
  return { ok: true, value: "0x" + v.toString(16) };
}

export interface ImportChoice { cand: ImportCandidate; language: string | null; compilerSpec: string | null; base: string }

/** What the user may submit: a language is mandatory, the base address (if any) must parse and be accepted by the loader. */
export function choiceError(c: ImportChoice): string | null {
  if (!c.language) return "Choose a language";
  if (c.cand.acceptsBaseAddress) { const b = parseBase(c.base); if (!b.ok) return b.error; }
  return null;
}

/** undefined = plain default import (omit every option so the sha256 key is used); else all explicit options. */
export function buildOptions(c: ImportChoice): ImportOptions | undefined {
  const base = c.cand.acceptsBaseAddress ? parseBase(c.base) : { ok: true as const, value: "" };
  if (!base.ok || !c.language) return undefined;
  if (c.cand.preferred && c.language === c.cand.language && c.compilerSpec === c.cand.compilerSpec && !base.value) return undefined;
  return { loader: c.cand.loader, language: c.language, ...(c.compilerSpec ? { compilerSpec: c.compilerSpec } : {}), ...(base.value ? { baseAddress: base.value } : {}) };
}

/** "Raw Binary · ARM:LE:32:v8 · @0x8000000" for the program browser; "default" for plain imports. */
export const optionsSummary = (o: ImportOptions): string =>
  [o.loader, o.language, o.compilerSpec, o.baseAddress && "@" + o.baseAddress].filter(Boolean).join(" · ") || "default";

/** Parameters to reopen a stored program exactly as it was imported (undefined path = nothing to reopen). */
export const reopenParams = (e: ProgramEntry): { path: string } & ImportOptions | null =>
  e.sourcePath ? { path: e.sourcePath, ...e.options } : null;
