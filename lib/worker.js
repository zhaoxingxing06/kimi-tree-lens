import { parentPort } from "node:worker_threads";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { Parser, Language, Query } from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import { LANGUAGES, langForFile, SUPPORTED } from "./languages.js";
import { MAX_BYTES, MAX_DEFS, MAX_MATCHES, MAX_SNIPPET, MAX_CODE, clip } from "./trim.js";
import { PATTERNS } from "./patterns.js";
import { COMPLEXITY_SPEC, CALL_SPEC, countDecisions, callsOf } from "./analysis.js";
import { readFileSync, watch as fsWatch } from "node:fs";

const GRAMMAR_HASHES = JSON.parse(
  readFileSync(new URL("./grammar-hashes.json", import.meta.url), "utf8")
);

const coreWasm = fileURLToPath(import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm"));
await Parser.init({ locateFile: () => coreWasm });

class ToolError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const langPool = new Map();

const USER_QUERY_ROOT =
  process.env.TREE_SITTER_MCP_USER_QUERIES ?? path.join(os.homedir(), ".kimi-code", "tree-sitter-queries");
const userDefDir = (lang) => path.join(USER_QUERY_ROOT, lang);

async function userQuerySig(dir) {
  try {
    const entries = (await fs.readdir(dir)).filter((f) => f.endsWith(".scm")).sort();
    const sigs = await Promise.all(
      entries.map(async (f) => {
        const s = await fs.stat(path.join(dir, f));
        return `${f}:${s.mtimeMs}`;
      })
    );
    return sigs.join("|");
  } catch {
    return "";
  }
}

async function compileUserQueries(langObj, dir) {
  const out = [];
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith(".scm")).sort();
  } catch {
    return out;
  }
  for (const f of names) {
    try {
      const source = await fs.readFile(path.join(dir, f), "utf8");
      out.push(new Query(langObj, source));
    } catch {}
  }
  return out;
}

async function getLang(name) {
  const spec = LANGUAGES[name];
  let entry = langPool.get(name);
  if (entry) {
    const sig = await userQuerySig(userDefDir(name));
    if (sig !== entry.userSig) {
      const user = await compileUserQueries(entry.langObj, userDefDir(name));
      entry.defQueries = [...(entry.builtin ? [entry.builtin] : []), ...user];
      entry.userSig = sig;
    }
    return entry;
  }
  let langObj;
  const expected = GRAMMAR_HASHES[name];
  if (expected) {
    const buf = await fs.readFile(spec.wasm);
    const actual = createHash("sha256").update(buf).digest("hex");
    if (actual !== expected) {
      throw new ToolError("input", `grammar hash mismatch for ${name}: grammar file tampered or rebuilt; update lib/grammar-hashes.json`);
    }
  }
  try {
    langObj = await Language.load(spec.wasm);
  } catch (e) {
    throw new ToolError("input", `failed to load grammar for ${name}: ${e?.message ?? e}`);
  }
  const parser = new Parser();
  parser.setLanguage(langObj);
  let builtin = null;
  if (spec.definitions) {
    try {
      builtin = new Query(langObj, await fs.readFile(spec.definitions, "utf8"));
    } catch {
      builtin = null;
    }
  }
  const user = await compileUserQueries(langObj, userDefDir(name));
  entry = {
    parser,
    langObj,
    builtin,
    defQueries: [...(builtin ? [builtin] : []), ...user],
    userSig: await userQuerySig(userDefDir(name)),
  };
  langPool.set(name, entry);
  return entry;
}

const treeCache = new Map();
const CACHE_MAX = 20;

const CI_PATHS = process.platform === "darwin";
const normPath = (p) => (CI_PATHS ? p.toLowerCase() : p);
function withinRoot(abs, root) {
  const a = normPath(abs);
  const b = normPath(root);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

async function readSource(file, confine) {
  if (confine) {
    // re-resolve at read time to defeat symlink swaps after server-side validation (TOCTOU)
    const rp = await fs.realpath(file).catch(() => null);
    if (!rp || !withinRoot(rp, confine)) {
      throw new ToolError("input", `path escapes workspace root: ${file}`);
    }
  }
  const fh = await fs.open(file, "r");
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new ToolError("input", `not a regular file: ${file}`);
    if (st.size > MAX_BYTES) {
      throw new ToolError("input", `file too large (${st.size} > ${MAX_BYTES} bytes)`);
    }
    const source = await fh.readFile("utf8");
    return { source, key: `${st.size}:${st.mtimeMs}` };
  } finally {
    await fh.close();
  }
}

