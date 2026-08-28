// Zero-dependency launcher: installs runtime deps on first run, then boots the MCP server.
// Lets `/plugins install` work with no manual `npm install` step.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const marker = path.join(here, "node_modules", "@modelcontextprotocol", "sdk");

if (!existsSync(marker)) {
  console.error("[kimi-tree-lens] installing runtime dependencies (one-time)...");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: here,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error(
      "[kimi-tree-lens] dependency install failed; run `npm install --omit=dev` in this directory and retry."
    );
    process.exit(1);
  }
}

await import("./server.js");
