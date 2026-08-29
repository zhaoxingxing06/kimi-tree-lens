import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SUPPORTED } from "./lib/languages.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE_DEADLINES = {
  list_definitions: 15000,
  read_definition: 15000,
  ast_search: 10000,
  index_workspace: 120000,
  find_references: 15000,
  go_to_definition: 15000,
  list_presets: 15000,
  preset_search: 15000,
  get_node_types: 15000,
  analyze_complexity: 15000,
  callers: 15000,
  callees: 15000,
  resolution_stats: 60000,
};
const envDeadline = Number(process.env.TREE_SITTER_MCP_TIMEOUT_MS);
const DEADLINES = Object.fromEntries(
  Object.entries(BASE_DEADLINES).map(([k, v]) => [k, envDeadline > 0 ? envDeadline : v])
);
const SOFT_RATIO = 0.8;

const HINTS = {
  input: "check the path/extension",
  timeout: "narrow the pattern or use Read instead",
  not_found: "run list_definitions first to get exact definition names",
  no_index: "run index_workspace(root) first, then re-run this query with the same root",
  query_syntax: 'probe node types with pattern "(identifier) @id"',
  internal: "fall back to Read/Grep for this file",
};

const AUTO_POOL = Math.max(2, Math.min(os.availableParallelism?.() ?? os.cpus().length, 6));
const POOL_SIZE = Math.min(Math.max(Number(process.env.TREE_SITTER_MCP_POOL) || AUTO_POOL, 1), 8);
const workers = [];
let seq = 0;
let lastLang = null;
const INDEX_OPS = new Set(["find_references", "go_to_definition", "index_status", "callers", "callees", "resolution_stats"]);
// one index per root; each index lives pinned to its own worker
const indexes = new Map(); // normPath(rootAbs) -> { entry: workerEntry|null, root: abs }
const indexHolders = new Set(); // workers currently authoritative for some root
const pendingIndex = new Map(); // normPath(rootAbs) -> Promise<workerEntry|null>
let lastIndexRoot = null;

function registerIndex(rootAbs, entry) {
  const key = normPath(rootAbs);
  const prev = indexes.get(key);
  if (prev?.entry) indexHolders.delete(prev.entry);
  indexHolders.add(entry);
  indexes.set(key, { entry, root: rootAbs });
  lastIndexRoot = rootAbs;
}

async function autoBuildIndex(rootAbs) {
  const key = normPath(rootAbs);
  if (pendingIndex.has(key)) return pendingIndex.get(key);
  const p = (async () => {
    const { msg, entry } = await callWorker(
      "index_workspace",
      { root: rootAbs, softDeadlineMs: Math.floor(DEADLINES.index_workspace * SOFT_RATIO) },
      DEADLINES.index_workspace,
      acquireFreeIndexWorker()
    );
    if (!msg.ok || !entry) return null;
    registerIndex(rootAbs, entry);
    return entry;
  })().finally(() => pendingIndex.delete(key));
  pendingIndex.set(key, p);
  return p;
}

function acquireFreeIndexWorker() {
  return workers.find((e) => !indexHolders.has(e)) ?? spawnWorker();
}

async function ensureIndex(op, requestedRoot) {
  if (!INDEX_OPS.has(op)) return { entry: null };
  let rec = null;
  if (requestedRoot !== undefined) {
    rec = indexes.get(normPath(path.resolve(requestedRoot)));
    if (!rec) return { build: requestedRoot };
  } else {
    if (indexes.size === 0) return { build: null };
    if (indexes.size === 1) rec = indexes.values().next().value;
    else return { error: `multiple indexes exist (${[...indexes.keys()].join(", ")}); pass root to choose one` };
  }
  if (rec.entry && workers.includes(rec.entry)) return { entry: rec.entry };
  // index worker was lost; rebuild it on a worker that holds no other index
  const { msg, entry } = await callWorker(
    "index_workspace",
    { root: rec.root, softDeadlineMs: Math.floor(DEADLINES.index_workspace * SOFT_RATIO) },
    DEADLINES.index_workspace,
    acquireFreeIndexWorker()
  );
  if (msg.ok) {
    rec.entry = entry;
    indexHolders.add(entry);
    return { entry };
  }
  return { error: `index worker was replaced and automatic rebuild failed (${msg.error}); run index_workspace again` };
}

