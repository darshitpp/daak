#!/usr/bin/env bash
#
# Regenerate Rust and TypeScript types from the CDDL schemas in proto/.
#
# proto/*.cddl is the schema source of truth; proto/gen is committed so Rust,
# TypeScript, and (later) Swift/Kotlin stay in lockstep. CI re-runs this and
# fails on any diff.
#
# The generator is dcSpark/cddl-codegen, pinned to a commit and cloned OUTSIDE
# the repo (a checkout inside is absorbed by the root Cargo workspace). Point
# CDDL_CODEGEN_DIR at a local checkout to reuse one.
#
# Requirements: git, cargo, node, pnpm.
#
# Usage: proto/codegen.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROTO_DIR="$REPO_ROOT/proto"
GEN_DIR="$PROTO_DIR/gen"

CDDL_CODEGEN_REPO="https://github.com/dcSpark/cddl-codegen"
CDDL_CODEGEN_REV="2fa208e79be241adf2e9fe0e36af18e60bc0943b"
CDDL_CODEGEN_DIR="${CDDL_CODEGEN_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/daak-cddl-codegen}"

# cddl-codegen's shipped run-json2ts.js requires json-schema-to-typescript.
# Pin it so the emitted .d.ts is byte-stable across machines and reruns.
JSON2TS_VERSION="16.0.0"

# 1. Fetch and build the pinned generator once per machine.
if [ ! -d "$CDDL_CODEGEN_DIR/.git" ]; then
  mkdir -p "$(dirname "$CDDL_CODEGEN_DIR")"
  git clone --quiet "$CDDL_CODEGEN_REPO" "$CDDL_CODEGEN_DIR"
fi
git -C "$CDDL_CODEGEN_DIR" fetch --quiet origin
git -C "$CDDL_CODEGEN_DIR" checkout --quiet "$CDDL_CODEGEN_REV"
cargo build --quiet --release --manifest-path "$CDDL_CODEGEN_DIR/Cargo.toml"
TOOL="$CDDL_CODEGEN_DIR/target/release/cddl-codegen"

# 2. Regenerate every spec from scratch, so removed rules disappear too.
rm -rf "$GEN_DIR"
mkdir -p "$GEN_DIR/rust" "$GEN_DIR/ts"

shopt -s nullglob
for spec_path in "$PROTO_DIR"/*.cddl; do
  spec="$(basename "$spec_path" .cddl)"
  echo ">> $spec"

  work="$(mktemp -d)"
  out="$work/out"
  mkdir -p "$out"

  "$TOOL" \
    --input="$spec_path" \
    --output="$out" \
    --lib-name="daak-$spec" \
    --static-dir="$CDDL_CODEGEN_DIR/static" \
    --json-serde-derives=true \
    --json-schema-export=true \
    --json-schema-scripts=true

  # Rust types -> proto/gen/rust/<spec>/.
  cp -R "$out/rust" "$GEN_DIR/rust/$spec"

  # TypeScript declarations -> proto/gen/ts/<spec>/json-types.d.ts. The JSON
  # Schema document is written by building the generated json-gen crate; the
  # shipped run-json2ts.js compiles it to TypeScript.
  printf '{"private":true,"name":"daak-proto-%s-gen","version":"0.0.0","dependencies":{"json-schema-to-typescript":"%s"}}\n' \
    "$spec" "$JSON2TS_VERSION" > "$out/package.json"
  # Install from the committed lockfile. A drift between package.json and the
  # lockfile fails the run instead of resolving new versions.
  cp "$PROTO_DIR/codegen.pnpm-lock.yaml" "$out/pnpm-lock.yaml"
  ( cd "$out" && pnpm install --silent --ignore-workspace --frozen-lockfile )
  ( cd "$out/wasm/json-gen" && cargo run --quiet )
  ( cd "$out" && node scripts/run-json2ts.js )

  mkdir -p "$GEN_DIR/ts/$spec"
  cp "$out/wasm/json-gen/output/json-types.d.ts" "$GEN_DIR/ts/$spec/json-types.d.ts"

  rm -rf "$work"
done
shopt -u nullglob

echo "regenerated proto/gen ($(find "$GEN_DIR" -type f | wc -l | tr -d ' ') files)"
