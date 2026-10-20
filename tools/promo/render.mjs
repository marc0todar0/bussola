// Records promo.html into an MP4: seeks every frame, screenshots it and pipes
// the PNGs into ffmpeg, then muxes in the soundtrack from soundtrack.py.
//
//   node tools/promo/render.mjs [--lang it] [out.mp4]          the whole video
//   node tools/promo/render.mjs [--lang it] --stills 4 9.9 20  single frames, for checking
//
// English by default; --lang it records the Italian version.
//
// Needs Playwright (with a Chromium), ffmpeg and Python 3 with numpy.
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const FPS = 30;
const args = process.argv.slice(2);
let lang = "en";
const li = args.indexOf("--lang");
if (li !== -1) [, lang] = args.splice(li, 2);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(pathToFileURL(path.join(here, "promo.html")).href + `?render&lang=${lang}`);
await page.evaluate(() => document.fonts.ready);
const stage = page.locator("#stage");

if (args[0] === "--stills") {
  for (const t of args.slice(1)) {
    await page.evaluate(t => window.seek(t), Number(t));
    await stage.screenshot({ path: path.join(here, `still-${lang}-${t}.png`) });
  }
  await browser.close();
  process.exit(0);
}

const out = path.resolve(args[0] || path.join(here, lang === "en" ? "bussola-promo.mp4" : `bussola-promo-${lang}.mp4`));
const wav = path.join(here, "soundtrack.wav");
execFileSync("python3", [path.join(here, "soundtrack.py"), wav], { stdio: "inherit" });

const duration = await page.evaluate(() => window.DURATION);
const ffmpeg = spawn("ffmpeg", [
  "-y", "-loglevel", "error",
  "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
  "-i", wav,
  "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart",
  out,
], { stdio: ["pipe", "inherit", "inherit"] });

const frames = Math.round(duration * FPS);
for (let f = 0; f < frames; f++) {
  await page.evaluate(t => window.seek(t), f / FPS);
  const png = await stage.screenshot({ type: "png" });
  if (!ffmpeg.stdin.write(png)) await new Promise(r => ffmpeg.stdin.once("drain", r));
  if (f % FPS === 0) process.stdout.write(`\r${f / FPS}s / ${duration}s`);
}
ffmpeg.stdin.end();
await new Promise((res, rej) => ffmpeg.on("close", c => (c ? rej(new Error(`ffmpeg exited ${c}`)) : res())));
await browser.close();
console.log(`\n${out}`);
