// Empty or failed patch-id output must never count as a matching review.
export function sameReviewPatch(reviewedId, currentId) {
  return typeof reviewedId === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(reviewedId) && reviewedId === currentId;
}

// Parse the Markdown variants emitted by kit review without reading files or changing state.
export function openFindings(resultMd) {
  const findings = [];
  let defects = false, section = "", group = "", pending;
  const clean = text => text.trim().replace(/^#{1,6}\s+/, "").replace(/\*\*|__/g, "")
    .replace(/^(?:[-+*]|\d+[.)])\s+/, "").trim();
  const flush = () => {
    if (pending && !/^none\b/i.test(pending.text)) findings.push({ group: pending.group, text: pending.text });
    pending = undefined;
  };
  for (const raw of resultMd.split(/\r?\n/)) {
    const text = clean(raw);
    const heading = /^(Defects(?:\s*[—–-]\s*(Spec|Standards))?|Validation gaps|Optional nits|Spec|Standards)(?::\s*(.*)|\s*)$/i.exec(text);
    if (heading && (!/^(Spec|Standards)$/i.test(heading[1]) || section === "Defects")) {
      flush();
      const label = heading[1].toLowerCase();
      if (label.startsWith("defects")) {
        defects = true;
        section = "Defects";
        group = heading[2] ? heading[2][0].toUpperCase() + heading[2].slice(1).toLowerCase() : "Defects";
      } else if (label === "spec" || label === "standards") {
        group = label[0].toUpperCase() + label.slice(1);
      } else {
        section = label === "validation gaps" ? "Validation gaps" : "Optional nits";
        group = section;
      }
      if (heading[3] && section !== "Optional nits") pending = { group, text: clean(heading[3]), indent: 0 };
      continue;
    }
    if (!text || !section || section === "Optional nits") continue;
    const bullet = /^(\s*)(?:[-+*]|\d+[.)])\s+/.exec(raw);
    const indent = bullet?.[1].length ?? 0;
    if (bullet && (!pending || indent <= pending.indent)) flush();
    if (pending) pending.text += ` ${text}`;
    else pending = { group, text, indent };
  }
  flush();
  const readable = /^REVIEW_STATUS: complete\s*$/m.test(resultMd.replace(/^\uFEFF/, "")) && defects;
  return readable ? { findings, readable } : {
    findings: [{ group: "Review", text: "review format unreadable" }], readable: false,
  };
}
