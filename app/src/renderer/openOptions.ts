import type { AnalysisProfile, ImportCandidate, ImportOptions, ProgramEntry } from "../../../protocol";

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
  if (!c.language && c.cand.requiresLanguage !== false) return "Choose a language";
  if (c.cand.acceptsBaseAddress) { const b = parseBase(c.base); if (!b.ok) return b.error; }
  return null;
}

/** Keep the default loader implicit to preserve the provider's default import key. */
export function buildOptions(c: ImportChoice): ImportOptions | undefined {
  const base = c.cand.acceptsBaseAddress ? parseBase(c.base) : { ok: true as const, value: "" };
  if (!base.ok || choiceError(c)) return undefined;
  const profile = c.profile ? { profile: c.profile } : undefined;
  if (c.cand.preferred && c.language === c.cand.language && c.compilerSpec === c.cand.compilerSpec && !base.value) return profile;
  return { ...profile, loader: c.cand.loader, ...(c.language ? { language: c.language } : {}),
    ...(c.compilerSpec ? { compilerSpec: c.compilerSpec } : {}), ...(base.value ? { baseAddress: base.value } : {}) };
}

/** "Raw Binary · ARM:LE:32:v8 · @0x8000000" for the program browser; "default" for plain imports. */
export const optionsSummary = (o: ImportOptions): string =>
  [o.loader, o.language, o.compilerSpec, o.baseAddress && "@" + o.baseAddress, o.profile === "fast" && "fast analysis"].filter(Boolean).join(" · ") || "default";

/** Plain-language read of an entropy profile (bits/byte per slice): mostly 7.5+ is packed or encrypted, a high tail is a likely appended or packed section. */
export function entropyHint(e: number[]): string {
  if (!e.length) return "";
  const hi = e.filter((x) => x >= 7.5).length;
  if (hi * 2 > e.length) return "Mostly high entropy: likely packed or encrypted.";
  if (hi > 0) return `${hi} of ${e.length} slices look packed or encrypted.`;
  return "No packed or encrypted slices.";
}
