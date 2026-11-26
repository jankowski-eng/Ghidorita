/** The last text copied through `copyText` (the autotest reads it; the system clipboard is not readable without a permission prompt). */
export const copied = { last: "" };

/** Copy to the system clipboard: the web API first (works from a user gesture), the host's validated IPC when the sandbox refuses it. */
export async function copyText(text: string): Promise<void> {
  copied.last = text;
  try { await navigator.clipboard.writeText(text); } catch { await window.host.writeClipboard(text); }
}
