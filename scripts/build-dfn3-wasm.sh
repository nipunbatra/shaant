#!/usr/bin/env bash
# Rebuilds vendor/deepfilternet/ from DeepFilterNet source.
# Requires: rustup (stable toolchain, wasm32-unknown-unknown target), wasm-pack.
# Last built from commit d375b2d8309e0935d165700c91da9de862a99c31.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_DIR="${1:-/tmp/DeepFilterNet-build}"

if [ ! -d "$REPO_DIR" ]; then
  git clone --depth 1 https://github.com/Rikorose/DeepFilterNet.git "$REPO_DIR"
fi
cd "$REPO_DIR"

# Patch 1: don't embed the 8 MB default model in the wasm binary
# (we fetch the model tar.gz separately at runtime, so embedding would double the download)
python3 - <<'EOF'
p = "libDF/Cargo.toml"
s = open(p).read()
s = s.replace('wasm = [\n  "tract",\n  "default-model",\n', 'wasm = [\n  "tract",\n')
open(p, "w").write(s)
EOF

# Patch 2: add df_free so JS can release per-channel states (upstream has no free fn)
if ! grep -q "pub unsafe fn df_free" libDF/src/wasm.rs; then
cat >> libDF/src/wasm.rs <<'EOF'

/// Free a DeepFilterNet state created via df_create().
#[wasm_bindgen]
pub unsafe fn df_free(st: *mut DFState) {
    if !st.is_null() {
        drop(Box::from_raw(st));
    }
}
EOF
fi

cd libDF
RUSTFLAGS="-C target-feature=+simd128" \
  wasm-pack build --target web --release --no-default-features --features wasm

cd - >/dev/null
DEST="$OLDPWD/vendor/deepfilternet"
mkdir -p "$DEST"
cp "$REPO_DIR"/libDF/pkg/{df.js,df_bg.wasm,LICENSE-MIT,LICENSE-APACHE} "$DEST/"
cp "$REPO_DIR"/models/DeepFilterNet3_onnx.tar.gz "$DEST/"
echo "Vendored into $DEST"
