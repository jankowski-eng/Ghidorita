import type { FunctionInfo } from "../../../protocol";

/** The colour language (storyboard "Visual language"): every colour also has a shape, so nothing depends on colour alone. */
export const COLORS = { confirmed: "#F4F1EA", inferred: "#F2B84B", library: "#5EC8E5", unknown: "#7D8794", attention: "#FF7A59", brand: "#7CE38B" } as const;

export type Dot = { kind: "confirmed" | "inferred" | "library" | "unknown"; color: string; shape: "solid" | "ring" | "dashed"; label: string };
const DOTS: Record<Dot["kind"], Dot> = {
  confirmed: { kind: "confirmed", color: COLORS.confirmed, shape: "solid", label: "named by you" },
  inferred: { kind: "inferred", color: COLORS.inferred, shape: "ring", label: "named by analysis" },
  library: { kind: "library", color: COLORS.library, shape: "solid", label: "from the file" },
  unknown: { kind: "unknown", color: COLORS.unknown, shape: "dashed", label: "unnamed" },
};
/** The dot for who named a function (FunctionInfo.source); a source we do not know is shown as unknown. */
export const dotOf = (source: FunctionInfo["source"] | undefined): Dot => DOTS[source === "user" ? "confirmed" : source === "analysis" ? "inferred" : source === "imported" ? "library" : "unknown"];

/** The dot for who made a stack slot (StackSlot.source): analysis and default names are inferred (amber ring), a person's is confirmed, the file's own is from the file. */
export const slotDot = (source: FunctionInfo["source"] | undefined): Dot =>
  source === "analysis" || source === "default" ? { ...DOTS.inferred, label: source === "default" ? "inferred: default name" : "inferred by analysis" } : dotOf(source);

/** Coverage mark (Coverage.mark) -> how it is drawn: both runs green; only one run in the attention colour, A solid with the letter A, B hatched with the letter B. */
export const COV_BOTH = "#4ec36b";
export function covStyle(mark: string): { color: string; letter: "" | "A" | "B"; hatched: boolean } | null {
  switch (mark) {
    case " cov": return { color: COV_BOTH, letter: "", hatched: false };
    case " cov-a": return { color: COLORS.attention, letter: "A", hatched: false };
    case " cov-b": return { color: COLORS.attention, letter: "B", hatched: true };
    default: return null;
  }
}
