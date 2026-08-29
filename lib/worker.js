import { Worker, parentPort, workerData } from "node:worker_threads";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { Parser, Language, Query } from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import { LANGUAGES, langForFile, SUPPORTED } from "./languages.js";
import { MAX_BYTES, MAX_DEFS, MAX_MATCHES, MAX_SNIPPET, MAX_CODE, clip } from "./trim.js";
import { PATTERNS } from "./patterns.js";
import { COMPLEXITY_SPEC, CALL_SPEC, countDecisions, callsOf } from "./analysis.js";
import { importsAndPackageOf, vartypesOf, qualnameOf, basesOf, retOf } from "./extract.js";
import { buildResolver, classifyRef, classifyByImport } from "./resolve.js";
import { openStore, openJsonStore } from "./store.js";
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
      if (workspaceIndex && workspaceIndex.store.has(file) && workspaceIndex.store.keyOf(file) !== readKey) {
        if (await indexSingleFile(file, readKey)) await commitDirtyChange();
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
const INDEX_PRIORITY_DIRS = new Set([
  "src", "app", "lib", "pkg", "packages", "services", "main", "source", "java", "python",
]);
const JSON_MAX_FILES_DEFAULT = 1500;
const JSON_MAX_FILES_HARD = 5000;
const SQLITE_MAX_FILES_DEFAULT =
  Number(process.env.TREE_SITTER_MCP_MAX_FILES) > 0 ? Number(process.env.TREE_SITTER_MCP_MAX_FILES) : 20000;
const SQLITE_MAX_FILES_HARD = 100000;
const INDEX_MAX_DEPTH = 40;
const INDEX_MAX_REFS_PER_FILE = 2000;
const INDEX_MAX_REFS_TOTAL = 300000;
const INDEX_MAX_DEF_RESULTS = 50;

function capsFor(storeKind) {
  return storeKind === "sqlite"
    ? { def: SQLITE_MAX_FILES_DEFAULT, hard: SQLITE_MAX_FILES_HARD }
    : { def: JSON_MAX_FILES_DEFAULT, hard: JSON_MAX_FILES_HARD };
}

function relExcluded(root, file) {
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return true;
  return rel.split(path.sep).some((seg) => seg.startsWith(".") || INDEX_EXCLUDES.has(seg));
}

async function hashSource(file) {
  try {
    return createHash("sha256").update(await fs.readFile(file, "utf8")).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

const MAX_PAGE_HARD = 200;

function pageOf(payload, defLimit = MAX_MATCHES) {
  const n = Math.trunc(Number(payload?.limit));
  const limit = Math.min(Math.max(1, Number.isFinite(n) && n > 0 ? n : defLimit), MAX_PAGE_HARD);
  const o = Math.trunc(Number(payload?.offset));
  const offset = Number.isFinite(o) && o > 0 ? o : 0;
  return { limit, offset };
}

function definedFilesOf(name) {
  if (!workspaceIndex || typeof name !== "string" || !name) return [];
  return workspaceIndex.store.filesDefining(name);
}

function summarizeUnsupported(skipped) {
  const entries = [...skipped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const count = entries.reduce((s, [, n]) => s + n, 0);
  return {
    count,
    extensions: Object.fromEntries(entries),
    extensions_summary: entries.map(([e, n]) => `${e}=${n}`).join(", "),
  };
}

function unsupportedNote() {
  if (!workspaceIndex || !workspaceIndex.unsupported || workspaceIndex.unsupported.count === 0) return {};
  return { unsupported_skipped: workspaceIndex.unsupported };
}

const CACHE_DIR =
  process.env.TREE_SITTER_MCP_CACHE_DIR ?? path.join(os.homedir(), ".kimi-code", "tree-sitter-plugin-cache");
const WATCH_DEBOUNCE = Number(process.env.TREE_SITTER_MCP_WATCH_DEBOUNCE_MS) || 300;
const WATCH_MAX_WAIT = WATCH_DEBOUNCE * 5;
const FRESHEN_BUDGET_MS =
  Number(process.env.TREE_SITTER_MCP_FRESHEN_BUDGET_MS) > 0
    ? Number(process.env.TREE_SITTER_MCP_FRESHEN_BUDGET_MS)
    : 2000;
let indexVersion = 0;
let watchTimer = null;
let watchFirstEventAt = 0;
const watchDirty = new Set();
const WALK_STAT_CONCURRENCY = 64;
const SHARD_MIN_FILES = 500;
const SHARD_BATCH = 64;
const SHARD_TIMEOUT_MS = 120000;

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
    const bases = Array.isArray(d.bases)
      ? d.bases.filter((b) => typeof b === "string" && b.length > 0 && b.length <= 100).slice(0, 10)
      : [];
    out.push({
      name: d.name,
      kind: d.kind,
      start_line: d.start_line,
      end_line: d.end_line,
      ...(typeof d.qualname === "string" && d.qualname && d.qualname.length <= 300 ? { qualname: d.qualname } : {}),
      ...(bases.length ? { bases } : {}),
      ...(typeof d.ret === "string" && d.ret && d.ret.length <= 100 ? { ret: d.ret } : {}),
    });
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
    if (c.recv !== undefined && c.recv !== null && (typeof c.recv !== "string" || c.recv.length > 100)) return null;
    out.push({ caller: c.caller, callee: c.callee, line: c.line, ...(c.recv ? { recv: c.recv } : {}) });
  }
  return out;
}

function sanitizeImports(v) {
  if (!Array.isArray(v) || v.length > 200) return null;
  const out = [];
  for (const imp of v) {
    if (!imp || typeof imp !== "object") return null;
    if (imp.src !== null && imp.src !== undefined && (typeof imp.src !== "string" || imp.src.length > 300)) return null;
    const names = Array.isArray(imp.names)
      ? imp.names.filter((n) => typeof n === "string" && n.length > 0 && n.length <= 100).slice(0, 100)
      : [];
    out.push({
      src: imp.src ?? null,
      ...(typeof imp.fqn === "string" && imp.fqn.length > 0 && imp.fqn.length <= 300 ? { fqn: imp.fqn } : {}),
      ...(imp.static === true ? { static: true } : {}),
      ...(imp.wildcard === true ? { wildcard: true } : {}),
      names,
    });
  }
  return out;
}

function sanitizeVartypes(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  let n = 0;
  for (const [k, t] of Object.entries(v)) {
    if (n >= 300) break;
    if (typeof k !== "string" || !k || k.length > 100) continue;
    if (typeof t !== "string" || !t || t.length > 200) continue;
    out[k] = t;
    n++;
  }
  return out;
}

function sanitizeCachedFile(e) {
  if (!e || typeof e !== "object") return null;
  if (!LANGUAGES[e.lang]) return null;
  if (typeof e.key !== "string" || !e.key || e.key.length > 64) return null;
  if (e.hash !== undefined && e.hash !== null && (typeof e.hash !== "string" || !/^[0-9a-f]{8,64}$/.test(e.hash))) return null;
  const defs = sanitizeCachedDefs(e.defs);
  const refs = sanitizeCachedRefs(e.refs);
  const calls = sanitizeCachedCalls(e.calls);
  const imports = sanitizeImports(e.imports ?? []);
  const vartypes = sanitizeVartypes(e.vartypes ?? {});
  if (!defs || !refs || !calls || !imports || !vartypes) return null;
  return {
    lang: e.lang,
    key: e.key,
    defs,
    refs,
    calls,
    hash: e.hash ?? null,
    pkg: typeof e.pkg === "string" && e.pkg && e.pkg.length <= 200 ? e.pkg : null,
    imports,
    vartypes,
  };
}

async function loadPersistedIndex(rootAbs) {
  try {
    const data = JSON.parse(await fs.readFile(cachePathFor(rootAbs), "utf8"));
    if (data && data.root === rootAbs && data.files && typeof data.files === "object") return data;
  } catch {}
  return null;
}

function legacyEntriesOf(rootAbs) {
  const data = loadPersistedIndex(rootAbs);
  if (!data) return null;
  const out = {};
  for (const [f, e] of Object.entries(data.files)) {
    const sanitized = sanitizeCachedFile(e);
    if (sanitized) out[f] = sanitized;
  }
  return Object.keys(out).length ? out : null;
}

async function savePersistedIndex() {
  if (!workspaceIndex) return;
  try {
    await workspaceIndex.store.flush(workspaceIndex.root, workspaceIndex.builtAt, workspaceIndex.version);
  } catch {}
}

function recomputeTotals() {
  workspaceIndex.totals = workspaceIndex.store.totals();
}

async function indexSingleFile(f, knownKey, targetStore) {
  const store = targetStore ?? workspaceIndex?.store ?? null;
  if (!store) return false;
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
    const defs = defsOf(tree, entry.defQueries).map((d) => {
      const bases = basesOf(d.node, lang);
      const ret = retOf(d.node, lang);
      return {
        name: d.name,
        kind: d.kind,
        qualname: qualnameOf(d.node, lang),
        start_line: d.node.startPosition.row + 1,
        end_line: d.node.endPosition.row + 1,
        ...(bases.length ? { bases } : {}),
        ...(ret ? { ret } : {}),
      };
    });
    const rs = refsOf(tree);
    const calls = callsOf(tree, lang);
    const { pkg, imports } = importsAndPackageOf(tree, lang);
    const vartypes = vartypesOf(tree, lang);
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 32);
    store.putFile(f, { lang, key, defs, refs: rs, calls, hash, pkg, imports, vartypes });
    return true;
  } catch {
    return false;
  }
}

