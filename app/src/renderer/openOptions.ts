import type { AnalysisProfile, ImportCandidate, ImportOptions, ProgramEntry } from "../../../protocol";

export const PROFILE_LABEL: Record<AnalysisProfile, string> = { full: "Full", fast: "Fast (skips switch analysis, call-convention ID, stack)" };
/** shortcut: fixed size threshold; fast first open is ~2.4x quicker on a 66 MB binary (SPIKE_REPORT round 4), upgrade to a time estimate once measured on more binaries. */
export const FAST_MIN_BYTES = 20 * 1048576;
export const defaultProfile = (sizeBytes: number): AnalysisProfile => (sizeBytes > FAST_MIN_BYTES ? "fast" : "full");

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

export interface ImportChoice { cand: ImportCandidate; language: string | null; compilerSpec: string | null; base: string; profile?: AnalysisProfile }

/** What the user may submit: a language is mandatory, the base address (if any) must parse and be accepted by the loader. */
export function choiceError(c: ImportChoice): string | null {
  if (!c.language) return "Choose a language";
  if (c.cand.acceptsBaseAddress) { const b = parseBase(c.base); if (!b.ok) return b.error; }
  return null;
}

/** undefined = plain default import (omit every option so the sha256 key is used); else all explicit options. Profile "full" is the sidecar's default and is never sent; "fast" always is. */
export function buildOptions(c: ImportChoice): ImportOptions | undefined {
  const base = c.cand.acceptsBaseAddress ? parseBase(c.base) : { ok: true as const, value: "" };
  if (!base.ok || !c.language) return undefined;
  const profile = c.profile === "fast" ? { profile: "fast" as const } : {};
  if (c.cand.preferred && c.language === c.cand.language && c.compilerSpec === c.cand.compilerSpec && !base.value) return c.profile === "fast" ? profile : undefined;
  return { loader: c.cand.loader, language: c.language, ...(c.compilerSpec ? { compilerSpec: c.compilerSpec } : {}), ...(base.value ? { baseAddress: base.value } : {}), ...profile };
}

/** "Raw Binary · ARM:LE:32:v8 · @0x8000000" for the program browser; "default" for plain imports. */
export const optionsSummary = (o: ImportOptions): string =>
  [o.loader, o.language, o.compilerSpec, o.baseAddress && "@" + o.baseAddress, o.profile === "fast" && "fast analysis"].filter(Boolean).join(" · ") || "default";

/** Parameters to reopen a stored program exactly as it was imported (undefined path = nothing to reopen). */
export const reopenParams = (e: ProgramEntry): { path: string } & ImportOptions | null =>
  e.sourcePath ? { path: e.sourcePath, ...e.options } : null;

/** Plain-language read of an entropy profile (bits/byte per slice): mostly 7.5+ is packed or encrypted, a high tail is a likely appended or packed section. */
export function entropyHint(e: number[]): string {
  if (!e.length) return "";
  const hi = e.filter((x) => x >= 7.5).length;
  if (hi * 2 > e.length) return "Mostly high entropy: likely packed or encrypted.";
  if (hi > 0) return `${hi} of ${e.length} slices look packed or encrypted.`;
  return "No packed or encrypted slices.";
}
