import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fsSync from "node:fs";
import os from "node:os";

const JAVA = new URL("./fixtures/Sample.java", import.meta.url).pathname;
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const OUTSIDE = new URL("./outside.py", import.meta.url).pathname;
const tmpCache = fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-cache-"));
const tmpPersist = fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-persist-"));
let pass = 0;
let fail = 0;

function check(label, cond, extra) {
  if (cond) {
    pass++;
    console.log(`PASS ${label}`);
  } else {
    fail++;
    console.log(`FAIL ${label}${extra ? " :: " + JSON.stringify(extra).slice(0, 400) : ""}`);
  }
}

const parse = (r) => JSON.parse(r.content[0].text);

async function withClient(env, fn) {
  const t = new StdioClientTransport({
    command: "node",
    args: ["./server.js"],
    env: { ...process.env, ...env },
  });
  const c = new Client({ name: "smoke", version: "0.0.1" });
  await c.connect(t);
  try {
    await fn(c);
  } finally {
    await c.close();
  }
}

async function withRootsClient(rootPath, fn) {
  const t = new StdioClientTransport({
    command: "node",
    args: ["./server.js"],
    env: { ...process.env },
  });
  const c = new Client(
    { name: "smoke-roots", version: "0.0.1" },
    { capabilities: { roots: { listChanged: true } } }
  );
  c.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(rootPath).href, name: "ws" }],
  }));
  await c.connect(t);
  try {
    await fn(c);
  } finally {
    await c.close();
  }
}

