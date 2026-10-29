import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const namedColours = new Set(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(" "));
const channels = {
  rgb: "r g b", rgba: "r g b", hsl: "h s l", hsla: "h s l", hwb: "h w b",
  lab: "l a b", lch: "l c h", oklab: "l a b", oklch: "l c h",
};
const blank = text => text.replace(/[^\r\n]/g, " ");

function closingParen(text, open) {
  let depth = 1;
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "(") depth++;
    if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

function blankIgnored(text) {
  let code = text.replace(/\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)/g, blank);
  const urls = /(?<![\w-])url\(/gi;
  for (let found; (found = urls.exec(code));) {
    const end = closingParen(code, urls.lastIndex - 1);
    const stop = end < 0 ? code.length : end + 1;
    code = code.slice(0, found.index) + blank(code.slice(found.index, stop)) + code.slice(stop);
    urls.lastIndex = stop;
  }
  return code;
}

function alphaOnly(name, body) {
  const source = /^\s*from\s+(?:currentcolor\b|var\()/i.exec(body);
  if (!source) return false;
  let rest = body.slice(source[0].length);
  if (/var\($/i.test(source[0])) {
    const end = closingParen(body, source[0].length - 1);
    if (end < 0 || !/^\s*--[\w-]+(?:\s*,[\s\S]*)?\s*$/.test(body.slice(source[0].length, end))) return false;
    rest = body.slice(end + 1);
  }
  const parts = /^\s*([\s\S]*?)\s*\/\s*(\S[\s\S]*)$/.exec(rest.toLowerCase());
  if (!parts) return false;
  const unchanged = parts[1].replace(/\s+/g, " ");
  if (name === "color") {
    return /^(?:(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020) r g b|xyz(?:-d50|-d65)? x y z)$/.test(unchanged);
  }
  return unchanged === channels[name];
}

/** Find raw colours in declaration values, retaining original source positions. */
export function colourLiterals(text) {
  const code = blankIgnored(text);
  const findings = [];
  // A chunk before an opening brace is a selector or at-rule, including nesting.
  const chunks = /([^{};]*)([{};]|$)/g;
  for (const chunk of code.matchAll(chunks)) {
    if (chunk[2] === "{") continue;
    const colon = chunk[1].indexOf(":");
    if (colon < 0) continue;
    const start = chunk.index + colon + 1;
    const value = chunk[1].slice(colon + 1);
    const tokens = /(?<![\w-])(?:#[\da-f]{3,8}(?![\w-])|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|[a-z][\w-]*)/gi;
    for (const token of value.matchAll(tokens)) {
      const word = token[0].toLowerCase();
      let stop = token.index + token[0].length;
      if (word.endsWith("(")) {
        const end = closingParen(value, stop - 1);
        if (end >= 0) {
          if (alphaOnly(word.slice(0, -1), value.slice(stop, end))) continue;
          stop = end + 1;
        }
      } else if (word.startsWith("#")) {
        if (![4, 5, 7, 9].includes(word.length)) continue;
      } else if (!namedColours.has(word)) continue;
      const offset = start + token.index;
      findings.push({ line: code.slice(0, offset).split("\n").length, match: text.slice(offset, start + stop) });
    }
  }
  return findings;
}

/** Apply line-based exceptions; invalid and unused entries remain failures. */
export function checkColours(files, allow = []) {
  const used = new Set();
  const failures = [];
  const valid = [];
  if (!Array.isArray(allow)) return [{ file: "scripts/check-colours.allow.json", line: 1, match: "allow list must be an array" }];
  allow.forEach((entry, index) => {
    if (!entry || typeof entry.file !== "string" || !entry.file.trim() || typeof entry.match !== "string" || !entry.match.trim() || typeof entry.reason !== "string" || !entry.reason.trim()) {
      failures.push({ file: "scripts/check-colours.allow.json", line: index + 1, match: "allow entry requires file, match and reason" });
    } else valid.push({ ...entry, index });
  });
  for (const { file, text } of files) {
    const lines = text.split("\n");
    for (const finding of colourLiterals(text)) {
      const entries = valid.filter(entry => entry.file === file && lines[finding.line - 1].includes(entry.match));
      for (const entry of entries) used.add(entry.index);
      if (!entries.length) failures.push({ file, ...finding });
    }
  }
  for (const entry of valid) {
    if (!used.has(entry.index)) failures.push({ file: "scripts/check-colours.allow.json", line: entry.index + 1, match: `stale allow entry: ${entry.file}: ${entry.match}` });
  }
  return failures;
}

function styles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? styles(path) : entry.name.endsWith(".css") ? [path] : [];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = styles(join(root, "src")).filter(file => file !== join(root, "src/theme.css"))
    .map(file => ({ file: relative(root, file), text: readFileSync(file, "utf8") }));
  const allow = JSON.parse(readFileSync(join(root, "scripts/check-colours.allow.json"), "utf8"));
  const failures = checkColours(files, allow);
  for (const { file, line, match } of failures) console.error(`${file}:${line}: ${match}`);
  if (failures.length) process.exitCode = 1;
}