async function getTree(file, lang, deadline, confine) {
  checkSoft(deadline);
  const { source, key } = await readSource(file, confine);
  if (source.includes("\0")) throw new ToolError("input", "binary file (NUL byte)");
  checkSoft(deadline);
  const cached = treeCache.get(file);
  if (cached && cached.key === key) {
    return { ...(await getLang(lang)), tree: cached.tree, source: cached.source };
  }
  const { parser, langObj, defQueries } = await getLang(lang);
  const tree = parser.parse(source);
  checkSoft(deadline);
  treeCache.set(file, { key, tree, source, lang, confine: confine ?? null });
  if (treeCache.size > CACHE_MAX) {
    const oldest = treeCache.keys().next().value;
    treeCache.get(oldest).tree.delete();
    treeCache.delete(oldest);
  }
  return { parser, langObj, defQueries, tree, source };
}

function checkSoft(deadline) {
  if (deadline && Date.now() > deadline) {
    throw new ToolError("timeout", "timed out (soft deadline; worker preserved)");
  }
}

const CACHE_SPIN_MS = Number(process.env.TREE_SITTER_MCP_CACHE_SPIN_MS ?? 2000);
let spinTimer = null;
let spinBusy = false;

async function spinOnce() {
  for (const [file, entry] of treeCache) {
    let st;
    try {
      st = await fs.stat(file);
    } catch {
      entry.tree.delete();
      treeCache.delete(file);
      continue;
    }
    const key = `${st.size}:${st.mtimeMs}`;
    if (key === entry.key) continue;
    const lang = entry.lang ?? langForFile(file);
    if (!lang) continue;
    try {
      const { source, key: readKey } = await readSource(file, entry.confine);
      if (source.includes("\0")) {
        entry.tree.delete();
        treeCache.delete(file);
        continue;
      }
      const { parser } = await getLang(lang);
      const tree = parser.parse(source);
      entry.tree.delete();
      treeCache.set(file, { key: readKey, tree, source, lang, confine: entry.confine ?? null });
      if (workspaceIndex && workspaceIndex.files.has(file) && workspaceIndex.files.get(file).key !== readKey) {
        await indexSingleFile(file, readKey);
        recomputeTotals();
        workspaceIndex.version = ++indexVersion;
        await savePersistedIndex();
      }
    } catch {}
  }
}

function ensureCacheSpin() {
  if (spinTimer || !(CACHE_SPIN_MS > 0)) return;
  spinTimer = setInterval(() => {
    if (spinBusy || treeCache.size === 0) return;
    spinBusy = true;
    spinOnce()
      .catch(() => {})
      .finally(() => {
        spinBusy = false;
      });
  }, CACHE_SPIN_MS);
  spinTimer.unref?.();
}

ensureCacheSpin();

function softDeadlineOf(payload) {
  const n = Number(payload?.softDeadlineMs);
  return n > 0 ? Date.now() + n : null;
}

function resolveLang(file, language) {
  if (language) {
    if (!LANGUAGES[language]) {
      throw new ToolError("input", `unknown language "${language}". Supported: ${SUPPORTED.join(", ")}`);
    }
    if (!langForFile(file)) {
      const exts = SUPPORTED.flatMap((l) => LANGUAGES[l].extensions).join(", ");
      throw new ToolError("input", `language override requires a known source extension (${exts})`);
    }
    return language;
  }
  const inferred = langForFile(file);
  if (!inferred) {
    throw new ToolError("input", `unsupported file type. Supported: ${SUPPORTED.join(", ")}`);
  }
  return inferred;
}

const DEF_FALLBACK = /(^|_)(class|function|method|struct|interface|enum|impl|trait|record|namespace|module|fn|func|macro_rules|type)($|_)/;

const WALK_TICKS = 256;

function* walk(root, deadline) {
  const cursor = root.walk();
  let ticks = 0;
  let done = false;
  while (!done) {
    if (deadline && ++ticks % WALK_TICKS === 0) checkSoft(deadline);
    yield cursor.currentNode;
    if (cursor.gotoFirstChild()) continue;
    if (cursor.gotoNextSibling()) continue;
    let up = false;
    while (cursor.gotoParent()) {
      if (cursor.gotoNextSibling()) {
        up = true;
        break;
      }
    }
    done = !up;
  }
  cursor.delete();
}

function defName(node) {
  return (
    node.childForFieldName("name") ??
    node.childForFieldName("declarator")?.childForFieldName("name") ??
    null
  );
}

function defsOf(tree, defQueries, deadline) {
  if (defQueries && defQueries.length) {
    return defQueries.flatMap((q) =>
      q.captures(tree.rootNode).flatMap((c) => {
        const nameNode = defName(c.node);
        if (!nameNode) return [];
        return [{ name: nameNode.text, kind: c.name.replace(/\.def$/, ""), node: c.node }];
      })
    );
  }
  const out = [];
  for (const n of walk(tree.rootNode, deadline)) {
    if (!DEF_FALLBACK.test(n.type)) continue;
    const nameNode = defName(n);
    if (nameNode) out.push({ name: nameNode.text, kind: n.type, node: n });
  }
  return out;
}