await withClient(
  {
    TREE_SITTER_MCP_ALLOW_UNCONFINED: "1",
    TREE_SITTER_MCP_CACHE_DIR: tmpCache,
  },
  async (c) => {
  const tools = await c.listTools();
  const EXPECTED_TOOLS = [
    "list_definitions",
    "read_definition",
    "ast_search",
    "index_workspace",
    "find_references",
    "go_to_definition",
    "index_status",
    "list_presets",
    "preset_search",
    "get_node_types",
    "analyze_complexity",
    "callers",
    "callees",
    "resolution_stats",
  ];
  check(
    "14 tools registered",
    tools.tools.length === EXPECTED_TOOLS.length &&
      EXPECTED_TOOLS.every((n) => tools.tools.some((t) => t.name === n)),
    tools.tools.map((t) => t.name)
  );

  let r = parse(await c.callTool({ name: "list_definitions", arguments: { file: JAVA } }));
  check("java list ok", r.ok === true && r.lang === "java" && r.count > 0, r);
  const method = r.ok ? r.defs.find((d) => d.kind === "method") : null;
  check("java method captured", !!method, r.defs);
  check("java field captured", r.ok && r.defs.some((d) => d.kind === "field"), r.defs);

  if (method) {
    r = parse(await c.callTool({ name: "read_definition", arguments: { file: JAVA, name: method.name } }));
    check(
      "java read ok",
      r.ok === true && r.count >= 1 && r.defs[0].code.includes("return"),
      r
    );
  }

  r = parse(
    await c.callTool({
      name: "ast_search",
      arguments: { file: JAVA, pattern: "(method_invocation name: (identifier) @m)" },
    })
  );
  check("java ast_search ok", r.ok === true && r.pattern_matches > 0 && r.captures >= r.pattern_matches && r.results[0].text.length > 0, r);

  r = parse(await c.callTool({ name: "list_definitions", arguments: { file: JAVA } }));
  check("cache hit second call", r.ok === true && r.count > 0, r);

  r = parse(await c.callTool({ name: "list_definitions", arguments: { file: new URL("./fixtures/sample.py", import.meta.url).pathname } }));
  check("python list ok", r.ok === true && r.lang === "python" && r.count >= 2, r);

  r = parse(await c.callTool({ name: "list_definitions", arguments: { file: new URL("./fixtures/sample.ts", import.meta.url).pathname } }));
  check("ts list ok", r.ok === true && r.lang === "typescript" && r.count >= 3, r);

  r = parse(await c.callTool({ name: "list_definitions", arguments: { file: new URL("./fixtures/sample.tsx", import.meta.url).pathname } }));
  check("tsx list ok", r.ok === true && r.lang === "tsx" && r.count >= 1, r);

  r = parse(await c.callTool({ name: "list_definitions", arguments: { file: new URL("./fixtures/sample.go", import.meta.url).pathname } }));
  check("go list ok", r.ok === true && r.lang === "go" && r.count >= 3, r);

  r = parse(await c.callTool({ name: "read_definition", arguments: { file: JAVA, name: "___nope___" } }));
  check("read not_found", r.ok === false && !!r.hint && /not found/.test(r.error), r);

  r = parse(await c.callTool({ name: "list_definitions", arguments: { file: new URL("./fixtures/nothing.txt", import.meta.url).pathname } }));
  check("unsupported ext rejected", r.ok === false && /unsupported file type/i.test(r.error), r);

  r = parse(await c.callTool({ name: "list_definitions", arguments: { file: new URL("./fixtures/missing.java", import.meta.url).pathname } }));
  check("missing file rejected", r.ok === false && /file not found/.test(r.error), r);

  r = parse(await c.callTool({ name: "ast_search", arguments: { file: JAVA, pattern: "(identifier" } }));
  check("bad query rejected", r.ok === false && /invalid query/i.test(r.error), r);

  r = parse(await c.callTool({ name: "list_definitions", arguments: { file: new URL("./fixtures/binary.java", import.meta.url).pathname } }));
  check("binary rejected", r.ok === false && /binary/i.test(r.error), r);

  r = parse(await c.callTool({
    name: "ast_search",
    arguments: { file: "/etc/hosts", language: "java", pattern: "(identifier) @id" },
  }));
  check("language override extension bypass blocked", r.ok === false && /known source extension/.test(r.error), r);

  r = parse(await c.callTool({ name: "list_definitions", arguments: { file: JAVA } }));
  check("discovery takes precedence over opt-out", r.ok === true && r.path_policy === "confined" && r.roots_source === "discovered", r);

  r = parse(await c.callTool({ name: "list_presets", arguments: {} }));
  check("list_presets builtin", r.ok === true && r.count >= 8 && r.presets.some((p) => p.name === "eval-exec"), r);

  r = parse(await c.callTool({
    name: "preset_search",
    arguments: { file: new URL("./fixtures/audit.py", import.meta.url).pathname, name: "eval-exec" },
  }));
  check("preset_search eval-exec hits", r.ok === true && r.captures >= 2, r);

  r = parse(await c.callTool({
    name: "index_workspace",
    arguments: { root: new URL("./fixtures/", import.meta.url).pathname },
  }));
  check("index_workspace ok", r.ok === true && r.indexed >= 6 && r.symbols > 0 && r.refs > 0, r);

  r = parse(await c.callTool({ name: "find_references", arguments: { name: "Sample" } }));
  check("find_references Sample", r.ok === true && r.results.length > 0, r);

  r = parse(await c.callTool({ name: "go_to_definition", arguments: { name: "risky" } }));
  check("go_to_definition risky", r.ok === true && r.count >= 1 && r.defs[0].file.endsWith("audit.py"), r);

  r = parse(await c.callTool({ name: "go_to_definition", arguments: { name: "___nope___" } }));
  check("go_to_definition not_found", r.ok === false && /not found in index/.test(r.error), r);

  r = parse(await c.callTool({ name: "get_node_types", arguments: { language: "java" } }));
  check(
    "get_node_types java",
    r.ok === true && r.node_type_count > 100 && r.named_types.includes("method_declaration") && r.fields.length > 0,
    { count: r.node_type_count, named: r.named_types?.length, fields: r.fields?.length }
  );

  r = parse(await c.callTool({
    name: "analyze_complexity",
    arguments: { file: new URL("./fixtures/complex.py", import.meta.url).pathname },
  }));
  check(
    "analyze_complexity hotspots",
    r.ok === true && r.worst?.name === "tangled" && r.worst.complexity >= 6 && r.average < r.worst.complexity,
    r.worst
  );
});

