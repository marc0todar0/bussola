#!/usr/bin/env node
// Writes dist/_headers for the demo on Netlify: the same security headers the
// nginx image sends, read from the same two files, so the demo cannot drift
// into a weaker policy than the application it shows.
//
//   node scripts/netlify-headers.mjs dist
//
//   - nginx/bussola-security-headers.inc.template   every add_header line
//   - nginx/18-bussola-csp.envsh                    the CSP, with the inline
//                                                   script hashes computed by
//                                                   scripts/csp-hashes.mjs from
//                                                   the index.html just built
//
// The demo has no API of its own origin to add to connect-src: its "API" is
// JavaScript in the page.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = process.argv[2] || join(root, "dist");

const hashes = execFileSync(process.execPath, [join(root, "scripts/csp-hashes.mjs"), join(dist, "index.html")], {
  encoding: "utf8",
}).trim();

const envsh = readFileSync(join(root, "nginx/18-bussola-csp.envsh"), "utf8");
const connect = envsh.match(/^CONNECT="(.*)"$/m);
const policy = envsh.match(/^BUSSOLA_CSP="(.*)"$/m);
if (!connect || !policy) {
  console.error("netlify-headers: could not find CONNECT= and BUSSOLA_CSP= in nginx/18-bussola-csp.envsh");
  process.exit(1);
}
const csp = policy[1].replace("${SCRIPT_HASHES}", hashes).replace("${CONNECT}", connect[1]);

const template = readFileSync(join(root, "nginx/bussola-security-headers.inc.template"), "utf8");
const headers = [...template.matchAll(/^add_header\s+(\S+)\s+"(.*)"\s+always;$/gm)].map(([, name, value]) =>
  name === "Content-Security-Policy" ? [name, csp] : [name, value],
);
if (!headers.some(([name]) => name === "Content-Security-Policy")) {
  console.error("netlify-headers: no Content-Security-Policy line in the headers template");
  process.exit(1);
}

const body = ["/*", ...headers.map(([name, value]) => `  ${name}: ${value}`), ""].join("\n");
writeFileSync(join(dist, "_headers"), body);
console.log(`netlify-headers: ${headers.length} headers written to ${join(dist, "_headers")}`);
