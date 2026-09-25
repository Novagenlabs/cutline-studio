#!/usr/bin/env bash
# Build the previous studio — the commit just before the UI overhaul — into
# public/v1/, where next.config.ts serves it at /v1 beside the current one.
#
# Why a frozen, COMMITTED build rather than a build step: the container's
# `npm run build` runs from a plain `COPY . .` with no git history, so it
# cannot check out an old commit. This script is run by hand and its output
# under public/v1/ is checked in. Re-run it only to change V1_REV or the
# compatibility patch.
#
# The old source is built with ITS OWN pinned dependencies (its package-lock),
# not the current node_modules — the point of v1 is that it is the version
# users had, not the old UI over newer libraries.
#
# scripts/v1/compat.patch is the only change to the old source. It keeps v1
# working against today's server: the download name is sanitised to the
# server's rule, and the credit purchase posts to the Whop route instead of
# the retired Stripe one (same {pack} body, same {url} reply).
set -euo pipefail

V1_REV="${V1_REV:-1760aaa}"   # "Animate the brand mark as the app's loading state"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "v1: exporting $V1_REV"
( cd "$ROOT" && git archive --format=tar "$V1_REV" ) | tar -x -C "$WORK"

echo "v1: installing its pinned dependencies (this takes about a minute)"
( cd "$WORK" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null )

echo "v1: applying compatibility patch"
patch -p1 -d "$WORK" --forward --silent < "$ROOT/scripts/v1/compat.patch"

echo "v1: building with its own toolchain"
( cd "$WORK" && npm run build:cutter >/dev/null )

OUT="$ROOT/public/v1"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$WORK/public/cutline/app.js"  "$OUT/app.js"
cp "$WORK/public/cutline/app.css" "$OUT/app.css"
node "$ROOT/scripts/v1/relocate.mjs" "$WORK/public/cutline/index.html" "$OUT/index.html"

# Record what this snapshot is, next to it, so nobody has to guess later.
{
  echo "rev: $V1_REV"
  echo "built: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "patch: scripts/v1/compat.patch"
} > "$OUT/SNAPSHOT"

echo "v1: built into public/v1/"
ls -la "$OUT"