function ranges(defs) {
  return defs.map((d) => ({
    name: d.name,
    kind: d.kind,
    start_line: d.node.startPosition.row + 1,
    end_line: d.node.endPosition.row + 1,
  }));
}

const INDEX_EXCLUDES = new Set([
  "node_modules", "target", "dist", "build", "out", "coverage",
  "__pycache__", ".venv", "venv", "vendor", "gradle", ".gradle",
]);
const INDEX_MAX_FILES_DEFAULT = 1500;
const INDEX_MAX_FILES_HARD = 5000;
const INDEX_MAX_DEPTH = 12;
const INDEX_MAX_REFS_PER_FILE = 2000;
const INDEX_MAX_REFS_TOTAL = 300000;
const INDEX_MAX_DEF_RESULTS = 50;

// a path is excluded if any segment is hidden or a known build/dependency dir;
// applied both to the initial walk and to watcher-driven updates
function relExcluded(root, file) {
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return true;
  return rel.split(path.sep).some((seg) => seg.startsWith(".") || INDEX_EXCLUDES.has(seg));
}

// content hash for persisted-cache reuse verification (key is only size:mtime, too coarse
// to catch same-size edits within filesystem timestamp granularity); must read utf8 to
// match how getTree reads sources
async function hashSource(file) {
  try {
    return createHash("sha256").update(await fs.readFile(file, "utf8")).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

// read-op pagination: model-supplied values are clamped, never trusted
const MAX_PAGE_HARD = 200;

function pageOf(payload, defLimit = MAX_MATCHES) {
  const n = Math.trunc(Number(payload?.limit));
  const limit = Math.min(Math.max(1, Number.isFinite(n) && n > 0 ? n : defLimit), MAX_PAGE_HARD);
  const o = Math.trunc(Number(payload?.offset));
  const offset = Number.isFinite(o) && o > 0 ? o : 0;
  return { limit, offset };
}

const CACHE_DIR =
  process.env.TREE_SITTER_MCP_CACHE_DIR ?? path.join(os.homedir(), ".kimi-code", "tree-sitter-plugin-cache");
const WATCH_DEBOUNCE = Number(process.env.TREE_SITTER_MCP_WATCH_DEBOUNCE_MS) || 800;
let indexVersion = 0;
let watchTimer = null;
const watchDirty = new Set();

function cachePathFor(rootAbs) {
  const h = createHash("sha256").update(rootAbs).digest("hex").slice(0, 24);
  return path.join(CACHE_DIR, h + ".json");
}

function sanitizeCachedDefs(v) {
  if (!Array.isArray(v) || v.length > 2000) return null;
  const out = [];
  for (const d of v) {
    if (!d || typeof d.name !== "string" || !d.name || d.name.length > 200) return null;
    if (typeof d.kind !== "string" || d.kind.length > 60) return null;
    if (!Number.isInteger(d.start_line) || d.start_line < 1 || d.start_line > 1e7) return null;
    if (!Number.isInteger(d.end_line) || d.end_line < d.start_line || d.end_line > 1e7) return null;
    out.push({ name: d.name, kind: d.kind, start_line: d.start_line, end_line: d.end_line });
  }
  return out;
}

function sanitizeCachedRefs(v) {
  if (!Array.isArray(v) || v.length > INDEX_MAX_REFS_PER_FILE) return null;
  const out = [];
  for (const r of v) {
    if (!r || typeof r.name !== "string" || !r.name || r.name.length > 100) return null;
    if (!Number.isInteger(r.line) || r.line < 1 || r.line > 1e7) return null;
    out.push({ name: r.name, line: r.line });
  }
  return out;
}

function sanitizeCachedCalls(v) {
  if (!Array.isArray(v) || v.length > 5000) return null;
  const out = [];
  for (const c of v) {
    if (!c) return null;
    if (c.caller !== null && (typeof c.caller !== "string" || c.caller.length > 200)) return null;
    if (typeof c.callee !== "string" || !c.callee || c.callee.length > 200) return null;
    if (!Number.isInteger(c.line) || c.line < 1 || c.line > 1e7) return null;
    out.push({ caller: c.caller, callee: c.callee, line: c.line });
  }
  return out;
}

// persisted cache is untrusted input: drop any entry whose shape is off instead of trusting it
function sanitizeCachedFile(e) {
  if (!e || typeof e !== "object") return null;
  if (!LANGUAGES[e.lang]) return null;
  if (typeof e.key !== "string" || !e.key || e.key.length > 64) return null;
  if (e.hash !== undefined && e.hash !== null && (typeof e.hash !== "string" || !/^[0-9a-f]{8,64}$/.test(e.hash))) return null;
  const defs = sanitizeCachedDefs(e.defs);
  const refs = sanitizeCachedRefs(e.refs);
  const calls = sanitizeCachedCalls(e.calls);
  if (!defs || !refs || !calls) return null;
  return { lang: e.lang, key: e.key, defs, refs, calls, hash: e.hash ?? null };
}

async function loadPersistedIndex(rootAbs) {
  try {
    const data = JSON.parse(await fs.readFile(cachePathFor(rootAbs), "utf8"));
    if (data && data.root === rootAbs && data.files && typeof data.files === "object") return data;
  } catch {}
  return null;
}

async function savePersistedIndex() {
  if (!workspaceIndex) return;
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const files = {};
    for (const [f, e] of workspaceIndex.files) {
      files[f] = { lang: e.lang, key: e.key, defs: e.defs, refs: e.refs, calls: e.calls ?? [], ...(e.hash ? { hash: e.hash } : {}) };
    }
    const payload = {
      root: workspaceIndex.root,
      builtAt: workspaceIndex.builtAt,
      version: workspaceIndex.version,
      files,
    };
    await fs.writeFile(cachePathFor(workspaceIndex.root), JSON.stringify(payload));
  } catch {}
}

function recomputeTotals() {
  let symbols = 0;
  let refs = 0;
  for (const e of workspaceIndex.files.values()) {
    symbols += e.defs.length;
    refs += e.refs.length;
  }
  workspaceIndex.totals = { files: workspaceIndex.files.size, symbols, refs };
}

async function indexSingleFile(f, knownKey) {
  const lang = langForFile(f);
  if (!lang) return false;
  let st;
  try {
    st = await fs.stat(f);
  } catch {
    return false;
  }
  const key = knownKey ?? `${st.size}:${st.mtimeMs}`;
  try {
    const entry = await getLang(lang);
    const { tree, source } = await getTree(f, lang, null, workspaceIndex?.root ?? null);
    const defs = defsOf(tree, entry.defQueries).map((d) => ({
      name: d.name,
      kind: d.kind,
      start_line: d.node.startPosition.row + 1,
      end_line: d.node.endPosition.row + 1,
    }));
    const rs = refsOf(tree);
    const calls = callsOf(tree, lang);
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 32);
    workspaceIndex.files.set(f, { lang, key, defs, refs: rs, calls, hash });
    return true;
  } catch {
    return false;
  }
}

