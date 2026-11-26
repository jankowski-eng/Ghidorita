import { app } from "electron";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { validPath } from "./validPath";

const MAX = 10;
let list: string[] | null = null;
const file = () => path.join(app.getPath("userData"), "recent.json");

export { validPath };

export function getRecent(): string[] {
  if (list) return list;
  try {
    const j = JSON.parse(readFileSync(file(), "utf8"));
    list = Array.isArray(j) ? [...new Set(j.filter(validPath))].slice(0, MAX) : [];
  } catch { list = []; }
  return list;
}

function save() {
  try {
    const tmp = file() + ".tmp";
    writeFileSync(tmp, JSON.stringify(list));
    renameSync(tmp, file());
  } catch (e) { console.error("recent save failed", e); }
}

export function addRecent(p: string) {
  list = [p, ...getRecent().filter((x) => x !== p)].slice(0, MAX);
  save();
}

export function clearRecent() { list = []; save(); }
