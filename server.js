import path from "node:path";
import fs from "node:fs/promises";
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
  query_syntax: 'probe node types with pattern "(identifier) @id"',
  internal: "fall back to Read/Grep for this file",
};

const POOL_SIZE = Math.min(Math.max(Number(process.env.TREE_SITTER_MCP_POOL) || 2, 1), 4);
const workers = [];
let seq = 0;
let lastLang = null;
const INDEX_OPS = new Set(["find_references", "go_to_definition", "index_status", "callers", "callees"]);
let indexEntry = null;
let lastIndexRoot = null;

async function ensureIndex(op) {
  if (!INDEX_OPS.has(op)) return { entry: null };
  if (indexEntry && workers.includes(indexEntry)) return { entry: indexEntry };
  if (lastIndexRoot) {
    const { msg, entry } = await callWorker(
      "index_workspace",
      { root: lastIndexRoot, softDeadlineMs: Math.floor(DEADLINES.index_workspace * SOFT_RATIO) },
      DEADLINES.index_workspace
    );
    if (msg.ok) {
      indexEntry = entry;
      return { entry };
    }
    return { error: `index worker was replaced and automatic rebuild failed (${msg.error}); run index_workspace again` };
  }
  return { entry: null };
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
      if (policy.root && !policy.unconfined) payload.confineRoot = policy.root;
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
    const hard = DEADLINES[op] ?? 15000;
    const soft = Math.floor(hard * SOFT_RATIO);
    payload.softDeadlineMs = soft;
    let sticky = null;
    if (INDEX_OPS.has(op)) {
      const r = await ensureIndex(op);
      if (r.error) return respond({ ok: false, error: r.error, hint: HINTS.internal });
      sticky = r.entry;
    }
    const { msg, entry } = await callWorker(op, payload, hard, sticky);
    if (msg.ok) {
      if (op === "index_workspace") {
        indexEntry = entry;
        lastIndexRoot = payload.root;
      }
      if (msg.data && msg.data.lang) lastLang = msg.data.lang;
      return respond({
        ok: true,
        ...(abs !== null ? { file: abs } : {}),
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

const server = new McpServer({ name: "tree-lens", version: "0.1.0" });

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
    },
  },
  (args) => runTool("ast_search", args)
);

server.registerTool(
  "index_workspace",
  {
    title: "Index workspace symbols",
    description:
      "Parse all supported source files under a directory and build an in-memory symbol index (definitions + identifier occurrences). Run once before find_references / go_to_definition.",
    inputSchema: {
      root: z.string().describe("workspace root directory"),
      maxFiles: z.number().optional().describe("cap on files to index (default 1500, hard max 5000)"),
    },
  },
  (args) => runTool("index_workspace", args)
);

server.registerTool(
  "find_references",
  {
    title: "Find identifier occurrences",
    description:
      "Name-based (syntactic, not scope-resolved) occurrences of an identifier across the indexed workspace, marking definition sites. Requires index_workspace first.",
    inputSchema: {
      name: z.string().describe("identifier name to find"),
    },
  },
  (args) => runTool("find_references", args)
);

server.registerTool(
  "go_to_definition",
  {
    title: "Find definitions by name",
    description:
      "Definition sites of a name across the indexed workspace, nearest to the optional `file` first. Requires index_workspace first.",
    inputSchema: {
      name: z.string().describe("definition name"),
      file: z.string().optional().describe("reference file for proximity ranking"),
    },
  },
  (args) => runTool("go_to_definition", args)
);

server.registerTool(
  "index_status",
  {
    title: "Report index status",
    description:
      "Report current workspace index state: root, version, totals, watcher active, pending dirty paths. Requires index_workspace first.",
    inputSchema: {},
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
      "Heuristic (name-based, within indexed workspace) call sites of a function: each hit gives file, line and enclosing caller function. Requires index_workspace first.",
    inputSchema: {
      name: z.string().describe("callee function name"),
    },
  },
  (args) => runTool("callers", args)
);

server.registerTool(
  "callees",
  {
    title: "Find functions called by a function",
    description:
      "Heuristic (name-based, within indexed workspace) callees of a function: call sites inside the function body grouped by callee name. Requires index_workspace first.",
    inputSchema: {
      name: z.string().describe("caller function name"),
    },
  },
  (args) => runTool("callees", args)
);

process.on("uncaughtException", (e) => {
  console.error(`[tree-sitter-mcp] uncaught: ${e?.stack ?? e}`);
});
process.on("unhandledRejection", (e) => {
  console.error(`[tree-sitter-mcp] rejection: ${String(e)}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