function startWatcher(rootAbs) {
  try {
    return fsWatch(
      rootAbs,
      { recursive: true },
      (_event, filename) => {
        try {
          if (!filename) return;
          const p = path.resolve(rootAbs, filename.toString());
          if (!langForFile(p)) return;
          if (relExcluded(rootAbs, p)) return;
          watchDirty.add(p);
          if (watchTimer) clearTimeout(watchTimer);
          watchTimer = setTimeout(() => {
            watchTimer = null;
            flushDirty().catch(() => {});
          }, WATCH_DEBOUNCE);
        } catch {}
      }
    );
  } catch {
    return null;
  }
}

async function flushDirty() {
  if (!workspaceIndex) return;
  const paths = [...watchDirty];
  watchDirty.clear();
  let changed = 0;
  const rootPrefix = workspaceIndex.root.endsWith(path.sep) ? workspaceIndex.root : workspaceIndex.root + path.sep;
  for (const f of paths) {
    if (!workspaceIndex.files.has(f)) {
      if (f.startsWith(rootPrefix) && !relExcluded(workspaceIndex.root, f)) {
        try {
          const st = await fs.stat(f);
          if (st.isFile() && st.size <= MAX_BYTES && (await indexSingleFile(f))) changed++;
        } catch {}
      }
      continue;
    }
    let st;
    try {
      st = await fs.stat(f);
    } catch {
      workspaceIndex.files.delete(f);
      changed++;
      continue;
    }
    const key = `${st.size}:${st.mtimeMs}`;
    if (workspaceIndex.files.get(f).key === key) continue;
    if (await indexSingleFile(f, key)) changed++;
  }
  if (changed) {
    recomputeTotals();
    workspaceIndex.version = ++indexVersion;
    workspaceIndex.builtAt = Date.now();
    await savePersistedIndex();
  }
}

let workspaceIndex = null;

async function walkSourceFiles(root, limit, out, depth, deadline) {
  checkSoft(deadline);
  if (out.length >= limit || depth > INDEX_MAX_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= limit) return;
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (INDEX_EXCLUDES.has(e.name) || e.name.startsWith(".")) continue;
      await walkSourceFiles(p, limit, out, depth + 1, deadline);
    } else if (e.isFile() && langForFile(e.name)) {
      try {
        const st = await fs.stat(p);
        if (st.size <= MAX_BYTES) out.push(p);
      } catch {}
    }
  }
}

