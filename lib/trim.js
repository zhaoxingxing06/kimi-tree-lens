export const MAX_BYTES = 1_000_000;
export const MAX_DEFS = 500;
export const MAX_MATCHES = 50;
export const MAX_SNIPPET = 200;
export const MAX_CODE = 20_000;

export function clip(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}