async function buildFileEntry(f, lang, key, deadline, rootAbs) {
  const entry = await getLang(lang);
  const { tree, source } = await getTree(f, lang, deadline, rootAbs);
  const defs = defsOf(tree, entry.defQueries, deadline).map((d) => {
    const bases = basesOf(d.node, lang);
    const ret = retOf(d.node, lang);
    return {
      name: d.name,
      kind: d.kind,
      qualname: qualnameOf(d.node, lang),
      start_line: d.node.startPosition.row + 1,
      end_line: d.node.endPosition.row + 1,
      ...(bases.length ? { bases } : {}),
      ...(ret ? { ret } : {}),
    };
  });
  let rs = refsOf(tree, deadline);
  let truncated = false;
  if (rs.length > INDEX_MAX_REFS_PER_FILE) {
    rs = rs.slice(0, INDEX_MAX_REFS_PER_FILE);
    truncated = true;
  }
  const { pkg, imports } = importsAndPackageOf(tree, lang);
  const vartypes = vartypesOf(tree, lang);
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 32);
  return {
    entry: { lang, key, defs, refs: rs, calls: callsOf(tree, lang), hash, pkg, imports, vartypes },
    truncated,
  };
}

function runShards(todo, rootAbs, onResult) {
  return new Promise((resolveAll) => {
    const batches = [];
    for (let i = 0; i < todo.length; i += SHARD_BATCH) batches.push(todo.slice(i, i + SHARD_BATCH));
    const K = Math.max(2, Math.min(4, (os.cpus()?.length ?? 1) - 1));
    const done = new Set();
    const workers = new Set();
    let nextIdx = 0;
    let alive = true;
    const finish = () => {
      alive = false;
      for (const sh of workers) {
        try {
          sh.w.terminate();
        } catch {}
      }
      resolveAll(done);
    };
    const spawn = () => {
      const w = new Worker(new URL(import.meta.url), { workerData: { shard: true, root: rootAbs } });
      const sh = { w, seq: 0, pending: new Map(), inflight: 0, dead: false };
      w.on("message", (msg) => {
        const p = sh.pending.get(msg?.id);
        if (!p) return;
        sh.pending.delete(msg.id);
        sh.inflight--;
        for (const r of msg?.results ?? []) {
          done.add(r.f);
          onResult(r.f, r.entry, r.truncated);
        }
        p();
      });
      const fail = () => {
        if (sh.dead) return;
        sh.dead = true;
        for (const [, p] of sh.pending) p();
        sh.pending.clear();
      };
      w.on("error", fail);
      w.on("exit", fail);
      workers.add(sh);
      return sh;
    };
    const send = (sh, batch) =>
      new Promise((resolve) => {
        const id = ++sh.seq;
        sh.pending.set(id, resolve);
        try {
          sh.w.postMessage({ id, batch });
        } catch {
          sh.pending.delete(id);
          resolve();
        }
      });
    const pull = (sh) => {
      while (alive && !sh.dead && sh.inflight < 2 && nextIdx < batches.length) {
        const batch = batches[nextIdx++];
        sh.inflight++;
        send(sh, batch).then(() => pull(sh));
      }
    };
    let shards;
    try {
      shards = Array.from({ length: K }, spawn);
    } catch {
      finish();
      return;
    }
    for (const sh of shards) pull(sh);
    const t0 = Date.now();
    const iv = setInterval(() => {
      const anyAlive = [...workers.values()];
      const allDead = anyAlive.every((sh) => sh.dead);
      const drained = nextIdx >= batches.length && anyAlive.every((sh) => sh.dead || sh.inflight === 0);
      if (drained || allDead || !alive || Date.now() - t0 > SHARD_TIMEOUT_MS) {
        clearInterval(iv);
        finish();
      }
    }, 20);
  });
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
          if (!watchFirstEventAt) watchFirstEventAt = Date.now();
          const waited = Date.now() - watchFirstEventAt;
          if (watchTimer) clearTimeout(watchTimer);
          watchTimer = setTimeout(() => {
            watchTimer = null;
            watchFirstEventAt = 0;
            flushDirty().catch(() => {});
          }, waited >= WATCH_MAX_WAIT ? 0 : WATCH_DEBOUNCE);
        } catch {}
      }
    );
  } catch {
    return null;
  }
}

