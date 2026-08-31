#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

TS="npx -y tree-sitter-cli@0.25.8"
BUILD_DIR="$HOME/kimi-plugins/tree-sitter-build"
mkdir -p "$BUILD_DIR" grammars

SPEC=(
  "java|tree-sitter-java|v0.23.5|."
  "python|tree-sitter-python|v0.25.0|."
  "typescript|tree-sitter-typescript|v0.23.2|typescript"
  "tsx|tree-sitter-typescript|v0.23.2|tsx"
  "go|tree-sitter-go|v0.25.0|."
)

WANT="${*:-}"
for entry in "${SPEC[@]}"; do
  IFS='|' read -r lang repo tag subdir <<<"$entry"
  if [[ -n "$WANT" && " $WANT " != *" $lang "* ]]; then continue; fi
  if [[ -f "grammars/$lang/$lang.wasm" ]]; then
    echo "[skip] grammars/$lang/$lang.wasm"
    continue
  fi
  src="$BUILD_DIR/$repo"
  if [[ ! -d "$src" ]]; then
    echo "[clone] $repo @ $tag"
    git clone --depth 1 --branch "$tag" "https://github.com/tree-sitter/$repo.git" "$src"
  fi
  echo "[build] $lang ($repo $tag)"
  (
    cd "$src"
    if [[ ! -d node_modules ]]; then
      echo "[npm] install grammar deps"
      npm install --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1
    fi
    cd "$subdir"
    $TS generate
    $TS build --wasm
  )
  mkdir -p "grammars/$lang"
  wasm_file=$(ls "$src/$subdir"/tree-sitter-*.wasm | head -1)
  mv "$wasm_file" "grammars/$lang/$lang.wasm"
  echo "[done] grammars/$lang/$lang.wasm"
done

for entry in "${SPEC[@]}"; do
  IFS='|' read -r lang repo tag subdir <<<"$entry"
  if [[ -n "$WANT" && " $WANT " != *" $lang "* ]]; then continue; fi
  src="$BUILD_DIR/$repo/$subdir"
  root="$BUILD_DIR/$repo"
  mkdir -p "grammars/$lang"
  if [[ -f "$src/queries/tags.scm" ]]; then
    cp "$src/queries/tags.scm" "grammars/$lang/upstream-tags.scm"
  elif [[ -f "$root/queries/tags.scm" ]]; then
    cp "$root/queries/tags.scm" "grammars/$lang/upstream-tags.scm"
  fi
  if [[ -f "$src/queries/locals.scm" ]]; then
    cp "$src/queries/locals.scm" "grammars/$lang/upstream-locals.scm"
  elif [[ -f "$root/queries/locals.scm" ]]; then
    cp "$root/queries/locals.scm" "grammars/$lang/upstream-locals.scm"
  fi
  if [[ -f "$src/src/node-types.json" ]]; then
    cp "$src/src/node-types.json" "grammars/$lang/node-types.json"
  fi
done

python3 - <<'PYEOF' > lib/grammar-hashes.json
import hashlib, json, os
out = {}
for lang in sorted(os.listdir("grammars")):
    d = os.path.join("grammars", lang)
    if not os.path.isdir(d):
        continue
    p = os.path.join(d, lang + ".wasm")
    if os.path.isfile(p):
        out[lang] = hashlib.sha256(open(p, "rb").read()).hexdigest()
    for name in ("upstream-tags.scm", "upstream-locals.scm", "node-types.json"):
        f = os.path.join(d, name)
        if os.path.isfile(f):
            out[lang + "." + name.rsplit(".", 1)[0]] = hashlib.sha256(open(f, "rb").read()).hexdigest()
print(json.dumps(out, indent=2))
PYEOF
echo "[hashes] regenerated lib/grammar-hashes.json"
echo "ALL DONE"
