import { mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

// A machine without bubblewrap, for the key lock's tests (key-guard.mjs).

/** A PATH folder under `dir` holding every program of this process's PATH but bwrap (an earlier folder's program wins). */
export function pathWithoutBwrap(dir: string) {
  const bin = join(dir, "no-bwrap-bin");
  mkdirSync(bin);
  for (const folder of String(process.env.PATH).split(":").filter(Boolean)) {
    let names: string[] = [];
    try { names = readdirSync(folder); } catch { continue; }
    for (const name of names) if (name !== "bwrap") try { symlinkSync(join(folder, name), join(bin, name)); } catch { /* An earlier folder's program wins. */ }
  }
  return bin;
}

// For a child process: every Node it starts says it runs on macOS, where bubblewrap does not exist.
const preload = resolve(import.meta.dirname, "../fixtures/as-macos.mjs");
export const onMacos = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim() };

/** Runs `body` while this process says it runs on `platform`. */
export function asPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...real, value: platform });
  try { return body(); } finally { Object.defineProperty(process, "platform", real); }
}
