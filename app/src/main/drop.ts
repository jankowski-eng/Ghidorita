import { validPath } from "./validPath";

export type DropCheck = { path: string } | { error: string };

/** A drop opens exactly one regular file. `kind` answers from the file system ("file" | "dir" | "none"); the paths come from the renderer, so they are validated like the other open paths. */
export function checkDrop(paths: unknown, kind: (p: string) => "file" | "dir" | "none"): DropCheck {
  if (!Array.isArray(paths) || paths.length === 0) return { error: "Nothing to open: drop a file." };
  if (paths.length > 1) return { error: "Drop one file at a time." };
  const p = paths[0];
  if (!validPath(p)) return { error: "Cannot open that item: it has no usable file path." };
  const k = kind(p);
  return k === "dir" ? { error: "That is a folder: drop a single file." } : k === "none" ? { error: "Cannot open that item: not a readable file." } : { path: p };
}
