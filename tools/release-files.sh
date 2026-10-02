#!/bin/sh
# The files attached to a GitHub release, for installing without the
# repository:
#
#   tools/release-files.sh 0.2.0 dist-release/
#
# docker-compose.yml  -- the images pinned to this version by default, and no
#                        `build:` sections (there is no code to build from)
# example.env         -- as in the repository
#
# release.yml runs it on every version tag.
set -eu

VERSION="${1:?usage: release-files.sh VERSION OUTDIR}"
OUT="${2:?usage: release-files.sh VERSION OUTDIR}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "release-files.sh: '$VERSION' is not a version such as 0.2.0" >&2; exit 1 ;;
esac

mkdir -p "$OUT"
sed \
  -e "s/\${BUSSOLA_VERSION:-latest}/\${BUSSOLA_VERSION:-$VERSION}/" \
  -e "s/# BUSSOLA_VERSION pins a release, e.g. 0.2.0; unset, the latest./# Bussola $VERSION. BUSSOLA_VERSION in .env overrides it./" \
  -e '/# A released image (docker compose pull), or built here (up -d --build)./d' \
  -e '/^    build:$/,/^      context: /d' \
  -e '/^    build: /d' \
  "$ROOT/docker-compose.yml" > "$OUT/docker-compose.yml"
cp "$ROOT/example.env" "$OUT/example.env"

# Nothing of the repository may be left behind.
if grep -q 'build\|:-latest' "$OUT/docker-compose.yml"; then
  echo "release-files.sh: docker-compose.yml still builds or uses :latest" >&2
  exit 1
fi
echo "release files for $VERSION in $OUT"