function refsOf(tree, deadline) {
  const out = [];
  for (const n of walk(tree.rootNode, deadline)) {
    if (!n.isNamed || !/identifier$/.test(n.type)) continue;
    const text = n.text;
    if (!text || text.length > 100 || /^\d/.test(text)) continue;
    out.push({ name: text, line: n.startPosition.row + 1 });
    if (out.length >= INDEX_MAX_REFS_PER_FILE) break;
  }
  return out;
}

async function allPresets(lang) {
  const list = (PATTERNS[lang] ?? []).map((p) => ({ ...p, source: "builtin" }));
  const dir = path.join(USER_QUERY_ROOT, "presets", lang);
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith(".scm")).sort();
  } catch {}
  for (const f of names) {
    try {
      const source = await fs.readFile(path.join(dir, f), "utf8");
      const first = (source.split("\n")[0] ?? "").trim();
      list.push({
        name: f.replace(/\.scm$/, ""),
        description: first.startsWith(";;") ? first.slice(2).trim() : "",
        query: source,
        source: "user",
      });
    } catch {}
  }
  return list;
}

async function runPresetQuery(file, lang, preset, deadline, confine) {
  const { tree, langObj } = await getTree(file, lang, deadline, confine);
  checkSoft(deadline);
  let q;
  try {
    q = new Query(langObj, preset.query);
  } catch (e) {
    throw new ToolError("query_syntax", `invalid preset "${preset.name}": ${String(e?.message ?? e).split("\n")[0]}`);
  }
  let caps;
  try {
    caps = q.captures(tree.rootNode);
  } catch (e) {
    q.delete();
    throw new ToolError("query_syntax", `preset query failed: ${String(e?.message ?? e).split("\n")[0]}`);
  }
  q.delete();
  const total = caps.length;
  const results = caps.slice(0, MAX_MATCHES).map((c) => ({
    capture: c.name,
    line: c.node.startPosition.row + 1,
    text: clip(c.node.text.replace(/\s+/g, " ").trim(), MAX_SNIPPET),
  }));
  return { total, results };
}

