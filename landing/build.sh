#!/bin/sh
# Assembles the landing page into dist/. The screenshots and the icon are the
# README's and the app's own, copied at build rather than kept twice, so the
# page can never show an older app than the repository does.
set -eu
cd "$(dirname "$0")"
rm -rf dist
mkdir -p dist/screenshots
cp index.html style.css _headers dist/
cp -r fonts dist/
cp ../frontend/public/icon.svg ../frontend/public/apple-touch-icon.png dist/
cp ../docs/screenshots/*.png dist/screenshots/
