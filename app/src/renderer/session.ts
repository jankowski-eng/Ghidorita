/** Pure helpers for the save/dirty flow. */

/** Window title: "• name — Ghidrette" while there are unsaved changes. */
export const windowTitle = (name: string | null, dirty: boolean): string =>
  (name ? `${dirty ? "• " : ""}${name} — ` : "") + "Ghidrette";
