#!/usr/bin/env bash
# Build the distributable extension ZIP.
# Single source of truth — used by the release CI (release.yml) and the future
# Web Store publish workflow (webstore.yml). Run locally with: ./scripts/build.sh
#
# Usage:
#   ./scripts/build.sh                          # writes ./ultimate-scraper.zip
#   ./scripts/build.sh out/foo.zip              # writes ./out/foo.zip

set -euo pipefail

OUT="${1:-ultimate-scraper.zip}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"

# Refuse to build over an existing artifact (CI passes a unique versioned filename).
if [ -e "$OUT" ]; then
  echo "Output already exists: $OUT" >&2
  echo "Remove it or pick a different output path." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"

zip -r "$OUT" \
  manifest.json \
  popup \
  content \
  background \
  icons \
  -x "*.DS_Store" "node_modules/*" "*.log"

echo "Built: $OUT ($(du -h "$OUT" | cut -f1))"

if command -v sha256sum >/dev/null 2>&1; then
  echo "SHA256: $(sha256sum "$OUT" | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then
  echo "SHA256: $(shasum -a 256 "$OUT" | cut -d' ' -f1)"
fi