await withRootsClient(FIXTURES, async (c) => {
  let r = parse(await c.callTool({ name: "list_definitions", arguments: { file: "sample.py" } }));
  check("relative path resolves against root", r.ok === true && r.lang === "python" && r.path_policy === "confined", r);

  r = parse(await c.callTool({ name: "list_definitions", arguments: { file: OUTSIDE } }));
  check("outside-root path rejected", r.ok === false && /outside workspace roots/.test(r.error), r);

  r = parse(await c.callTool({ name: "list_definitions", arguments: { file: JAVA } }));
  check("confined call inside root ok", r.ok === true && r.path_policy === "confined", r);
});

await withClient(
  {
    TREE_SITTER_MCP_TIMEOUT_MS: "1",
    TREE_SITTER_MCP_ALLOW_UNCONFINED: "1",
    TREE_SITTER_MCP_CACHE_DIR: tmpCache,
  },
  async (c) => {
  let r = parse(await c.callTool({ name: "list_definitions", arguments: { file: JAVA } }));
  check("timeout envelope", r.ok === false && /timed out/.test(r.error) && !!r.hint, r);
  r = parse(await c.callTool({ name: "list_definitions", arguments: { file: JAVA } }));
  check("call after timeout survives (worker rebuilt)", r.ok === false && /timed out/.test(r.error), r);
});

await withClient({ TREE_SITTER_MCP_CACHE_DIR: tmpCache }, async (c) => {
  let r = parse(await c.callTool({ name: "find_references", arguments: { name: "whatever" } }));
  check("no root + no index explicit error", r.ok === false && /no root could be inferred/.test(r.error) && r.hint, r);

  r = parse(await c.callTool({
    name: "go_to_definition",
    arguments: { name: "risky", file: new URL("./fixtures/audit.py", import.meta.url).pathname },
  }));
  check("auto-index from file root", r.ok === true && r.count >= 1 && r.auto_indexed === true, r);
  r = parse(await c.callTool({ name: "find_references", arguments: { name: "risky" } }));
  check("auto-indexed root answers without root", r.ok === true && r.total >= 1 && r.auto_indexed !== true, r);

  r = parse(await c.callTool({ name: "list_definitions", arguments: { file: JAVA } }));
  check("auto-root discovery accepts project file", r.ok === true && r.roots_source === "discovered" && r.path_policy === "confined", r);

  const tmpNoMarker = fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-nomarker-"));
  const stray = path.join(tmpNoMarker, "stray.py");
  fsSync.writeFileSync(stray, "x = 1\n");
  r = parse(await c.callTool({ name: "list_definitions", arguments: { file: stray } }));
  check("markerless path rejected", r.ok === false && /ALLOW_UNCONFINED|no workspace roots/.test(r.error), r);
  fsSync.rmSync(tmpNoMarker, { recursive: true, force: true });
});

await withClient(
  {
    TREE_SITTER_MCP_ALLOW_UNCONFINED: "1",
    TREE_SITTER_MCP_CACHE_DIR: tmpPersist,
    TREE_SITTER_MCP_WATCH_DEBOUNCE_MS: "100",
  },
  async (c) => {
    let r = parse(await c.callTool({ name: "index_workspace", arguments: { root: FIXTURES } }));
    check("persist: first index parses", r.ok === true && r.parsed > 0 && r.watching === true, r);

    r = parse(await c.callTool({ name: "index_workspace", arguments: { root: FIXTURES } }));
    check("persist: second index reuses", r.ok === true && r.reused === r.indexed && r.parsed === 0 && r.persisted === true, r);

    fsSync.writeFileSync(path.join(FIXTURES, "watch_extra.py"), "def newfn():\n    pass\n");
    await new Promise((res) => setTimeout(res, 1500));
    r = parse(await c.callTool({ name: "find_references", arguments: { name: "newfn" } }));
    check("watch: new file picked up", r.ok === true && r.total >= 1, r);

    r = parse(await c.callTool({ name: "index_status", arguments: {} }));
    check("index_status ok", r.ok === true && r.watching === true && r.index_version >= 2, r);

    r = parse(await c.callTool({ name: "callers", arguments: { name: "helper" } }));
    check(
      "callers helper",
      r.ok === true && r.total >= 3 && r.results.some((x) => x.caller === "caller_one") && r.results.some((x) => x.caller === "caller_two"),
      r
    );

    r = parse(await c.callTool({ name: "callees", arguments: { name: "caller_two" } }));
    check("callees caller_two", r.ok === true && r.total >= 2 && r.results.every((x) => x.callee === "helper"), r);

    fsSync.rmSync(path.join(FIXTURES, "watch_extra.py"), { force: true });
  }
);

