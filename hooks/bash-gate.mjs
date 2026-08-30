import { bashWriteTargets, ledgerHas, sessionDir } from "./lib/state.mjs";

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input || "{}");
    const command = payload.tool_input?.command;
    if (typeof command === "string") {
      const dir = sessionDir(payload);
      const targets = bashWriteTargets(command, payload.cwd ?? process.cwd());
      const unread = targets.filter((t) => !ledgerHas(dir, t));
      if (unread.length) {
        console.error(
          `[tree-lens bash-gate] Write to unread file(s) blocked:\n` +
            unread.map((f) => `  - ${f}`).join("\n") +
            `\nThese files have not been Read in this session. Read them first, then re-issue the same command.\n` +
            `Creating new files (target does not exist) is exempt.`
        );
        process.exit(2);
      }
    }
  } catch {}
  process.exit(0);
});
