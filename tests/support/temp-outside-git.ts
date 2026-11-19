import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { orbitWorkTreeAround } from "../../orbit-client.mjs";

/**
 * A new temp folder outside every git work tree, for a test whose HOME holds an Orbit setup: the kit refuses one inside
 * a work tree, and walks up to the root to look. /tmp is shared with every tool on the machine, and in the kit release's
 * gate (TOOLS-354) something made it a git work tree for a moment, which failed five kit ticket tests. So the folder is
 * made in Linux's shared memory folder first, which far fewer tools write to than /tmp (KIT_TEST_SHM names a folder
 * there instead: the clean guard gives its suite one of its own and checks it for leftovers), and only then in the
 * system temp folder (a sandbox that cannot write /dev/shm, or a system without it); a base that cannot be written or
 * sits inside a work tree is passed over. /dev/shm is often mounted noexec: no fake program can run from such a folder.
 * Throws, naming the work tree, when every base is passed over.
 */
export function tempOutsideGit(prefix: string, bases = [process.env.KIT_TEST_SHM || "/dev/shm", tmpdir()]): string {
  const inside: string[] = [];
  for (const base of bases) {
    let folder: string;
    try { folder = mkdtempSync(join(base, prefix)); } catch { continue; }
    const tree = orbitWorkTreeAround(join(folder, "probe"));
    if (!tree) return folder;
    rmSync(folder, { recursive: true, force: true });
    inside.push(`${base} is inside ${tree}`);
  }
  throw new Error(`no temp folder outside a git work tree: ${inside.join("; ") || `none of ${bases.join(", ")} can be written`}`);
}
