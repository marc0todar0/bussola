#!/usr/bin/env node
// Prints the CSP source for every inline <script> in a built index.html, as
//   'sha256-...' 'sha256-...'
// for script-src. Run by the Dockerfile on the index.html the image is about
// to serve (see nginx/18-bussola-csp.envsh), so the policy always allows the
// inline script that is actually there, and nothing else.
//
//   node scripts/csp-hashes.mjs dist/index.html
//
// Fails the build on an inline event handler (onclick=, onload=...): a hash
// cannot allow one of those without 'unsafe-hashes', and the page would break
// in production only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: csp-hashes.mjs <index.html>");
  process.exit(2);
}

const html = readFileSync(file, "utf8");

if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html)) {
  console.error(`${file}: an inline event handler (on...=) cannot be allowed by a hash. Move it into a script.`);
  process.exit(1);
}

// The browser hashes exactly what sits between <script ...> and </script>,
// whitespace included, as UTF-8. Scripts with a src are not inline.
const hashes = [];
for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (/\bsrc\s*=/i.test(attrs)) continue;
  hashes.push(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
}

process.stdout.write(hashes.join(" "));
