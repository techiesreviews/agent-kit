import { mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

// A machine without bubblewrap, for the key lock's tests (key-guard.mjs).

/** A PATH folder under `dir` holding every program of this process's PATH but bwrap (an earlier folder's program wins). */
export function pathWithoutBwrap(dir: string) {
  return pathWithout(dir, ["bwrap"], "no-bwrap-bin");
}

/** The same without the programs named `left`, in the folder `name` under `dir`: a machine where those are not installed. */
export function pathWithout(dir: string, left: string[], name: string) {
  const bin = join(dir, name);
  mkdirSync(bin);
  for (const folder of String(process.env.PATH).split(":").filter(Boolean)) {
    let names: string[] = [];
    try { names = readdirSync(folder); } catch { continue; }
    for (const program of names) if (!left.includes(program)) try { symlinkSync(join(folder, program), join(bin, program)); } catch { /* An earlier folder's program wins. */ }
  }
  return bin;
}

// For a child process: every Node it starts says it runs on macOS, where bubblewrap does not exist, or on Linux,
// whatever the host is.
const preload = (name: string) => ({ NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${resolve(import.meta.dirname, `../fixtures/${name}.mjs`)}`.trim() });
export const onMacos = preload("as-macos"), onLinux = preload("as-linux");

/** Runs `body` while this process says it runs on `platform`. */
export function asPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...real, value: platform });
  try { return body(); } finally { Object.defineProperty(process, "platform", real); }
}
