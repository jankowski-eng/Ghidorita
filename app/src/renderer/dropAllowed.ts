/** Why a drop cannot open a file right now (shown to the user), or null when it can. A program that is open is fine: it is saved and replaced, as with File > Open Binary. */
export function dropBlock(s: { opening: boolean; closing: boolean; unavailable: boolean; modal: boolean }): string | null {
  if (s.opening) return "A binary is being opened; wait for it to finish before dropping another.";
  if (s.closing || s.unavailable) return "The analysis engine is not available right now.";
  if (s.modal) return "Close the open dialog before dropping a file.";
  return null;
}
