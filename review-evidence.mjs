// Save a kit review's files as evidence without losing them on a failed save.
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const reviewFiles = [["out.md", "result.md"], ["run.log", "run.log"], ["diff.patch", "diff.patch"], ["refs.txt", "refs.txt"]];

// Copies the temporary review folder's files into createDirectory()'s folder, writes
// findings.json from result.md with findings(text), and only then removes the temporary
// folder; any failure throws and leaves it in place for recovery.
export function saveReviewEvidence(temporary, createDirectory, findings) {
  if (!temporary) return { evidence: "none", record: null };
  const saved = reviewFiles.filter(([source]) => existsSync(join(temporary, source)));
  // Usage errors and unresolvable refs leave nothing to keep: no empty folder.
  const evidence = saved.length ? createDirectory() : "none";
  for (const [source, target] of saved) copyFileSync(join(temporary, source), join(evidence, target));
  let record = null;
  // The structured findings sit beside result.md; a report that does not parse is marked unreadable.
  if (saved.some(([, target]) => target === "result.md")) {
    record = findings(readFileSync(join(evidence, "result.md"), "utf8"));
    writeFileSync(join(evidence, "findings.json.tmp"), JSON.stringify(record, null, 2) + "\n");
    renameSync(join(evidence, "findings.json.tmp"), join(evidence, "findings.json"));
  }
  rmSync(temporary, { recursive: true, force: true });
  return { evidence, record };
}
