import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-store-"));
const root = path.join(tmp, "proj");
fsSync.mkdirSync(path.join(root, "pkg"), { recursive: true });
fsSync.writeFileSync(path.join(root, "pkg", "svc.py"), ["def probe_def():", "    pass", "", "def caller():", "    probe_def()", ""].join("\n"));
fsSync.writeFileSync(path.join(root, "pkg", "other.py"), ["def probe_def():", "    return 1", ""].join("\n"));

let pass = 0;
let fail = 0;
const check = (label, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`PASS ${label}`);
  } else {
    fail++;
    console.log(`FAIL ${label}${extra ? " :: " + JSON.stringify(extra).slice(0, 500) : ""}`);
  }
};
const parse = (r) => JSON.parse(r.content[0].text);

const cacheDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-store-cache-"));
const baseEnv = {
  ...process.env,
  TREE_SITTER_MCP_ALLOW_UNCONFINED: "1",
  TREE_SITTER_MCP_CACHE_DIR: cacheDir,
};

async function withServer(env, fn) {
  const t = new StdioClientTransport({ command: "node", args: ["./server.js"], env: { ...baseEnv, ...env } });
  const c = new Client({ name: "store-check", version: "0.0.1" });
  await c.connect(t);
  try {
    await fn(c);
  } finally {
    await c.close();
  }
}

let sqliteTotals = null;

await withServer({}, async (c) => {
  let r = parse(await c.callTool({ name: "index_workspace", arguments: { root } }));
  check("sqlite store used by default", r.ok === true && r.store === "sqlite", r);
  sqliteTotals = { symbols: r.symbols, refs: r.refs, indexed: r.indexed };

  r = parse(await c.callTool({ name: "callers", arguments: { name: "probe_def", root } }));
  check("sqlite callers works", r.ok === true && r.total === 1 && r.results[0].caller === "caller", r);

  r = parse(await c.callTool({ name: "index_workspace", arguments: { root } }));
  check("sqlite re-index reuses all", r.ok === true && r.parsed === 0 && r.reused === 2, r);
});

await withServer({}, async (c) => {
  let r = parse(await c.callTool({ name: "callers", arguments: { name: "probe_def", root } }));
  check("new session queries sqlite db without reparse", r.ok === true && r.total === 1 && r.auto_indexed === true, r);
  r = parse(await c.callTool({ name: "index_workspace", arguments: { root } }));
  check("new session reuses persisted sqlite entries", r.ok === true && r.parsed === 0 && r.reused === sqliteTotals.indexed, r);
});

await withServer({ TREE_SITTER_MCP_STORE: "json" }, async (c) => {
  let r = parse(await c.callTool({ name: "index_workspace", arguments: { root } }));
  check("json fallback store works", r.ok === true && r.store === "json" && r.indexed === sqliteTotals.indexed, r);
  check("json store parity on symbols", r.symbols === sqliteTotals.symbols && r.refs === sqliteTotals.refs, { got: r.symbols, want: sqliteTotals.symbols });

  r = parse(await c.callTool({ name: "callers", arguments: { name: "probe_def", root } }));
  check("json store callers parity", r.ok === true && r.total === 1 && r.results[0].caller === "caller", r);
});

fsSync.rmSync(tmp, { recursive: true, force: true });
fsSync.rmSync(cacheDir, { recursive: true, force: true });

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
