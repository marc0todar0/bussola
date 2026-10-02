// ---------------------------------------------------------------------------
// How well a model reads bank notifications
// ---------------------------------------------------------------------------
// Scores a model on samples.json -- 40 notifications from Revolut, Fineco,
// N26, Nexo and OKX, in Italian, English and German -- asking it exactly what
// the API asks: the prompt and the JSON schema of
// api/services/inbox/extract.js, with the wallet's names as enums.
//
//   node tools/ai-eval/run.js              # no history
//   node tools/ai-eval/run.js --history    # one line of history per payment
//
// Environment: BUSSOLA_AI_URL (default http://127.0.0.1:11434/v1, an Ollama),
// BUSSOLA_AI_API_KEY (if the endpoint wants one),
// BUSSOLA_AI_MODEL (default qwen3.5:4b), BANK_NAMES (default "Marco Todaro,
// TODARO MARCO"; empty to leave them out). Needs nothing but Node and an OpenAI-compatible endpoint.
const path = require("node:path");
const { buildRequest, askModel, toDraft } = require("../../api/services/inbox/extract");

const URL = (process.env.BUSSOLA_AI_URL || "http://127.0.0.1:11434/v1").replace(/\/+$/, "");
const MODEL = process.env.BUSSOLA_AI_MODEL || "qwen3.5:4b";
const BANK_NAMES = (process.env.BANK_NAMES ?? "Marco Todaro, TODARO MARCO").split(",").map((s) => s.trim()).filter(Boolean);

const rows = (names, from) => names.map((name, i) => ({ id: from + i, name }));
const WALLET = {
  accounts: rows(["Fineco", "Revolut", "N26", "Nexo", "OKX"], 1),
  expenseCategories: rows(["Spesa", "Ristoranti e bar", "Trasporti", "Casa", "Abbonamenti", "Shopping", "Salute", "Svago", "Viaggi", "Varie"], 100),
  incomeCategories: rows(["Stipendio", "Rimborsi", "Interessi", "Altre entrate"], 200),
  currency: "EUR",
  bankNames: BANK_NAMES,
  today: new Date().toISOString().slice(0, 10),
};
const idOf = (name) => (WALLET.accounts.find((a) => a.name === name) || {}).id;

const main = async () => {
  const samples = require(path.join(__dirname, "samples.json"));
  const withHistory = process.argv.includes("--history");
  const score = {};
  const add = (k, ok) => {
    score[k] = score[k] || [0, 0];
    score[k][0] += ok ? 1 : 0;
    score[k][1] += 1;
  };
  const times = [];
  const misses = [];

  for (const s of samples) {
    const history =
      withHistory && s.type !== "transfer"
        ? [{ description: s.merchant || s.app, type: s.type, counterpart: s.category, account: s.account, count: 1 }]
        : [];
    const started = Date.now();
    let a;
    let draft;
    try {
      a = await askModel(buildRequest({ ...WALLET, text: s.text, source: s.app, history }), { url: URL, model: MODEL, apiKey: process.env.BUSSOLA_AI_API_KEY || "", timeoutMs: 900000 });
      draft = toDraft(a, WALLET);
    } catch (error) {
      a = { error: error.code || error.message };
      draft = {};
    }
    times.push((Date.now() - started) / 1000);

    const checks = {
      amount: Math.abs(Number(a.amount || 0) - s.amount) < 0.005,
      type: a.type === s.type,
      account: a.account === s.account,
    };
    if (s.merchant) checks.merchant = String(a.merchant || "").toLowerCase().includes(s.merchant.toLowerCase());
    if (s.type !== "transfer") checks.category = a.category === s.category;
    else {
      checks.other_account = a.other_account === s.counter;
      const [from, to] = s.direction === "in" ? [s.counter, s.account] : [s.account, s.counter];
      checks.direction = draft.fromId === idOf(from) && draft.toId === idOf(to);
    }
    for (const [k, ok] of Object.entries(checks)) add(k, ok);
    const bad = Object.keys(checks).filter((k) => !checks[k]);
    if (bad.length) {
      misses.push(`  - [${s.app}] ${s.text.slice(0, 70)}\n      ${bad.map((k) => `${k}: ${JSON.stringify(k === "direction" ? a.direction : a[k])}`).join("; ")}`);
    }
    process.stdout.write(bad.length ? "x" : ".");
  }

  console.log(`\n=== ${MODEL} ${withHistory ? "with history" : "no history"}, bank names: ${BANK_NAMES.length ? "yes" : "no"} ===`);
  for (const [k, [ok, n]] of Object.entries(score)) console.log(`${k.padEnd(14)} ${String(ok).padStart(2)}/${String(n).padStart(2)} = ${((100 * ok) / n).toFixed(1).padStart(5)}%`);
  times.sort((x, y) => x - y);
  console.log(`per notification: median ${times[Math.floor(times.length / 2)].toFixed(1)} s, max ${times[times.length - 1].toFixed(1)} s`);
  if (misses.length) console.log(misses.join("\n"));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
