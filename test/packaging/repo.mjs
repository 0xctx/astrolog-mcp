import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Helpers for the packaging tests. Not a test file: vitest only runs *.test.mjs here.
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

// The source the server and its scripts run: every .ts, .js and .mjs file under src/ and scripts/, minus tests.
export function codeText() {
  const parts = [];
  for (const dir of ["src", "scripts"]) {
    for (const rel of fs.readdirSync(path.join(repoRoot, dir), { recursive: true })) {
      if (!/\.(ts|js|mjs)$/.test(rel) || /\.test\.[cm]?[jt]s$/.test(rel)) continue;
      parts.push(read(path.join(dir, rel)));
    }
  }
  return parts.join("\n");
}

// The variables the code reads: process.env.NAME, or env.NAME where env is the process environment by default.
export function envReadByCode() {
  return new Set([...codeText().matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]));
}

// The names set by ENV instructions in a Dockerfile, with backslash continuations joined first.
export function dockerfileEnvNames(text) {
  const joined = text.replace(/\\\r?\n\s*/g, " ");
  const names = new Set();
  for (const line of joined.split("\n")) {
    if (!/^\s*ENV\s/.test(line)) continue;
    for (const m of line.matchAll(/([A-Z][A-Z0-9_]*)=/g)) names.add(m[1]);
  }
  return names;
}

// The keys under the environment: block of each service in a compose file.
export function composeEnvNames(text) {
  const names = new Set();
  let block = null;
  for (const line of text.split("\n")) {
    const start = line.match(/^(\s*)environment:\s*$/);
    if (start) {
      block = start[1].length;
      continue;
    }
    if (block === null || line.trim() === "") continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= block) {
      block = null;
      continue;
    }
    const key = line.match(/^\s*([A-Z][A-Z0-9_]*):/);
    if (key) names.add(key[1]);
  }
  return names;
}

// The variable names in the first column of the README's environment table, such as | `PORT` |.
export function readmeEnvTableNames(text) {
  return new Set([...text.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)].map((m) => m[1]));
}

// The markdown pages the links test reads: the README, AGENTS.md, CONTRIBUTING.md and every page under docs/.
export function docPages() {
  const guides = fs.readdirSync(path.join(repoRoot, "docs")).filter((f) => f.endsWith(".md"));
  return ["README.md", "AGENTS.md", "CONTRIBUTING.md", ...guides.map((f) => `docs/${f}`)];
}

// The anchor each heading makes on GitHub: lower case, punctuation dropped, spaces made hyphens.
export function headingAnchors(text) {
  const anchors = new Set();
  for (const [, heading] of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    anchors.add(heading.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-"));
  }
  return anchors;
}

// The relative links of a markdown page that do not resolve: a file that is missing, or an anchor no heading of that page makes.
export function brokenLinks(rel) {
  const broken = [];
  for (const [, target] of read(rel).matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [file, anchor = ""] = target.split("#");
    const page = file ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), file)) : rel;
    if (!fs.existsSync(path.join(repoRoot, page))) {
      broken.push(target);
    } else if (anchor && page.endsWith(".md") && !headingAnchors(read(page)).has(anchor)) {
      broken.push(target);
    }
  }
  return broken;
}
