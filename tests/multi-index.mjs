// Focused checks for the local patches:
//   #1 read-op pagination (limit/offset/maxLines)   #2 multi-index per root
//   #3 index_version/index_root on read responses   #4 index_workspace truncation warning
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.js", import.meta.url));
const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-multi-"));
const cache = fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-multi-cache-"));
const rootA = path.join(tmp, "a");
const rootB = path.join(tmp, "b");
const rootC = path.join(tmp, "c");
for (const d of [rootA, rootB, rootC]) fsSync.mkdirSync(d, { recursive: true });

// rootA: 13 occurrences of `dupref`, helper() called by caller_one(), a 302-line function
const many = ["def helper():", "    pass", "", "def caller_one():", "    helper()"];
for (let i = 0; i < 12; i++) many.push(`    dupref = ${i}`);
many.push("    return dupref");
many.push("", "def longfn():");
for (let i = 0; i < 300; i++) many.push(`    x${i} = ${i}`);
many.push("    return x0");
fsSync.writeFileSync(path.join(rootA, "many.py"), many.join("\n") + "\n");

// rootB: distinct symbol
fsSync.writeFileSync(path.join(rootB, "other.py"), "def only_b():\n    pass\n");

// rootC: two files, indexed with maxFiles=1
fsSync.writeFileSync(path.join(rootC, "one.py"), "def c_one():\n    pass\n");
fsSync.writeFileSync(path.join(rootC, "two.py"), "def c_two():\n    pass\n");

let pass = 0;
let fail = 0;
const check = (label, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`PASS ${label}`);
  } else {
    fail++;
    console.log(`FAIL ${label}${extra ? " :: " + JSON.stringify(extra).slice(0, 400) : ""}`);
  }
};
const parse = (r) => JSON.parse(r.content[0].text);

const t = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: {
    ...process.env,
    TREE_SITTER_MCP_ALLOW_UNCONFINED: "1",
    TREE_SITTER_MCP_CACHE_DIR: cache,
  },
});
const c = new Client({ name: "multi-check", version: "0.0.1" });
await c.connect(t);

// macOS resolves /tmp under /private/var — compare against realpath'd roots
const [realA, realB, realC] = [rootA, rootB, rootC].map((p) => fsSync.realpathSync(p));
const emptyDir = path.join(tmp, "no-index-here");
fsSync.mkdirSync(emptyDir, { recursive: true });

try {
  // #2 two indexes coexist
  let r = parse(await c.callTool({ name: "index_workspace", arguments: { root: rootA } }));
  check("index rootA ok", r.ok === true && r.indexed === 1, r);
  const versionA = r.index_version;

  r = parse(await c.callTool({ name: "index_workspace", arguments: { root: rootB } }));
  check("index rootB ok, rootA kept", r.ok === true && r.indexed === 1, r);

  // #2 read ops without root must not silently pick an index
  r = parse(await c.callTool({ name: "find_references", arguments: { name: "dupref" } }));
  check("no root + multiple indexes rejected", r.ok === false && /multiple indexes exist/.test(r.error), r);

  // #2 + #3 root selects the index; read responses carry index_root/version
  r = parse(await c.callTool({ name: "find_references", arguments: { name: "only_b", root: rootB } }));
  check("find_references rootB", r.ok === true && r.total === 1 && r.index_root === realB, r);
  check("find_references carries version", r.index_version >= 1, r);

  r = parse(await c.callTool({ name: "find_references", arguments: { name: "dupref", root: rootA } }));
  check("find_references rootA total 13", r.ok === true && r.total === 13, r);

  r = parse(await c.callTool({ name: "find_references", arguments: { name: "dupref", root: emptyDir } }));
  check("unindexed root rejected", r.ok === false && /no index for root/.test(r.error), r);

  // #1 pagination
  r = parse(await c.callTool({ name: "find_references", arguments: { name: "dupref", root: rootA, limit: 5 } }));
  check("page 1", r.ok === true && r.returned === 5 && r.offset === 0 && r.truncated === true, r);
  r = parse(await c.callTool({ name: "find_references", arguments: { name: "dupref", root: rootA, limit: 5, offset: 5 } }));
  check("page 2", r.ok === true && r.returned === 5 && r.offset === 5 && r.truncated === true, r);
  r = parse(await c.callTool({ name: "find_references", arguments: { name: "dupref", root: rootA, limit: 5, offset: 10 } }));
  check("page 3 last", r.ok === true && r.returned === 3 && r.truncated === false, r);

  r = parse(await c.callTool({ name: "callers", arguments: { name: "helper", root: rootA, limit: 1 } }));
  check("callers limit + version", r.ok === true && r.returned === 1 && r.results[0].caller === "caller_one" && r.index_version >= 1, r);

  r = parse(await c.callTool({ name: "go_to_definition", arguments: { name: "helper", root: rootA, limit: 1 } }));
  check("go_to_definition limit", r.ok === true && r.returned === 1 && r.count === 1, r);

  r = parse(await c.callTool({
    name: "ast_search",
    arguments: { file: path.join(rootA, "many.py"), pattern: "(identifier) @id", limit: 3 },
  }));
  check("ast_search limit", r.ok === true && r.returned === 3 && r.truncated === true && r.captures > 3, r);

  // #1 maxLines
  r = parse(await c.callTool({
    name: "read_definition",
    arguments: { file: path.join(rootA, "many.py"), name: "longfn", maxLines: 10 },
  }));
  check(
    "read_definition maxLines",
    r.ok === true && r.defs[0].truncated === true && r.defs[0].total_lines === 302 && r.defs[0].code.split("\n").length === 11,
    r.defs[0] && { total_lines: r.defs[0].total_lines, truncated: r.defs[0].truncated }
  );

  // #4 files_truncated warning
  r = parse(await c.callTool({ name: "index_workspace", arguments: { root: rootC, maxFiles: 1 } }));
  check("index_workspace files_truncated", r.ok === true && r.files_truncated === true && !!r.hint, r);

  // index_status: most recent = rootC; available_roots lists all; explicit root routes
  r = parse(await c.callTool({ name: "index_status", arguments: {} }));
  check(
    "index_status most recent + available_roots",
    r.ok === true && r.root === realC && Array.isArray(r.available_roots) && r.available_roots.length === 3,
    r
  );
  r = parse(await c.callTool({ name: "index_status", arguments: { root: rootA } }));
  check("index_status explicit root", r.ok === true && r.root === realA && r.index_version >= versionA, r);

  // re-index an existing root keeps working
  r = parse(await c.callTool({ name: "index_workspace", arguments: { root: rootA } }));
  check("re-index rootA ok", r.ok === true && r.index_version > versionA, r);
  r = parse(await c.callTool({ name: "find_references", arguments: { name: "only_b", root: rootB } }));
  check("rootB index untouched after rootA re-index", r.ok === true && r.total === 1, r);
} finally {
  await c.close();
  fsSync.rmSync(tmp, { recursive: true, force: true });
  fsSync.rmSync(cache, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
