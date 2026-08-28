import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

function g(...p) {
  return path.join(here, "..", "grammars", ...p);
}

export const LANGUAGES = {
  java: { extensions: [".java"], wasm: g("java", "java.wasm"), definitions: g("java", "java.scm") },
  python: { extensions: [".py"], wasm: g("python", "python.wasm"), definitions: g("python", "python.scm") },
  typescript: { extensions: [".ts", ".mts", ".cts"], wasm: g("typescript", "typescript.wasm"), definitions: g("typescript", "typescript.scm") },
  tsx: { extensions: [".tsx"], wasm: g("tsx", "tsx.wasm"), definitions: g("tsx", "tsx.scm") },
  go: { extensions: [".go"], wasm: g("go", "go.wasm"), definitions: g("go", "go.scm") },
};

export const SUPPORTED = Object.keys(LANGUAGES);

export function langForFile(file) {
  const lower = file.toLowerCase();
  for (const [lang, spec] of Object.entries(LANGUAGES)) {
    if (spec.extensions.some((e) => lower.endsWith(e))) return lang;
  }
  return null;
}
