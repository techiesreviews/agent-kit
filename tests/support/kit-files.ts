import { relative, resolve } from "node:path";

// The kit is this repo's top folder; a copy of the kit leaves out the repo's own git data, installs, tests and
// project setup (its settings file, launchers and hook config), so a copy holds only what kit update unpacks.
const left = new Set([".git", "node_modules", ".scratch", "tests", "scripts", ".github", ".claude", ".codex", "test-results"]);
export function kitFiles(source: string): boolean {
  const path = relative(resolve("."), source);
  return path === "" || !left.has(path.split("/")[0]);
}
