import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

function g(...p) {
  return path.join(here, "..", "grammars", ...p);
}

export const LANGUAGES = {
  java: { extensions: [".java"], wasm: g("java", "java.wasm"), definitions: g("java", "java.scm"), nodeTypes: g("java", "node-types.json"), upstreamTags: g("java", "upstream-tags.scm") },
  python: { extensions: [".py"], wasm: g("python", "python.wasm"), definitions: g("python", "python.scm"), nodeTypes: g("python", "node-types.json"), upstreamTags: g("python", "upstream-tags.scm") },
  typescript: { extensions: [".ts", ".mts", ".cts"], wasm: g("typescript", "typescript.wasm"), definitions: g("typescript", "typescript.scm"), nodeTypes: g("typescript", "node-types.json"), upstreamTags: g("typescript", "upstream-tags.scm") },
  tsx: { extensions: [".tsx"], wasm: g("tsx", "tsx.wasm"), definitions: g("tsx", "tsx.scm"), nodeTypes: g("tsx", "node-types.json"), upstreamTags: g("tsx", "upstream-tags.scm") },
  go: { extensions: [".go"], wasm: g("go", "go.wasm"), definitions: g("go", "go.scm"), nodeTypes: g("go", "node-types.json"), upstreamTags: g("go", "upstream-tags.scm") },
};

export const SUPPORTED = Object.keys(LANGUAGES);

export function langForFile(file) {
  const lower = file.toLowerCase();
  for (const [lang, spec] of Object.entries(LANGUAGES)) {
    if (spec.extensions.some((e) => lower.endsWith(e))) return lang;
  }
  return null;
}
