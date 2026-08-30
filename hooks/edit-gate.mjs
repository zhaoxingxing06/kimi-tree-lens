import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireBuildLock,
  findProjectRoot,
  isWarned,
  ledgerAdd,
  ledgerHas,
  markWarned,
  norm,
  readJson,
  rootStateDir,
  sessionDir,
  storePaths,
} from "./lib/state.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_DEFS_QUERIED = 5;

let input = "";
process.stdin.on("data", (c) => (input += c));

function rel(root, file) {
  const r = path.relative(root, file);
  return r.startsWith("..") ? file : r;
}

function block(msg) {
  console.error(msg);
  process.exit(2);
}

async function queryImpact(target, root) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(PLUGIN_ROOT, "server.js")],
    cwd: PLUGIN_ROOT,
    env: { ...process.env, TREE_SITTER_MCP_TIMEOUT_MS: "30000" },
  });
  const client = new Client({ name: "tree-lens-edit-gate", version: "0.0.1" });
  await client.connect(transport);
  try {
    const parse = (r) => JSON.parse(r.content[0].text);
    const outline = parse(
      await client.callTool({ name: "cached_outline", arguments: { file: target } })
    );
    const names = outline.ok && Array.isArray(outline.defs) ? outline.defs.map((d) => d.name) : [];
    if (!names.length) return null;
    const hits = [];
    for (const name of names.slice(0, MAX_DEFS_QUERIED)) {
      try {
        const r = parse(await client.callTool({ name: "callers", arguments: { name, root } }));
        if (r.ok) for (const h of r.results ?? []) hits.push(h);
      } catch {}
    }
    return hits;
  } finally {
    await client.close().catch(() => {});
  }
}

process.stdin.on("end", async () => {
  try {
    const payload = JSON.parse(input || "{}");
    const raw = payload.tool_input?.path;
    if (typeof raw === "string") {
      const target = norm(raw);
      let isFile = false;
      try {
        isFile = statSync(target).isFile();
      } catch {}
      if (isFile) {
        const dir = sessionDir(payload);
        if (!ledgerHas(dir, target)) {
          block(
            `[tree-lens edit-gate] Edit blocked (read-before-edit): ${target}\n` +
              `This file has not been Read in this session. Read it first, then re-issue the same edit.\n` +
              `(Writing a brand-new file is exempt — the target does not exist yet.)`
          );
        }
        try {
          ledgerAdd(dir, [target]);
        } catch {}
        if (!isWarned(dir, target)) {
          const root = findProjectRoot(path.dirname(target));
          if (root) {
            const store = storePaths(root);
            if (existsSync(store.json)) {
              // JSON store: skip to avoid concurrent-write scenarios entirely
            } else if (!existsSync(store.db)) {
              const stateDir = rootStateDir(root);
              if (acquireBuildLock(path.join(stateDir, "build.lock"))) {
                spawn(
                  "node",
                  [path.join(PLUGIN_ROOT, "hooks", "index-build-child.mjs"), root, stateDir],
                  { detached: true, stdio: "ignore", env: process.env }
                ).unref();
              }
              const state = readJson(path.join(stateDir, "build-state.json"), null);
              if (state?.status !== "failed") {
                block(
                  `[tree-lens edit-gate] Edit deferred: the workspace index for this project is being built in the background (index_workspace).\n` +
                    `Re-issue the same edit in a moment; if it keeps being blocked, run the index_workspace tool manually to check progress.`
                );
              }
            } else {
              const hits = await queryImpact(target, root);
              if (hits && hits.length) {
                const callerFiles = [...new Set(hits.map((h) => norm(h.file)))];
                const unread = callerFiles.filter((f) => f !== target && !ledgerHas(dir, f));
                if (unread.length) {
                  markWarned(dir, target);
                  const sorted = [...hits].sort(
                    (a, b) =>
                      (a.confidence === "exact" ? 0 : 1) - (b.confidence === "exact" ? 0 : 1)
                  );
                  const top = sorted
                    .filter((h) => unread.includes(norm(h.file)))
                    .slice(0, 3)
                    .map(
                      (h) =>
                        `  - ${rel(root, norm(h.file))}:${h.line} calls ${h.name} (${h.confidence ?? "?"})`
                    );
                  block(
                    `[tree-lens edit-gate] Edit deferred once: ${rel(root, target)}\n` +
                      `Definitions in this file have ${hits.length} call site(s) across ${callerFiles.length} file(s); ${unread.length} caller file(s) not read in this session:\n` +
                      top.join("\n") +
                      `\n...remaining omitted\n` +
                      `If this change touches signatures/behavior/return values: Read the unread callers first, or verify with the callers tool.\n` +
                      `If it is comments/formatting only: ignore this notice.\n` +
                      `Then re-issue the same edit to proceed.`
                  );
                }
              }
            }
          }
        }
      }
    }
  } catch {}
  process.exit(0);
});
