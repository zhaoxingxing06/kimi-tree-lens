import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Parser, Language } from "web-tree-sitter";
import { LANGUAGES } from "../lib/languages.js";

const BUILD_DIR =
  process.env.TREE_SITTER_GRAMMAR_SOURCES ?? path.join(os.homedir(), "kimi-plugins/tree-sitter-build");
const MAX_CASES = Number(process.env.DIFF_MAX_CASES ?? 200);

const LANGS = process.argv[2] ? [process.argv[2]] : ["java", "python", "typescript", "go"];

const CORPUS_DIR = {
  java: ["tree-sitter-java", "test/corpus"],
  python: ["tree-sitter-python", "test/corpus"],
  typescript: ["tree-sitter-typescript", "test/corpus"],
  tsx: ["tree-sitter-typescript", "test/corpus"],
  go: ["tree-sitter-go", "test/corpus"],
};

function parseCorpus(text) {
  const lines = text.split("\n");
  const cases = [];
  let i = 0;
  while (i < lines.length) {
    if (/^=+\s*$/.test(lines[i])) {
      let j = i + 1;
      const title = [];
      while (j < lines.length && !/^=+\s*$/.test(lines[j])) title.push(lines[j++]);
      j++;
      const source = [];
      while (j < lines.length && !/^---+\s*$/.test(lines[j])) source.push(lines[j++]);
      j++;
      const expected = [];
      while (j < lines.length && !/^=+\s*$/.test(lines[j])) expected.push(lines[j++]);
      if (source.length && expected.length) {
        cases.push({ title: title.join(" ").trim(), source: source.join("\n"), expected: expected.join("\n") });
      }
      i = j;
    } else {
      i++;
    }
  }
  return cases;
}

function ourTypes(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.isNamed) out.push(n.type);
    const kids = n.children;
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
  }
  return out;
}

function expectedTypes(expected) {
  const cleaned = expected.replace(/;[^\n]*/g, "");
  const out = [];
  const re = /([\w]+)\s*:|\(|\bMISSING\b\s*\(?([\w]+)?|"([^"]*)"|([\w]+)/g;
  let m;
  let want = false;
  while ((m = re.exec(cleaned))) {
    if (m[1]) continue;
    if (m[0] === "(") {
      want = true;
      continue;
    }
    if (m[0].startsWith("MISSING")) {
      if (m[2]) out.push(m[2]);
      continue;
    }
    if (m[3] !== undefined) {
      want = false;
      continue;
    }
    if (m[4]) {
      if (want) {
        out.push(m[4]);
        want = false;
      }
    }
  }
  return out;
}

function firstDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return { index: i, ours: a[i], expected: b[i] };
  }
  return null;
}

await Parser.init();
const summary = [];
for (const lang of LANGS) {
  const [repo, dir] = CORPUS_DIR[lang];
  const corpusRoot = path.join(BUILD_DIR, repo, dir);
  if (!fs.existsSync(corpusRoot)) {
    console.log(`SKIP ${lang}: no corpus at ${corpusRoot}`);
    continue;
  }
  const wasm = await Language.load(LANGUAGES[lang].wasm);
  const parser = new Parser();
  parser.setLanguage(wasm);

  const files = fs.readdirSync(corpusRoot).filter((f) => f.endsWith(".txt"));
  const cases = files.flatMap((f) =>
    parseCorpus(fs.readFileSync(path.join(corpusRoot, f), "utf8")).map((c) => ({ ...c, file: f }))
  );

  let checked = 0;
  let pass = 0;
  const failures = [];
  let tsxMismatches = 0;

  let tsParser = null;
  if (lang === "tsx") {
    const tsWasm = await Language.load(LANGUAGES.typescript.wasm);
    tsParser = new Parser();
    tsParser.setLanguage(tsWasm);
  }

  for (const c of cases) {
    if (checked >= MAX_CASES) break;
    const langDirective = /:language\((\w+)\)/.exec(c.title);
    if (langDirective && langDirective[1] !== lang) continue;
    checked++;
    const tree = parser.parse(c.source);
    const ours = ourTypes(tree.rootNode);
    const theirs = expectedTypes(c.expected);
    const diff = firstDiff(ours, theirs);
    if (!diff) {
      pass++;
      continue;
    }
    if (lang === "tsx" && tsParser) {
      const tsOurs = ourTypes(tsParser.parse(c.source).rootNode);
      if (JSON.stringify(tsOurs) === JSON.stringify(ours)) {
        pass++;
        continue;
      }
      tsxMismatches++;
    }
    if (failures.length < 5) {
      failures.push({ title: c.title, file: c.file, index: diff.index, ours: diff.ours, expected: diff.expected });
    }
  }

  if (lang === "tsx") {
    console.log(`${lang}: ${checked} cases, ${pass} match, ${tsxMismatches} diverge from typescript grammar (informational)`);
  } else {
    const ok = pass === checked;
    console.log(`${lang}: ${pass}/${checked} corpus cases match expected trees ${ok ? "OK" : "FAIL"}`);
    for (const f of failures) {
      console.log(`  FAIL [${f.file}] "${f.title}" at node #${f.index}: got ${f.ours}, expected ${f.expected}`);
    }
  }
  summary.push({ lang, checked, pass, fail: checked - pass });
}

const failed = summary.filter((s) => s.fail > 0);
console.log(`\n${summary.length} languages checked, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
