import type { Capability } from "../../../protocol";
import { TOOLS } from "./tools";
import { modeAllows, type AccessMode, type ToolDef } from "./types";

/** The one place that decides what a mode offers: tools/list and call authorisation both go through it. `capabilities` (the provider's) gates tools that name one; undefined = no gating. */
export function visibleTools(mode: AccessMode, opts: { headless?: boolean; capabilities?: ReadonlySet<Capability> } = {}, table: readonly ToolDef[] = TOOLS): ToolDef[] {
  return table.filter((t) => modeAllows(mode, t.access) && !(t.appOnly && opts.headless)
    && (!opts.capabilities || !t.capability || [t.capability].flat().every((c) => opts.capabilities!.has(c))));
}
