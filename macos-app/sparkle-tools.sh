#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
version=2.10.0
sha256=c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c
if ! grep -q "sparkle-project/Sparkle\", exact: \"$version\"" Package.swift; then
  echo "sparkle-tools.sh fetches Sparkle $version, and Package.swift pins another: change both together" >&2
  exit 1
fi
cache="$PWD/.build/sparkle-$version"
if [ ! -x "$cache/bin/generate_appcast" ]; then
  mkdir -p .build
  stage="$(mktemp -d "$PWD/.build/sparkle-fetch.XXXXXX")"
  trap 'rm -rf "$stage"' EXIT
  curl -fsSL --retry 3 --connect-timeout 20 --speed-limit 10000 --speed-time 60 -o "$stage/Sparkle.tar.xz" \
    "https://github.com/sparkle-project/Sparkle/releases/download/$version/Sparkle-$version.tar.xz"
  if [ "$(shasum -a 256 "$stage/Sparkle.tar.xz" | cut -d' ' -f1)" != "$sha256" ]; then
    echo "Sparkle-$version.tar.xz does not have the SHA-256 this script pins: nothing in it was run" >&2
    exit 1
  fi
  mkdir "$stage/sparkle"
  tar -xJf "$stage/Sparkle.tar.xz" -C "$stage/sparkle" bin
  rm -rf "$cache"
  mv "$stage/sparkle" "$cache"
fi
printf '%s\n' "$cache/bin"