async function applyDirty(paths, deadline) {
  if (!workspaceIndex) return { changed: 0, leftover: [] };
  let changed = 0;
  const leftover = [];
  const rootPrefix = workspaceIndex.root.endsWith(path.sep) ? workspaceIndex.root : workspaceIndex.root + path.sep;
  for (const f of paths) {
    if (deadline && Date.now() > deadline) {
      leftover.push(f);
      continue;
    }
    if (!workspaceIndex.store.has(f)) {
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
      workspaceIndex.store.delFile(f);
      changed++;
      continue;
    }
    const key = `${st.size}:${st.mtimeMs}`;
    if (workspaceIndex.store.keyOf(f) === key) continue;
    if (await indexSingleFile(f, key)) changed++;
  }
  return { changed, leftover };
}

async function commitDirtyChange() {
  recomputeTotals();
  workspaceIndex.version = ++indexVersion;
  workspaceIndex.builtAt = Date.now();
  await savePersistedIndex();
}

async function flushDirty() {
  if (!workspaceIndex) return;
  const paths = [...watchDirty];
  watchDirty.clear();
  const { changed } = await applyDirty(paths, null);
  if (changed) await commitDirtyChange();
}

async function freshenForRead() {
  if (!workspaceIndex || watchDirty.size === 0) return;
  const paths = [...watchDirty];
  watchDirty.clear();
  const { changed, leftover } = await applyDirty(paths, Date.now() + FRESHEN_BUDGET_MS);
  for (const f of leftover) watchDirty.add(f);
  if (changed) await commitDirtyChange();
}

