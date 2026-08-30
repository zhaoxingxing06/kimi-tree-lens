import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findProjectRoot,
  lastBuildFresh,
  rootStateDir,
  storePaths,
  acquireBuildLock,
} from "./lib/state.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input || "{}");
    const root = findProjectRoot(payload.cwd ?? process.cwd());
    if (root) {
      const store = storePaths(root);
      if (!existsSync(store.json)) {
        const stateDir = rootStateDir(root);
        if (!lastBuildFresh(path.join(stateDir, "last-build.json"), 10 * 60_000)) {
          if (acquireBuildLock(path.join(stateDir, "build.lock"))) {
            spawn(
              "node",
              [path.join(PLUGIN_ROOT, "hooks", "index-build-child.mjs"), root, stateDir],
              { detached: true, stdio: "ignore", env: process.env }
            ).unref();
          }
        }
      }
    }
  } catch {}
  process.exit(0);
});
