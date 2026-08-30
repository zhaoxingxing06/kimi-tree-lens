import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rootStateDir, writeJson } from "./lib/state.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = process.argv[2];
const stateDir = process.argv[3] ?? rootStateDir(root);

try {
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(PLUGIN_ROOT, "server.js")],
    cwd: PLUGIN_ROOT,
    env: { ...process.env, TREE_SITTER_MCP_TIMEOUT_MS: "120000" },
  });
  const client = new Client({ name: "tree-lens-index-builder", version: "0.0.1" });
  await client.connect(transport);
  const r = JSON.parse(
    (await client.callTool({ name: "index_workspace", arguments: { root } })).content[0].text
  );
  await client.close().catch(() => {});
  writeJson(path.join(stateDir, "build-state.json"), {
    status: r.ok ? "ready" : "failed",
    at: Date.now(),
    ...(r.ok ? { indexed: r.indexed, symbols: r.symbols } : { error: r.error }),
  });
  if (r.ok) writeJson(path.join(stateDir, "last-build.json"), { at: Date.now() });
} catch (e) {
  writeJson(path.join(stateDir, "build-state.json"), {
    status: "failed",
    at: Date.now(),
    error: String(e?.message ?? e).slice(0, 300),
  });
}
try {
  rmSync(path.join(stateDir, "build.lock"));
} catch {}
process.exit(0);