function staleNote(files) {
  if (!workspaceIndex || watchDirty.size === 0) return {};
  const stale = [...new Set(files)].filter((f) => watchDirty.has(f)).slice(0, 5);
  if (!stale.length) return {};
  return {
    stale: {
      pending: watchDirty.size,
      files: stale,
      warning: "these files changed recently and their index update is still pending; Read them directly for live content",
    },
  };
}

let resolverState = null;
let resolverVersion = -1;

function resolverFor() {
  if (!workspaceIndex) return null;
  if (resolverState && resolverVersion === workspaceIndex.version) return resolverState;
  const { files, defs } = workspaceIndex.store.resolveData();
  resolverState = buildResolver({ root: workspaceIndex.root, files, defs });
  resolverVersion = workspaceIndex.version;
  return resolverState;
}

let workspaceIndex = null;

const UNSUPPORTED_TRACK = new Set([
  ".js", ".jsx", ".cjs", ".mjs", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".rs",
  ".rb", ".php", ".kt", ".kts", ".swift", ".scala", ".dart", ".lua", ".vue",
  ".svelte", ".sql", ".sh", ".zig", ".ex", ".clj", ".groovy",
]);

async function walkSourceFiles(root, limit, out, depth, deadline, skipped) {
  checkSoft(deadline);
  if (out.length >= limit || depth > INDEX_MAX_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = [];
  const candidates = [];
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (INDEX_EXCLUDES.has(e.name) || e.name.startsWith(".")) continue;
      dirs.push(p);
    } else if (e.isFile()) {
      if (langForFile(e.name)) {
        candidates.push(p);
      } else {
        const dot = e.name.lastIndexOf(".");
        const ext = dot > 0 ? e.name.slice(dot).toLowerCase() : "";
        if (skipped && UNSUPPORTED_TRACK.has(ext)) skipped.set(ext, (skipped.get(ext) ?? 0) + 1);
      }
    }
  }
  const stats = new Array(candidates.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(WALK_STAT_CONCURRENCY, candidates.length) }, async () => {
      while (next < candidates.length) {
        const i = next++;
        checkSoft(deadline);
        try {
          const st = await fs.stat(candidates[i]);
          if (st.size <= MAX_BYTES) stats[i] = { size: st.size, mtimeMs: st.mtimeMs };
        } catch {}
      }
    })
  );
  dirs.sort((a, b) => {
    const pa = INDEX_PRIORITY_DIRS.has(path.basename(a)) ? 0 : 1;
    const pb = INDEX_PRIORITY_DIRS.has(path.basename(b)) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (let i = 0; i < candidates.length; i++) {
    if (out.length >= limit) return;
    if (stats[i]) out.push({ path: candidates[i], size: stats[i].size, mtimeMs: stats[i].mtimeMs });
  }
  for (const d of dirs) {
    if (out.length >= limit) return;
    await walkSourceFiles(d, limit, out, depth + 1, deadline, skipped);
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
    const sameRoot = workspaceIndex && workspaceIndex.root === rootAbs ? workspaceIndex : null;
    const forceJson = process.env.TREE_SITTER_MCP_STORE === "json";
    const store = sameRoot
      ? sameRoot.store
      : forceJson
        ? await openJsonStore(rootAbs, CACHE_DIR, () => legacyEntriesOf(rootAbs))
        : await openStore(rootAbs, CACHE_DIR, () => legacyEntriesOf(rootAbs));
    const caps = capsFor(store.kind);
    const limit = Math.min(
      Number(maxFiles) > 0 ? Number(maxFiles) : caps.def,
      caps.hard
    );
    const files = [];
    const skipped = new Map();
    if (workspaceIndex && workspaceIndex.watcher && !sameRoot) {
      try {
        workspaceIndex.watcher.close();
      } catch {}
    }
    const watcher = sameRoot ? sameRoot.watcher : startWatcher(rootAbs);
    await walkSourceFiles(rootAbs, limit + 1, files, 0, deadline, skipped);
    const filesTruncated = files.length > limit;
    if (filesTruncated) files.length = limit;
    let reused = 0;
    let parsed = 0;
    let refsTruncated = false;
    const todo = [];
    for (const fe of files) {
      const f = fe.path;
      const lang = langForFile(f);
      if (!lang) continue;
      const key = `${fe.size}:${fe.mtimeMs}`;
      const existing = store.has(f) ? store.getEntry(f) : null;
      if (existing && existing.key === key) {
        reused++;
        continue;
      }
      if (existing && existing.hash) {
        const h = await hashSource(f);
        if (h && h === existing.hash) {
          store.adoptKey(f, key);
          reused++;
          continue;
        }
      }
      todo.push({ f, lang, key });
    }
    const canShard = todo.length >= SHARD_MIN_FILES && (os.cpus()?.length ?? 1) >= 4;
    const doneFiles = canShard
      ? await runShards(todo, rootAbs, (f, entry, truncated) => {
          store.putFile(f, entry);
          parsed++;
          if (truncated) refsTruncated = true;
        })
      : new Set();
    const leftover = canShard ? todo.filter((t) => !doneFiles.has(t.f)) : todo;
    for (const { f, lang, key } of leftover) {
      checkSoft(deadline);
      try {
        const { entry, truncated } = await buildFileEntry(f, lang, key, deadline, rootAbs);
        store.putFile(f, entry);
        parsed++;
        if (truncated) refsTruncated = true;
      } catch {}
    }
    const keep = new Set(files.map((fe) => fe.path));
    for (const p of store.paths()) {
      if (!keep.has(p)) store.delFile(p);
    }
    workspaceIndex = {
      root: rootAbs,
      builtAt: Date.now(),
      version: ++indexVersion,
      store,
      watcher,
      totals: { files: 0, symbols: 0, refs: 0 },
      unsupported: summarizeUnsupported(skipped),
    };
    resolverState = null;
    recomputeTotals();
    if (store.kind === "json" && workspaceIndex.totals.refs > INDEX_MAX_REFS_TOTAL) refsTruncated = true;
    await flushDirty();
    await savePersistedIndex();
    return {
      root: workspaceIndex.root,
      indexed: store.fileCount(),
      discovered: files.length,
      files_truncated: filesTruncated,
      reused,
      parsed,
      symbols: workspaceIndex.totals.symbols,
      refs: workspaceIndex.totals.refs,
      refs_truncated: refsTruncated,
      index_version: workspaceIndex.version,
      store: store.kind,
      persisted: store.kind === "sqlite" || !!(await loadPersistedIndex(rootAbs)),
      watching: !!workspaceIndex.watcher,
      built_at: workspaceIndex.builtAt,
      ...(workspaceIndex.unsupported.count > 0
        ? {
            unsupported_skipped: workspaceIndex.unsupported,
            hint: `${workspaceIndex.unsupported.count} source files were skipped for unsupported languages (${workspaceIndex.unsupported.extensions_summary}); extend LANGUAGES in lib/languages.js with a grammar to cover them`,
          }
        : {}),
      ...(filesTruncated ? { hint: `maxFiles cap reached (${limit}); pass a larger maxFiles or narrow the root` } : {}),
    };
  },

  async prewarm({ lang }) {
    if (lang && LANGUAGES[lang]) await getLang(lang);
    return { prewarmed: lang ?? null };
  },

  async index_status() {
    if (!workspaceIndex) {
      throw new ToolError("no_index", "no index; run index_workspace first");
    }
    return {
      root: workspaceIndex.root,
      index_version: workspaceIndex.version,
      built_at: workspaceIndex.builtAt,
      store: workspaceIndex.store.kind,
      ...workspaceIndex.totals,
      watching: !!workspaceIndex.watcher,
      dirty: watchDirty.size,
      ...(workspaceIndex.unsupported && workspaceIndex.unsupported.count > 0 ? { unsupported_skipped: workspaceIndex.unsupported } : {}),
    };
  },

  async find_references({ name, file, limit, offset }) {
    if (!workspaceIndex) {
      throw new ToolError("no_index", "no index; run index_workspace first");
    }
    if (typeof name !== "string" || !name) {
      throw new ToolError("input", "name is required");
    }
    await freshenForRead();
    const page = pageOf({ limit, offset });
    const fileFilter = typeof file === "string" && file ? path.normalize(file) : null;
    let keyFilter = null;
    if (fileFilter) {
      let real = null;
      try { real = realpathSync(fileFilter); } catch {}
      const candidates = [fileFilter, ...(real && real !== fileFilter ? [real] : [])];
      const keys = workspaceIndex.store.paths();
      keyFilter =
        keys.find((k) => candidates.includes(k)) ??
        keys.filter((k) => candidates.some((c) => k.endsWith("/" + c)))[0] ??
        null;
    }
    const refs = workspaceIndex.store.refsByName(name, keyFilter ?? undefined);
    const defLinesByFile = new Map();
    for (const d of workspaceIndex.store.defsByName(name)) {
      if (!defLinesByFile.has(d.file)) defLinesByFile.set(d.file, new Set());
      defLinesByFile.get(d.file).add(d.start_line);
    }
    const recvByLine = new Map();
    for (const f of new Set(refs.map((r) => r.file))) {
      const m = new Map();
      for (const c of workspaceIndex.store.callsQuery({ file: f })) m.set(c.line, c.recv);
      recvByLine.set(f, m);
    }
    const resolver = resolverFor();
    const all = refs.map((r) => {
      const isDef = defLinesByFile.get(r.file)?.has(r.line);
      const recv = recvByLine.get(r.file)?.get(r.line) ?? null;
      const cls = isDef ? null : classifyRef(resolver, { name, file: r.file, recv });
      return {
        file: r.file,
        line: r.line,
        kind: isDef ? "definition" : "reference",
        ...(cls
          ? { confidence: cls.confidence, via: cls.via, ...(cls.resolved_to ? { resolved_to: cls.resolved_to } : {}) }
          : {}),
      };
    });
    all.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
    const results = all.slice(page.offset, page.offset + page.limit);
    const defined_in = keyFilter ? all.filter((r) => r.kind === "definition").map((r) => r.file) : definedFilesOf(name);
    const resolution = { exact: 0, likely: 0, name: 0 };
    for (const r of all) if (r.confidence) resolution[r.confidence] = (resolution[r.confidence] ?? 0) + 1;
    return {
      name,
      total: all.length,
      returned: results.length,
      offset: page.offset,
      truncated: page.offset + results.length < all.length,
      results,
      defined_in,
      resolution,
      ...(defined_in.length > 1
        ? { ambiguous: true, hint: `"${name}" is defined in ${defined_in.length} files; occurrences may belong to different same-named definitions — check module ownership per hit` }
        : {}),
      ...(all.length === 0 ? unsupportedNote() : {}),
      ...staleNote([...refs.map((r) => r.file), ...defined_in]),
      index_root: workspaceIndex.root,
      index_version: workspaceIndex.version,
      index_built_at: workspaceIndex.builtAt,
    };
  },

  async go_to_definition({ name, file, limit, offset }) {
    if (!workspaceIndex) {
      throw new ToolError("no_index", "no index; run index_workspace first");
    }
    if (typeof name !== "string" || !name) {
      throw new ToolError("input", "name is required");
    }
    await freshenForRead();
    const page = pageOf({ limit, offset }, INDEX_MAX_DEF_RESULTS);
    const all = workspaceIndex.store.defsByName(name);
    if (!all.length) {
      const note = unsupportedNote();
      throw new ToolError(
        "not_found",
        `definition "${name}" not found in index` +
          (note.unsupported_skipped
            ? `; note: the index skipped ${note.unsupported_skipped.count} source files with unsupported extensions (${note.unsupported_skipped.extensions_summary})`
            : "")
      );
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
    const filesWithDef = new Set(all.map((d) => d.file));
    return {
      name,
      count: all.length,
      returned: defs.length,
      offset: page.offset,
      truncated: page.offset + defs.length < all.length,
      ...(filesWithDef.size > 1
        ? { ambiguous: true, hint: `"${name}" is defined in ${filesWithDef.size} files; pass file for proximity ranking` }
        : {}),
      ...staleNote(all.map((d) => d.file)),
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

  async callers({ name, file, language, limit, offset }) {
    if (!workspaceIndex) {
      throw new ToolError("no_index", "no index; run index_workspace first");
    }
    if (typeof name !== "string" || !name) {
      throw new ToolError("input", "name is required");
    }
    await freshenForRead();
    const page = pageOf({ limit, offset });
    const rows = workspaceIndex.store.callsQuery({
      callee: name,
      ...(file ? { file } : {}),
      ...(language ? { lang: language } : {}),
    });
    const resolver = resolverFor();
    const all = rows.map((c) => {
      const cls = classifyRef(resolver, { name, file: c.file, recv: c.recv });
      return {
        file: c.file,
        lang: c.lang,
        line: c.line,
        caller: c.caller ?? "(top-level)",
        ...(c.recv ? { recv: c.recv } : {}),
        ...(cls
          ? { confidence: cls.confidence, via: cls.via, ...(cls.resolved_to ? { resolved_to: cls.resolved_to } : {}) }
          : {}),
      };
    });
    all.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
    const results = all.slice(page.offset, page.offset + page.limit);
    const defined_in = definedFilesOf(name);
    const resolution = { exact: 0, likely: 0, name: 0 };
    for (const r of all) if (r.confidence) resolution[r.confidence] = (resolution[r.confidence] ?? 0) + 1;
    return {
      name,
      total: all.length,
      returned: results.length,
      offset: page.offset,
      truncated: page.offset + results.length < all.length,
      results,
      defined_in,
      resolution,
      ...(defined_in.length > 1
        ? { ambiguous: true, hint: `"${name}" is defined in ${defined_in.length} files; call-site hits may belong to a different same-named definition — pass file to narrow, and verify module ownership` }
        : {}),
      ...(all.length === 0 ? unsupportedNote() : {}),
      ...staleNote(rows.map((r) => r.file)),
      index_root: workspaceIndex.root,
      index_version: workspaceIndex.version,
      index_built_at: workspaceIndex.builtAt,
    };
  },

  async callees({ name, file, language, limit, offset }) {
    if (!workspaceIndex) {
      throw new ToolError("no_index", "no index; run index_workspace first");
    }
    if (typeof name !== "string" || !name) {
      throw new ToolError("input", "name is required");
    }
    await freshenForRead();
    const page = pageOf({ limit, offset });
    const rows = workspaceIndex.store.callsQuery({
      caller: name,
      ...(file ? { file } : {}),
      ...(language ? { lang: language } : {}),
    });
    const resolver = resolverFor();
    const all = rows.map((c) => {
      const cls = classifyRef(resolver, { name: c.callee, file: c.file, recv: c.recv });
      return {
        file: c.file,
        lang: c.lang,
        line: c.line,
        callee: c.callee,
        ...(c.recv ? { recv: c.recv } : {}),
        ...(cls
          ? { confidence: cls.confidence, via: cls.via, ...(cls.resolved_to ? { resolved_to: cls.resolved_to } : {}) }
          : {}),
      };
    });
    all.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
    const results = all.slice(page.offset, page.offset + page.limit);
    const defined_in = definedFilesOf(name);
    const resolution = { exact: 0, likely: 0, name: 0 };
    for (const r of all) if (r.confidence) resolution[r.confidence] = (resolution[r.confidence] ?? 0) + 1;
    return {
      name,
      total: all.length,
      returned: results.length,
      offset: page.offset,
      truncated: page.offset + results.length < all.length,
      results,
      defined_in,
      resolution,
      ...(defined_in.length > 1
        ? { ambiguous: true, hint: `"${name}" is defined in ${defined_in.length} files; results may mix bodies of same-named definitions — pass file to query exactly one` }
        : {}),
      ...(all.length === 0 ? unsupportedNote() : {}),
      ...staleNote(rows.map((r) => r.file)),
      index_root: workspaceIndex.root,
      index_version: workspaceIndex.version,
      index_built_at: workspaceIndex.builtAt,
    };
  },

  async resolution_stats({ root }) {
    if (!workspaceIndex) {
      throw new ToolError("no_index", "no index; run index_workspace first");
    }
    if (root !== undefined && path.resolve(root) !== workspaceIndex.root) {
      throw new ToolError("input", `no index for root ${root}; indexed root is ${workspaceIndex.root}`);
    }
    await freshenForRead();
    const resolver = resolverFor();
    const calls = workspaceIndex.store.callsQuery({});
    const perLang = new Map();
    const via = { type: 0, import: 0, "import-static": 0, local: 0 };
    const agg = { calls: 0, recv: 0, exact: 0, likely: 0, name: 0 };
    for (const c of calls) {
      const rec = perLang.get(c.lang) ?? { calls: 0, recv: 0, exact: 0, likely: 0, name: 0 };
      rec.calls++;
      if (c.recv) {
        rec.recv++;
        agg.recv++;
      }
      const cls = classifyRef(resolver, { name: c.callee, file: c.file, recv: c.recv });
      if (!cls) {
        rec.name++;
        agg.name++;
      } else if (cls.confidence === "exact") {
        rec.exact++;
        agg.exact++;
        via[cls.via] = (via[cls.via] ?? 0) + 1;
      } else {
        rec.likely++;
        agg.likely++;
      }
      perLang.set(c.lang, rec);
    }
    const { files } = workspaceIndex.store.resolveData();
    let importNames = 0;
    let importNamesResolved = 0;
    let filesWithImports = 0;
    let filesWithResolvedImport = 0;
    for (const f of files) {
      const imps = resolver.importsByFile.get(f.path) ?? [];
      if (imps.length) filesWithImports++;
      let total = 0;
      let resolved = 0;
      for (const imp of imps) {
        for (const n of imp.names ?? []) {
          total++;
          if (classifyByImport(resolver, n, f.path)) resolved++;
        }
      }
      importNames += total;
      importNamesResolved += resolved;
      if (total > 0 && resolved > 0) filesWithResolvedImport++;
    }
    let sameNameGroups = 0;
    const sameNameSamples = [];
    for (const [name, defs] of resolver.defsByName) {
      if (new Set(defs.map((d) => d.file)).size > 1) {
        sameNameGroups++;
        if (sameNameSamples.length < 20) sameNameSamples.push(name);
      }
    }
    return {
      root: workspaceIndex.root,
      index_version: workspaceIndex.version,
      index_built_at: workspaceIndex.builtAt,
      calls_total: calls.length,
      resolution: agg,
      exact_via: via,
      per_language: Object.fromEntries([...perLang.entries()].sort()),
      imports: {
        names: importNames,
        names_resolved: importNamesResolved,
        files_with_imports: filesWithImports,
        files_with_resolved_import: filesWithResolvedImport,
        files_total: files.length,
      },
      same_name_definitions: { groups: sameNameGroups, samples: sameNameSamples },
    };
  },
};

if (workerData && workerData.shard) {
  parentPort.on("message", async (msg) => {
    const { id, batch } = msg ?? {};
    const results = [];
    for (const it of batch ?? []) {
      try {
        const { entry, truncated } = await buildFileEntry(it.f, it.lang, it.key, null, workerData.root);
        results.push({ f: it.f, entry, truncated });
      } catch {}
    }
    parentPort.postMessage({ id, results });
  });
} else {
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
}
