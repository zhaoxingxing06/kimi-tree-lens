import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-fresh-"));
const root = path.join(tmp, "proj");
fsSync.mkdirSync(root, { recursive: true });
const svc = path.join(root, "svc.py");
const use = path.join(root, "use.py");
fsSync.writeFileSync(svc, ["def target():", "    pass", ""].join("\n"));
fsSync.writeFileSync(use, ["def caller():", "    target()", ""].join("\n"));

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

const cacheDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-fresh-cache-"));
const baseEnv = {
  ...process.env,
  TREE_SITTER_MCP_ALLOW_UNCONFINED: "1",
  TREE_SITTER_MCP_CACHE_DIR: cacheDir,
};

async function withServer(env, fn) {
  const t = new StdioClientTransport({ command: "node", args: ["./server.js"], env: { ...baseEnv, ...env } });
  const c = new Client({ name: "freshness-check", version: "0.0.1" });
  await c.connect(t);
  try {
    await fn(c);
  } finally {
    await c.close();
  }
}

await withServer({ TREE_SITTER_MCP_WATCH_DEBOUNCE_MS: "30000" }, async (c) => {
  let r = parse(await c.callTool({ name: "index_workspace", arguments: { root } }));
  check("index ok", r.ok === true && r.indexed === 2 && r.watching === true, r);

  fsSync.appendFileSync(svc, "\n\ndef brand_new():\n    pass\n");
  await new Promise((res) => setTimeout(res, 600));

  r = parse(await c.callTool({ name: "find_references", arguments: { name: "brand_new" } }));
  check(
    "freshen: pending edit visible immediately",
    r.ok === true && r.total >= 1 && r.stale === undefined,
    r
  );

  r = parse(await c.callTool({ name: "index_status", arguments: { root } }));
  check("freshen left no dirty files", r.ok === true && r.dirty === 0, r);
});

await withServer(
  { TREE_SITTER_MCP_WATCH_DEBOUNCE_MS: "30000", TREE_SITTER_MCP_FRESHEN_BUDGET_MS: "1" },
  async (c) => {
    const wide = path.join(tmp, "wide");
    fsSync.mkdirSync(wide, { recursive: true });
    for (let i = 0; i < 60; i++) {
      fsSync.writeFileSync(path.join(wide, `m${i}.py`), ["def target():", "    pass", "", "def call_it():", "    target()", ""].join("\n"));
    }
    let r = parse(await c.callTool({ name: "index_workspace", arguments: { root: wide } }));
    check("wide index ok", r.ok === true && r.indexed === 60, r);

    for (let i = 0; i < 60; i++) fsSync.appendFileSync(path.join(wide, `m${i}.py`), "\n# touched\n");
    await new Promise((res) => setTimeout(res, 600));

    r = parse(await c.callTool({ name: "find_references", arguments: { name: "target", root: wide } }));
    check(
      "stale banner present when freshen budget exhausted",
      r.ok === true && typeof r.stale === "object" && Array.isArray(r.stale.files) && r.stale.files.length >= 1 && !!r.stale.warning,
      r.stale
    );

    r = parse(await c.callTool({ name: "index_status", arguments: { root: wide } }));
    check("dirty files still pending", r.ok === true && r.dirty >= 1, r);
  }
);

fsSync.appendFileSync(svc, "\n\ndef catchup_fn():\n    pass\n");

await withServer({}, async (c) => {
  let r = parse(await c.callTool({ name: "find_references", arguments: { name: "catchup_fn", root } }));
  check(
    "catch-up: out-of-session edit absorbed on auto-index",
    r.ok === true && r.total >= 1 && r.auto_indexed === true,
    r
  );
  r = parse(await c.callTool({ name: "index_status", arguments: { root } }));
  check("catch-up store is sqlite", r.ok === true && r.store === "sqlite", r);
});

fsSync.rmSync(tmp, { recursive: true, force: true });
fsSync.rmSync(cacheDir, { recursive: true, force: true });

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
