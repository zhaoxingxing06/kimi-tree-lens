import { statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bashWriteTargets, ledgerAddReads, norm, sessionDir } from "./lib/state.mjs";

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input || "{}");
    const tool = payload.tool_name ?? "";
    const ti = payload.tool_input ?? {};
    const cwd = payload.cwd ?? process.cwd();
    const entries = [];
    const warm = new Set();
    const exists = (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    };
    const addWarm = (p) => {
      if (warm.size < 32) warm.add(p);
    };
    if (tool === "Read" || tool === "Write" || tool === "Edit") {
      const p = ti.path ?? ti.file_path;
      if (typeof p === "string") {
        const real = norm(p);
        let range = [-1, -1];
        if (tool === "Read") {
          const off = Number(ti.offset ?? ti.line_offset);
          const n = Number(ti.n_lines ?? ti.limit);
          if (Number.isFinite(off) && off >= 1 && Number.isFinite(n) && n >= 1) {
            range = [off, off + n - 1];
          }
        }
        entries.push({ path: real, ranges: [range] });
        addWarm(real);
      }
    } else if (tool === "Bash" && typeof ti.command === "string") {
      for (const p of bashWriteTargets(ti.command, cwd)) {
        const real = norm(p);
        entries.push({ path: real, ranges: [[-1, -1]] });
        addWarm(real);
      }
    } else if (tool === "Grep" || tool === "Glob") {
      const text = `${payload.tool_response ?? ""}\n${payload.tool_output ?? ""}`;
      for (const tok of text.split(/\s+/)) {
        if (warm.size >= 16) break;
        const clean = tok
          .replace(/^['"`:,]+|['"`:,]+$/g, "")
          .replace(/(?::\d+)+$/, "")
          .replace(/['"`:,]+$/, "");
        if (!clean || clean.length < 4 || clean.startsWith("-")) continue;
        for (const cand of [clean, path.resolve(cwd, clean)]) {
          if (exists(cand)) {
            addWarm(norm(cand));
            break;
          }
        }
      }
    }
    const real = [...warm].filter(exists);
    if (entries.length) ledgerAddReads(sessionDir(payload), entries);
    if (real.length) {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./outline-warm.mjs", import.meta.url)), ...real],
        { detached: true, stdio: "ignore" }
      );
      child.unref();
    }
  } catch {}
  process.exit(0);
});