const ROOTS = { list: [], source: "none", attempted: false };

const CI_PATHS = process.platform === "darwin";
const normPath = (p) => (CI_PATHS ? p.toLowerCase() : p);
function withinRoot(abs, root) {
  const a = normPath(abs);
  const b = normPath(root);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

function uriToPath(uri) {
  try {
    return path.resolve(decodeURIComponent(String(uri).replace(/^file:\/\//, "")));
  } catch {
    return null;
  }
}

async function refreshRoots() {
  let list = [];
  let source = "none";
  try {
    const underlying = server.server;
    if (typeof underlying.listRoots === "function") {
      const res = await underlying.listRoots(undefined, { timeout: 3000 });
      const paths = (res?.roots ?? []).map((r) => uriToPath(r.uri)).filter(Boolean);
      list = await Promise.all(paths.map((p) => fs.realpath(p).catch(() => p)));
      source = "host";
    }
  } catch {}
  if (!list.length && process.env.TREE_SITTER_MCP_ROOTS) {
    list = process.env.TREE_SITTER_MCP_ROOTS
      .split(path.delimiter)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => path.resolve(p));
    source = "env";
  }
  ROOTS.list = list;
  ROOTS.source = source;
}

function ensureRoots() {
  if (ROOTS.attempted) return Promise.resolve();
  ROOTS.attempted = true;
  return refreshRoots().catch(() => {});
}

const PROJECT_MARKERS = [
  ".git", ".hg", ".svn",
  "package.json", "pom.xml", "build.gradle", "pyproject.toml", "setup.py",
  "setup.cfg", "Cargo.toml", "go.mod", "composer.json",
];
const DISCOVERED = [];

async function discoverRoot(abs, isDir) {
  let dir = isDir ? abs : path.dirname(abs);
  while (true) {
    for (const m of PROJECT_MARKERS) {
      const st = await fs.stat(path.join(dir, m)).catch(() => null);
      if (st) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function resolvePolicy(abs, isDir) {
  if (ROOTS.list.length) {
    const hit = ROOTS.list.find((r) => withinRoot(abs, r));
    return hit
      ? { ok: true, unconfined: false, source: "host-or-env", root: hit }
      : { ok: false, error: `path outside workspace roots (${ROOTS.list.join(", ")})` };
  }
  let root = await discoverRoot(abs, isDir);
  if (root) {
    root = await fs.realpath(root).catch(() => root);
    if (!DISCOVERED.includes(root)) DISCOVERED.push(root);
    return { ok: true, unconfined: false, source: "discovered", root };
  }
  if (process.env.TREE_SITTER_MCP_ALLOW_UNCONFINED === "1") {
    return { ok: true, unconfined: true, source: "opt-out" };
  }
  return {
    ok: false,
    error: "no workspace roots found above the path (no project markers); set TREE_SITTER_MCP_ROOTS or TREE_SITTER_MCP_ALLOW_UNCONFINED=1",
  };
}

function spawnWorker() {
  const w = new Worker(new URL("./lib/worker.js", import.meta.url));
  const entry = { w, pending: new Map(), inflight: 0 };
  w.on("message", (msg) => {
    const p = entry.pending.get(msg.id);
    if (!p) return;
    entry.pending.delete(msg.id);
    entry.inflight--;
    clearTimeout(p.timer);
    p.resolve(msg);
  });
  w.on("error", (err) => dropWorker(entry, `worker crashed: ${err?.message ?? err}`));
  w.on("exit", (code) => dropWorker(entry, `worker exited unexpectedly (code ${code})`));
  workers.push(entry);
  return entry;
}

function refillPool() {
  while (workers.length < POOL_SIZE) {
    const e = spawnWorker();
    if (lastLang) {
      const id = ++seq;
      e.pending.set(id, { resolve: () => {}, timer: null });
      e.inflight++;
      e.w.postMessage({ id, op: "prewarm", payload: { lang: lastLang } });
    }
  }
}

function dropWorker(entry, reason) {
  for (const rec of indexes.values()) {
    if (rec.entry === entry) rec.entry = null;
  }
  indexHolders.delete(entry);
  for (const p of entry.pending.values()) {
    if (p.timer) clearTimeout(p.timer);
    p.resolve({ ok: false, errorKind: "internal", error: reason });
  }
  entry.pending.clear();
  entry.inflight = 0;
  const i = workers.indexOf(entry);
  if (i >= 0) workers.splice(i, 1);
  entry.w.terminate();
  refillPool();
}

function acquireWorker() {
  if (!workers.length) return spawnWorker();
  let best = workers[0];
  for (const e of workers) if (e.inflight < best.inflight) best = e;
  if (workers.length < POOL_SIZE && best.inflight > 0) return spawnWorker();
  return best;
}

function callWorker(op, payload, deadlineMs, sticky = null) {
  return new Promise((resolve) => {
    let entry;
    if (sticky) {
      if (!workers.includes(sticky)) {
        resolve({ msg: { ok: false, errorKind: "internal", error: "index worker lost; run index_workspace again" }, entry: null });
        return;
      }
      entry = sticky;
    } else {
      entry = acquireWorker();
    }
    const id = ++seq;
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      entry.inflight--;
      dropWorker(entry, `${op} timed out after ${deadlineMs}ms; worker replaced`);
      resolve({ msg: { ok: false, errorKind: "timeout", error: `${op} timed out after ${deadlineMs}ms` }, entry: null });
    }, deadlineMs);
    entry.pending.set(id, { resolve: (msg) => resolve({ msg, entry }), timer });
    entry.inflight++;
    entry.w.postMessage({ id, op, payload });
  });
}

function respond(res) {
  return { isError: res.ok === false, content: [{ type: "text", text: JSON.stringify(res) }] };
}

async function runTool(op, args) {
  try {
    await ensureRoots();
    const payload = { ...args };
    const rawPath = args.file ?? args.root;
    let pathPolicy = null;
    let rootsSource = null;
    let policyRoot = null;
    let abs = null;
    if (rawPath !== undefined) {
      const isDir = args.file === undefined;
      if (!path.isAbsolute(rawPath)) {
        if (ROOTS.list.length) {
          abs = path.resolve(ROOTS.list[0], rawPath);
        } else if (DISCOVERED.length) {
          abs = path.resolve(DISCOVERED[0], rawPath);
        } else {
          return respond({ ok: false, error: "relative path but no workspace roots known; pass an absolute path", hint: HINTS.input });
        }
      } else {
        abs = path.resolve(rawPath);
      }
      abs = await fs.realpath(abs).catch(() => abs);
      const policy = await resolvePolicy(abs, isDir);
      if (!policy.ok) {
        return respond({ ok: false, error: policy.error, hint: HINTS.input });
      }
      pathPolicy = policy.unconfined ? "unconfined" : "confined";
      rootsSource = policy.source;
      if (policy.root && !policy.unconfined) {
        payload.confineRoot = policy.root;
        policyRoot = policy.root;
      }
      if (args.file !== undefined) {
        payload.file = abs;
        const st = await fs.stat(abs).catch(() => null);
        if (!st) {
          return respond({ ok: false, error: `file not found: ${abs}`, hint: HINTS.input });
        }
        if (!st.isFile()) {
          return respond({ ok: false, error: `not a regular file: ${abs}`, hint: HINTS.input });
        }
      } else {
        payload.root = abs;
        const st = await fs.stat(abs).catch(() => null);
        if (!st || !st.isDirectory()) {
          return respond({ ok: false, error: `not a directory: ${abs}`, hint: HINTS.input });
        }
      }
    }
    if (INDEX_OPS.has(op) && typeof args.root === "string") {
      // e.g. go_to_definition with both file (for proximity) and root (index selection)
      // normalize unconditionally: payload.root may be a raw copy of args.root when
      // args.file is present, and index keys are registered under the realpath'd root
      let absRoot = path.resolve(args.root);
      absRoot = await fs.realpath(absRoot).catch(() => absRoot);
      const rootPolicy = await resolvePolicy(absRoot, true);
      if (!rootPolicy.ok) {
        return respond({ ok: false, error: rootPolicy.error, hint: HINTS.input });
      }
      payload.root = absRoot;
    }
    const hard = DEADLINES[op] ?? 15000;
    const soft = Math.floor(hard * SOFT_RATIO);
    payload.softDeadlineMs = soft;
    let sticky = null;
    let autoIndexed = false;
    if (op === "index_workspace") {
      const key = normPath(payload.root);
      const prev = indexes.get(key);
      sticky = prev?.entry && workers.includes(prev.entry) ? prev.entry : acquireFreeIndexWorker();
    } else if (op === "index_status" && payload.root === undefined && indexes.size > 0) {
      // no root given: report the most recently built index and list the rest
      const rec = indexes.get(normPath(lastIndexRoot)) ?? [...indexes.values()].at(-1);
      if (!rec.entry || !workers.includes(rec.entry)) {
        return respond({ ok: false, error: `index worker for ${rec.root} was lost; run index_workspace to rebuild`, hint: HINTS.internal });
      }
      sticky = rec.entry;
    } else if (INDEX_OPS.has(op)) {
      if (payload.root === undefined && policyRoot) payload.root = policyRoot;
      const r = await ensureIndex(op, payload.root);
      if (r.error) return respond({ ok: false, error: r.error, hint: HINTS.internal });
      if (r.build !== undefined) {
        if (r.build === null) {
          return respond({
            ok: false,
            error: "no index exists yet and no root could be inferred from the call; run index_workspace(root) first",
            hint: HINTS.no_index,
          });
        }
        const entry = await autoBuildIndex(r.build);
        if (!entry) {
          return respond({ ok: false, error: `auto-index of ${r.build} failed; run index_workspace on that root to see the error`, hint: HINTS.internal });
        }
        sticky = entry;
        autoIndexed = true;
      } else {
        sticky = r.entry;
      }
    }
    const { msg, entry } = await callWorker(op, payload, hard, sticky);
    if (msg.ok) {
      if (op === "index_workspace") registerIndex(payload.root, entry);
      if (op === "index_status" && indexes.size > 0) {
        msg.data.available_roots = [...indexes.values()].map((rec) => rec.root);
      }
      if (msg.data && msg.data.lang) lastLang = msg.data.lang;
      return respond({
        ok: true,
        ...(abs !== null ? { file: abs } : {}),
        ...(autoIndexed ? { auto_indexed: true } : {}),
        ...(pathPolicy ? { path_policy: pathPolicy } : {}),
        ...(rootsSource ? { roots_source: rootsSource } : {}),
        ...msg.data,
      });
    }
    return respond({ ok: false, error: msg.error, hint: HINTS[msg.errorKind] ?? HINTS.internal });
  } catch (e) {
    return respond({ ok: false, error: String(e?.message ?? e), hint: HINTS.internal });
  }
}

const server = new McpServer({ name: "tree-lens", version: "1.0.0" });

try {
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    refreshRoots().catch(() => {});
  });
} catch {}

server.registerTool(
  "list_definitions",
  {
    title: "List definitions in a file",
    description:
      "List definitions (classes, functions, methods, fields, structs...) in a source file with name, kind and line ranges. Structural alternative to reading the whole file.",
    inputSchema: {
      file: z.string().describe("file path"),
      language: z.enum(SUPPORTED).optional().describe("override language inference"),
    },
  },
  (args) => runTool("list_definitions", args)
);

server.registerTool(
  "read_definition",
  {
    title: "Read one definition",
    description:
      "Read the source code of one definition (method/class/function...) by exact name from a source file. Overloads and same-named definitions are all returned with line numbers.",
    inputSchema: {
      file: z.string().describe("file path"),
      name: z.string().describe("exact definition name"),
      language: z.enum(SUPPORTED).optional().describe("override language inference"),
      maxLines: z
        .number()
        .optional()
        .describe("cap on lines returned per definition (default 200, hard max 1000); longer bodies are truncated"),
    },
  },
  (args) => runTool("read_definition", args)
);

server.registerTool(
  "ast_search",
  {
    title: "AST structural search",
    description:
      "Run a tree-sitter query (S-expression pattern) against a source file and return captures with line numbers. Use for AST-shaped matching that Grep cannot express.",
    inputSchema: {
      file: z.string().describe("file path"),
      pattern: z
        .string()
        .describe('tree-sitter query pattern, e.g. (method_invocation name: (identifier) @m)'),
      language: z.enum(SUPPORTED).optional().describe("override language inference"),
      limit: z.number().optional().describe("max captures returned (default 50, hard max 200)"),
      offset: z.number().optional().describe("skip the first N captures before applying limit"),
    },
  },
  (args) => runTool("ast_search", args)
);

server.registerTool(
  "index_workspace",
  {
    title: "Index workspace symbols",
    description:
      "Parse all supported source files under a directory into a persisted symbol index (definitions + identifier occurrences + call sites), backed by SQLite when available (JSON fallback). Run once before find_references / go_to_definition. Indexes are kept per root: indexing a new root adds a second index instead of replacing the existing one.",
    inputSchema: {
      root: z.string().describe("workspace root directory"),
      maxFiles: z
        .number()
        .optional()
        .describe("cap on files to index (default 20000 with SQLite store, 1500 with JSON fallback; hard max 100000 / 5000)"),
    },
  },
  (args) => runTool("index_workspace", args)
);

server.registerTool(
  "find_references",
  {
    title: "Find identifier occurrences",
    description:
      "Occurrences of an identifier across the indexed workspace, marking definition sites. References are classified with confidence tiers: exact (import-resolved or local), likely (same-dir or unique name), name (fallback). If the index for root does not exist yet it is built automatically (first call may be slow).",
    inputSchema: {
      name: z.string().describe("identifier name to find"),
      root: z
        .string()
        .optional()
        .describe("index root to query; required when several indexes exist"),
      file: z
        .string()
        .optional()
        .describe("restrict results to this file (scope filter for same-named definitions)"),
      limit: z.number().optional().describe("max results returned (default 50, hard max 200)"),
      offset: z.number().optional().describe("skip the first N results before applying limit"),
    },
  },
  (args) => runTool("find_references", args)
);

server.registerTool(
  "go_to_definition",
  {
    title: "Find definitions by name",
    description:
      "Definition sites of a name across the indexed workspace, nearest to the optional `file` first. If the index for root does not exist yet it is built automatically (first call may be slow).",
    inputSchema: {
      name: z.string().describe("definition name"),
      file: z.string().optional().describe("reference file for proximity ranking"),
      root: z
        .string()
        .optional()
        .describe("index root to query; required when several indexes exist"),
      limit: z.number().optional().describe("max definitions returned (default 50, hard max 200)"),
      offset: z.number().optional().describe("skip the first N definitions before applying limit"),
    },
  },
  (args) => runTool("go_to_definition", args)
);

server.registerTool(
  "index_status",
  {
    title: "Report index status",
    description:
      "Report current workspace index state: root, version, totals, watcher active, pending dirty paths. Without root, reports the most recently built index plus all available roots.",
    inputSchema: {
      root: z.string().optional().describe("index root to report; required when several indexes exist"),
    },
  },
  (args) => runTool("index_status", args)
);

server.registerTool(
  "list_presets",
  {
    title: "List audit query presets",
    description:
      "List built-in and user-provided audit query presets per language (eval/exec, subprocess shell, innerHTML, System.exit, os/exec...).",
    inputSchema: {
      language: z.enum(SUPPORTED).optional().describe("restrict to one language"),
    },
  },
  (args) => runTool("list_presets", args)
);

server.registerTool(
  "preset_search",
  {
    title: "Run an audit query preset",
    description:
      "Run a named preset (see list_presets) against a source file and return capture hits with line numbers.",
    inputSchema: {
      file: z.string().describe("file path"),
      name: z.string().describe("preset name"),
      language: z.enum(SUPPORTED).optional().describe("override language inference"),
    },
  },
  (args) => runTool("preset_search", args)
);

server.registerTool(
  "get_node_types",
  {
    title: "List grammar node types",
    description:
      "List named node types, anonymous tokens and field names for a language's grammar — use it to write correct ast_search query patterns without trial and error.",
    inputSchema: {
      language: z.enum(SUPPORTED).optional().describe("language to inspect"),
      file: z.string().optional().describe("file path (alternative to language)"),
    },
  },
  (args) => runTool("get_node_types", args)
);

server.registerTool(
  "analyze_complexity",
  {
    title: "Cyclomatic complexity per function",
    description:
      "Approximate cyclomatic complexity (1 + decision points: if/loops/case/catch/&&/||/ternary) per function in a source file, worst first.",
    inputSchema: {
      file: z.string().describe("file path"),
      language: z.enum(SUPPORTED).optional().describe("override language inference"),
    },
  },
  (args) => runTool("analyze_complexity", args)
);

server.registerTool(
  "callers",
  {
    title: "Find call sites of a function",
    description:
      "Heuristic (name-based) call sites of a function in the indexed workspace: each hit gives file, line, language, enclosing caller function and receiver object, plus a confidence tier (exact when the receiver's declared type or an import resolves the callee, likely for same-dir/unique names, name as fallback). Same-named methods of different classes are mixed in one result; filter by resolved_to for a precise call graph. Accepts optional file/language filters. If the index for root does not exist yet it is built automatically.",
    inputSchema: {
      name: z.string().describe("callee function name"),
      file: z.string().optional().describe("restrict to call sites in this file"),
      language: z.enum(SUPPORTED).optional().describe("restrict to one language"),
      root: z
        .string()
        .optional()
        .describe("index root to query; required when several indexes exist"),
      limit: z.number().optional().describe("max results returned (default 50, hard max 200)"),
      offset: z.number().optional().describe("skip the first N results before applying limit"),
    },
  },
  (args) => runTool("callers", args)
);

server.registerTool(
  "callees",
  {
    title: "Find functions called by a function",
    description:
      "Heuristic (name-based) call sites inside a function's body, grouped per callee name, with file, language, receiver object and a confidence tier (exact/likely/name) for the callee resolution. Same-named callees of different classes are grouped under one name; use the resolved_to fields to disambiguate. Accepts optional file/language filters. If the index for root does not exist yet it is built automatically.",
    inputSchema: {
      name: z.string().describe("caller function name"),
      file: z.string().optional().describe("restrict to call sites in this file"),
      language: z.enum(SUPPORTED).optional().describe("restrict to one language"),
      root: z
        .string()
        .optional()
        .describe("index root to query; required when several indexes exist"),
      limit: z.number().optional().describe("max results returned (default 50, hard max 200)"),
      offset: z.number().optional().describe("skip the first N results before applying limit"),
    },
  },
  (args) => runTool("callees", args)
);

server.registerTool(
  "resolution_stats",
  {
    title: "Measure cross-file resolution coverage",
    description:
      "Aggregate resolution statistics over the indexed workspace: share of call sites resolved at each confidence tier (exact/likely/name), how import names resolve, and how many names are defined in several files. Use it to measure, not assert, how well cross-file navigation works on a given codebase.",
    inputSchema: {
      root: z.string().optional().describe("index root to measure; required when several indexes exist"),
    },
  },
  (args) => runTool("resolution_stats", args)
);

process.on("uncaughtException", (e) => {
  console.error(`[tree-sitter-mcp] uncaught: ${e?.stack ?? e}`);
});
process.on("unhandledRejection", (e) => {
  console.error(`[tree-sitter-mcp] rejection: ${String(e)}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