const tmpUser = fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-user-"));fsSync.mkdirSync(path.join(tmpUser, "python"), { recursive: true });
fsSync.mkdirSync(path.join(tmpUser, "presets", "python"), { recursive: true });
fsSync.writeFileSync(
  path.join(tmpUser, "python", "extra.scm"),
  '((function_definition name: (identifier)) @user-def)\n'
);
fsSync.writeFileSync(
  path.join(tmpUser, "presets", "python", "shell-true.scm"),
  ';; user shell preset\n(keyword_argument name: (identifier) @kw (#eq? @kw "shell"))\n'
);

await withClient(
  {
    TREE_SITTER_MCP_USER_QUERIES: tmpUser,
    TREE_SITTER_MCP_ALLOW_UNCONFINED: "1",
    TREE_SITTER_MCP_CACHE_DIR: tmpCache,
  },
  async (c) => {
  let r = parse(await c.callTool({
    name: "list_definitions",
    arguments: { file: new URL("./fixtures/sample.py", import.meta.url).pathname },
  }));
  check("user def query merged", r.ok === true && r.defs.some((d) => d.kind === "user-def"), r);

  r = parse(await c.callTool({
    name: "preset_search",
    arguments: { file: new URL("./fixtures/audit.py", import.meta.url).pathname, name: "shell-true" },
  }));
  check("user preset searchable", r.ok === true && r.source === "user" && r.captures >= 1, r);
});
await withClient(
  {
    TREE_SITTER_MCP_ALLOW_UNCONFINED: "1",
    TREE_SITTER_MCP_CACHE_DIR: tmpCache,
  },
  async (c) => {
    const tmpLang = fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-lang-"));
    fsSync.writeFileSync(path.join(tmpLang, "ok.py"), "def probe_fn():\n    pass\n");
    fsSync.writeFileSync(path.join(tmpLang, "skip.js"), "function probe_fn() {}\n");

    let r = parse(await c.callTool({ name: "index_workspace", arguments: { root: tmpLang } }));
    check(
      "index reports unsupported skip",
      r.ok === true && r.unsupported_skipped?.count === 1 && r.unsupported_skipped?.extensions[".js"] === 1 && !!r.hint,
      r
    );

    r = parse(await c.callTool({ name: "find_references", arguments: { name: "___nope___", root: tmpLang } }));
    check("zero-result carries unsupported note", r.ok === true && r.total === 0 && r.unsupported_skipped?.count === 1, r);

    r = parse(await c.callTool({ name: "go_to_definition", arguments: { name: "___nope___", root: tmpLang } }));
    check("not_found mentions unsupported", r.ok === false && /unsupported extensions/.test(r.error), r);

    r = parse(await c.callTool({ name: "index_status", arguments: { root: tmpLang } }));
    check("index_status exposes unsupported", r.ok === true && r.unsupported_skipped?.count === 1, r);

    fsSync.rmSync(tmpLang, { recursive: true, force: true });
  }
);

fsSync.rmSync(tmpUser, { recursive: true, force: true });
fsSync.rmSync(tmpCache, { recursive: true, force: true });
fsSync.rmSync(tmpPersist, { recursive: true, force: true });

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);