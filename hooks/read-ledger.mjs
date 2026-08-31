import { statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bashWriteTargets, ledgerAdd, norm, sessionDir } from "./lib/state.mjs";

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input || "{}");
    const tool = payload.tool_name ?? "";
    const ti = payload.tool_input ?? {};
    const paths = [];
    if (tool === "Read" || tool === "Write" || tool === "Edit") {
      const p = ti.path ?? ti.file_path;
      if (typeof p === "string") paths.push(p);
    } else if (tool === "Bash" && typeof ti.command === "string") {
      paths.push(...bashWriteTargets(ti.command, payload.cwd ?? process.cwd()));
    }
    const real = paths
      .map(norm)
      .filter((p) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      });
    if (real.length) {
      ledgerAdd(sessionDir(payload), real);
      // Warm the outline cache in the background so a later cached_outline call
      // hits the cache instead of parsing live. Detached + unref'd: this hook
      // exits immediately and never blocks the tool pipeline on parsing.
      const child = spawn(process.execPath,
        [fileURLToPath(new URL("./outline-warm.mjs", import.meta.url)), ...real],
        { detached: true, stdio: "ignore" });
      child.unref();
    }
  } catch {}
  process.exit(0);
});