const OPS = {
  async list_definitions({ file, language, softDeadlineMs, confineRoot }) {
    const lang = resolveLang(file, language);
    const deadline = softDeadlineOf({ softDeadlineMs });
    const { tree, defQueries } = await getTree(file, lang, deadline, confineRoot);
    checkSoft(deadline);
    let defs = defsOf(tree, defQueries, deadline);
    const truncated = defs.length > MAX_DEFS;
    defs = defs.slice(0, MAX_DEFS);
    return {
      lang,
      count: defs.length,
      truncated,
      defs: ranges(defs),
      ...(truncated ? { hint: "file has many definitions; use read_definition or ast_search to narrow" } : {}),
    };
  },

  async read_definition({ file, name, language, maxLines, softDeadlineMs, confineRoot }) {
    const lang = resolveLang(file, language);
    const deadline = softDeadlineOf({ softDeadlineMs });
    const { tree, source, defQueries } = await getTree(file, lang, deadline, confineRoot);
    checkSoft(deadline);
    const hits = defsOf(tree, defQueries, deadline).filter((d) => d.name === name);
    if (!hits.length) {
      throw new ToolError("not_found", `definition "${name}" not found`);
    }
    const maxL = Math.min(Math.max(1, Math.trunc(Number(maxLines)) || 200), 1000);
    return {
      lang,
      count: hits.length,
      defs: hits.map((d) => {
        const code = source.slice(d.node.startIndex, d.node.endIndex);
        const lines = code.split("\n");
        const lineTruncated = lines.length > maxL;
        const shown = lineTruncated ? lines.slice(0, maxL).join("\n") + "\n…" : code;
        return {
          name: d.name,
          kind: d.kind,
          start_line: d.node.startPosition.row + 1,
          end_line: d.node.endPosition.row + 1,
          total_lines: lines.length,
          truncated: code.length > MAX_CODE || lineTruncated,
          code: clip(shown, MAX_CODE),
        };
      }),
    };
  },

  async ast_search({ file, pattern, language, limit, offset, softDeadlineMs, confineRoot }) {
    const lang = resolveLang(file, language);
    const deadline = softDeadlineOf({ softDeadlineMs });
    const { tree, langObj } = await getTree(file, lang, deadline, confineRoot);
    checkSoft(deadline);
    let q;
    try {
      q = new Query(langObj, pattern);
    } catch (e) {
      throw new ToolError("query_syntax", `invalid query: ${String(e?.message ?? e).split("\n")[0]}`);
    }
    let caps;
    let patternMatches;
    try {
      caps = q.captures(tree.rootNode);
      patternMatches = q.matches(tree.rootNode).length;
    } catch (e) {
      q.delete();
      throw new ToolError("query_syntax", `query failed: ${String(e?.message ?? e)}`);
    }
    const total = caps.length;
    checkSoft(deadline);
    const page = pageOf({ limit, offset });
    const truncated = total > page.offset + page.limit;
    const results = caps.slice(page.offset, page.offset + page.limit).map((c) => ({
      capture: c.name,
      line: c.node.startPosition.row + 1,
      text: clip(c.node.text.replace(/\s+/g, " ").trim(), MAX_SNIPPET),
    }));
    q.delete();
    return {
      lang,
      pattern_matches: patternMatches,
      captures: total,
      returned: results.length,
      offset: page.offset,
      truncated,
      results,
      ...(truncated ? { hint: "pattern too broad; add a child constraint to narrow it, or page with offset" } : {}),
    };
  },

  async index_workspace({ root, maxFiles, softDeadlineMs }) {
    if (typeof root !== "string" || !root) {
      throw new ToolError("input", "root (directory path) is required");
    }
    const deadline = softDeadlineOf({ softDeadlineMs });
    const rootAbs = path.resolve(root);
    const st = await fs.stat(rootAbs).catch(() => null);
    if (!st || !st.isDirectory()) {
      throw new ToolError("input", `not a directory: ${root}`);
    }
    const limit = Math.min(
      Number(maxFiles) > 0 ? Number(maxFiles) : INDEX_MAX_FILES_DEFAULT,
      INDEX_MAX_FILES_HARD
    );
    const files = [];
    await walkSourceFiles(rootAbs, limit + 1, files, 0, deadline);
    const filesTruncated = files.length > limit;
    if (filesTruncated) files.length = limit;
    const persisted = await loadPersistedIndex(rootAbs);
    const sameRoot = workspaceIndex && workspaceIndex.root === rootAbs ? workspaceIndex : null;
    const map = sameRoot ? sameRoot.files : new Map();
    let reused = 0;
    let parsed = 0;
    let refsTruncated = false;
    for (const f of files) {
      checkSoft(deadline);
      const lang = langForFile(f);
      if (!lang) continue;
      let fst;
      try {
        fst = await fs.stat(f);
      } catch {
        continue;
      }
      const key = `${fst.size}:${fst.mtimeMs}`;
      const existing = map.get(f);
      if (existing && existing.key === key) {
        reused++;
        continue;
      }
      const cached = persisted ? sanitizeCachedFile(persisted.files[f]) : null;
      if (cached && cached.lang === lang && cached.key === key) {
        // stat key (size:mtime) is too coarse to catch same-size edits within timestamp
        // granularity — verify content hash before trusting a persisted entry
        if (cached.hash && cached.hash === (await hashSource(f))) {
          map.set(f, { lang, key, defs: cached.defs, refs: cached.refs, calls: cached.calls, hash: cached.hash });
          reused++;
          continue;
        }
      }
      try {
        const entry = await getLang(lang);
        const { tree, source } = await getTree(f, lang, deadline, rootAbs);
        const defs = defsOf(tree, entry.defQueries, deadline).map((d) => ({
          name: d.name,
          kind: d.kind,
          start_line: d.node.startPosition.row + 1,
          end_line: d.node.endPosition.row + 1,
        }));
        let rs = refsOf(tree, deadline);
        if (rs.length > INDEX_MAX_REFS_PER_FILE) {
          rs = rs.slice(0, INDEX_MAX_REFS_PER_FILE);
          refsTruncated = true;
        }
        const hash = createHash("sha256").update(source).digest("hex").slice(0, 32);
        map.set(f, { lang, key, defs, refs: rs, calls: callsOf(tree, lang), hash });
        parsed++;
      } catch {}
    }
    const keep = new Set(files);
    for (const k of [...map.keys()]) {
      if (!keep.has(k)) map.delete(k);
    }
    if (workspaceIndex && workspaceIndex.watcher && !sameRoot) {
      try {
        workspaceIndex.watcher.close();
      } catch {}
    }
    workspaceIndex = {
      root: rootAbs,
      builtAt: Date.now(),
      version: ++indexVersion,
      files: map,
      watcher: sameRoot ? sameRoot.watcher : startWatcher(rootAbs),
      totals: { files: map.size, symbols: 0, refs: 0 },
    };
    recomputeTotals();
    if (workspaceIndex.totals.refs > INDEX_MAX_REFS_TOTAL) refsTruncated = true;
    await savePersistedIndex();
    return {
      root: workspaceIndex.root,
      indexed: map.size,
      discovered: files.length,
      files_truncated: filesTruncated,
      reused,
      parsed,
      symbols: workspaceIndex.totals.symbols,
      refs: workspaceIndex.totals.refs,
      refs_truncated: refsTruncated,
      index_version: workspaceIndex.version,
      persisted: !!persisted,
      watching: !!workspaceIndex.watcher,
      built_at: workspaceIndex.builtAt,
      ...(filesTruncated ? { hint: "maxFiles cap reached; pass a larger maxFiles (hard cap 5000) or narrow the root" } : {}),
    };
  },

  async prewarm({ lang }) {
    if (lang && LANGUAGES[lang]) await getLang(lang);
    return { prewarmed: lang ?? null };
  },

  async index_status() {
    if (!workspaceIndex) {
      throw new ToolError("not_found", "no index; run index_workspace first");
    }
    return {
      root: workspaceIndex.root,
      index_version: workspaceIndex.version,
      built_at: workspaceIndex.builtAt,
      ...workspaceIndex.totals,
      watching: !!workspaceIndex.watcher,
      dirty: watchDirty.size,
    };
  },

  async find_references({ name, limit, offset }) {
    if (!workspaceIndex) {
      throw new ToolError("not_found", "no index; run index_workspace first");
    }
    if (typeof name !== "string" || !name) {
      throw new ToolError("input", "name is required");
    }
    const page = pageOf({ limit, offset });
    const all = [];
    for (const [file, data] of workspaceIndex.files) {
      const defLines = new Set(data.defs.filter((d) => d.name === name).map((d) => d.start_line));
      for (const r of data.refs) {
        if (r.name !== name) continue;
        all.push({ file, line: r.line, kind: defLines.has(r.line) ? "definition" : "reference" });
      }
    }
    all.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
    const results = all.slice(page.offset, page.offset + page.limit);
    return {
      name,
      total: all.length,
      returned: results.length,
      offset: page.offset,
      truncated: page.offset + results.length < all.length,
      results,
      index_root: workspaceIndex.root,
      index_version: workspaceIndex.version,
      index_built_at: workspaceIndex.builtAt,
    };
  },

  async go_to_definition({ name, file, limit, offset }) {
    if (!workspaceIndex) {
      throw new ToolError("not_found", "no index; run index_workspace first");
    }
    if (typeof name !== "string" || !name) {
      throw new ToolError("input", "name is required");
    }
    const page = pageOf({ limit, offset }, INDEX_MAX_DEF_RESULTS);
    const all = [];
    for (const [f, data] of workspaceIndex.files) {
      for (const d of data.defs) {
        if (d.name === name) all.push({ file: f, ...d });
      }
    }
    if (!all.length) {
      throw new ToolError("not_found", `definition "${name}" not found in index`);
    }
    if (file) {
      const dirOf = (p) => path.dirname(p);
      all.sort((a, b) => {
        if (a.file === file) return -1;
        if (b.file === file) return 1;
        const da = dirOf(a.file) === dirOf(file) ? 0 : 1;
        const db = dirOf(b.file) === dirOf(file) ? 0 : 1;
        if (da !== db) return da - db;
        return a.file < b.file ? -1 : 1;
      });
    }
    const defs = all.slice(page.offset, page.offset + page.limit);
    return {
      name,
      count: all.length,
      returned: defs.length,
      offset: page.offset,
      truncated: page.offset + defs.length < all.length,
      index_root: workspaceIndex.root,
      index_version: workspaceIndex.version,
      index_built_at: workspaceIndex.builtAt,
      defs,
    };
  },

  async list_presets({ language }) {
    const langs = language ? [language] : SUPPORTED;
    const presets = [];
    for (const l of langs) {
      if (!LANGUAGES[l]) {
        throw new ToolError("input", `unknown language "${l}". Supported: ${SUPPORTED.join(", ")}`);
      }
      for (const p of await allPresets(l)) {
        presets.push({ name: p.name, language: l, description: p.description, source: p.source });
      }
    }
    return { count: presets.length, presets };
  },

  async preset_search({ file, name, language, softDeadlineMs, confineRoot }) {
    const lang = resolveLang(file, language);
    const preset = (await allPresets(lang)).find((p) => p.name === name);
    if (!preset) {
      throw new ToolError("not_found", `preset "${name}" not found for ${lang}; run list_presets`);
    }
    const deadline = softDeadlineOf({ softDeadlineMs });
    const { total, results } = await runPresetQuery(file, lang, preset, deadline, confineRoot);
    const truncated = total > MAX_MATCHES;
    return {
      lang,
      preset: preset.name,
      description: preset.description,
      source: preset.source,
      captures: total,
      returned: results.length,
      truncated,
      results,
    };
  },

  async get_node_types({ file, language }) {
    let lang;
    if (language) {
      if (!LANGUAGES[language]) {
        throw new ToolError("input", `unknown language "${language}". Supported: ${SUPPORTED.join(", ")}`);
      }
      lang = language;
    } else if (file) {
      lang = resolveLang(file, undefined);
    } else {
      throw new ToolError("input", "language or file is required");
    }
    const { langObj } = await getLang(lang);
    const count = langObj.nodeTypeCount;
    const named_types = [];
    const anonymous_tokens = [];
    for (let id = 0; id < count; id++) {
      if (!langObj.nodeTypeIsVisible(id)) continue;
      const t = langObj.nodeTypeForId(id);
      if (langObj.nodeTypeIsNamed(id)) named_types.push(t);
      else anonymous_tokens.push(t);
    }
    const fields = [];
    for (let id = 0; id < langObj.fieldCount; id++) {
      fields.push(langObj.fieldNameForId(id));
    }
    return {
      lang,
      node_type_count: count,
      named_types,
      anonymous_tokens,
      fields,
    };
  },

  async analyze_complexity({ file, language, softDeadlineMs, confineRoot }) {
    const lang = resolveLang(file, language);
    const spec = COMPLEXITY_SPEC[lang];
    if (!spec) {
      throw new ToolError("input", `no complexity rules for ${lang}`);
    }
    const deadline = softDeadlineOf({ softDeadlineMs });
    const { tree } = await getTree(file, lang, deadline, confineRoot);
    checkSoft(deadline);
    const functions = [];
    for (const n of walk(tree.rootNode, deadline)) {
      if (!spec.functions.includes(n.type)) continue;
      functions.push({
        name: n.childForFieldName("name")?.text ?? "(anonymous)",
        start_line: n.startPosition.row + 1,
        end_line: n.endPosition.row + 1,
        complexity: 1 + countDecisions(n, spec),
      });
    }
    functions.sort((a, b) => b.complexity - a.complexity);
    const total = functions.reduce((s, f) => s + f.complexity, 0);
    const hotspot = functions.find((f) => f.complexity > 10);
    return {
      lang,
      functions: functions.slice(0, 100),
      count: functions.length,
      average: functions.length ? Math.round((total / functions.length) * 10) / 10 : 0,
      worst: functions[0] ?? null,
      ...(hotspot ? { hint: `${hotspot.name} has complexity ${hotspot.complexity}; consider refactoring (threshold 10)` } : {}),
    };
  },

  async callers({ name, limit, offset }) {
    if (!workspaceIndex) {
      throw new ToolError("not_found", "no index; run index_workspace first");
    }
    if (typeof name !== "string" || !name) {
      throw new ToolError("input", "name is required");
    }
    const page = pageOf({ limit, offset });
    const all = [];
    for (const [file, data] of workspaceIndex.files) {
      for (const c of data.calls ?? []) {
        if (c.callee !== name) continue;
        all.push({ file, line: c.line, caller: c.caller ?? "(top-level)" });
      }
    }
    all.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
    const results = all.slice(page.offset, page.offset + page.limit);
    return {
      name,
      total: all.length,
      returned: results.length,
      offset: page.offset,
      truncated: page.offset + results.length < all.length,
      results,
      index_root: workspaceIndex.root,
      index_version: workspaceIndex.version,
      index_built_at: workspaceIndex.builtAt,
    };
  },

  async callees({ name, limit, offset }) {
    if (!workspaceIndex) {
      throw new ToolError("not_found", "no index; run index_workspace first");
    }
    if (typeof name !== "string" || !name) {
      throw new ToolError("input", "name is required");
    }
    const page = pageOf({ limit, offset });
    const all = [];
    for (const [file, data] of workspaceIndex.files) {
      for (const c of data.calls ?? []) {
        if (c.caller !== name) continue;
        all.push({ file, line: c.line, callee: c.callee });
      }
    }
    all.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
    const results = all.slice(page.offset, page.offset + page.limit);
    return {
      name,
      total: all.length,
      returned: results.length,
      offset: page.offset,
      truncated: page.offset + results.length < all.length,
      results,
      index_root: workspaceIndex.root,
      index_version: workspaceIndex.version,
      index_built_at: workspaceIndex.builtAt,
    };
  },
};

parentPort.on("message", async (msg) => {
  const { id, op, payload } = msg ?? {};
  const handler = typeof op === "string" && Object.hasOwn(OPS, op) ? OPS[op] : null;
  if (typeof handler !== "function" || typeof id === "undefined") {
    parentPort.postMessage({
      id: typeof id === "undefined" ? -1 : id,
      ok: false,
      errorKind: "input",
      error: "unknown op",
    });
    return;
  }
  try {
    const data = await handler(payload);
    parentPort.postMessage({ id, ok: true, data });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, errorKind: e.kind ?? "internal", error: String(e?.message ?? e) });
  }
});
