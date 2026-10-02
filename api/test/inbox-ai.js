// ---------------------------------------------------------------------------
// The notification reader, without a model
// ---------------------------------------------------------------------------
// Runs on its own, no stack and no model needed:
//
//   node api/test/inbox-ai.js
//
// A local HTTP server plays an OpenAI-compatible endpoint. What it checks: the schema sent has the
// wallet's own names as its choices; the prompt carries the user's bank names
// and the line of history; the names that come back are mapped to the
// wallet's ids, and a name that is not the wallet's is null; a transfer
// arriving in an account runs from the other one; amounts and dates are
// validated; a malformed answer, an error and silence until the timeout are
// "could not be read", never a crash; the notification's text never reaches
// the log; the question goes to <base>/chat/completions (json_schema, Bearer
// key, 429 and bad answers are failed readings, the key never in the log);
// aiCloud() says whether the endpoint is outside the owner's network; the queue
// runs one job at a time and survives a failing one.
//
// The global fetch is wrapped so that a request anywhere but this machine
// fails the test instead of leaving it.

const http = require("node:http");

const realFetch = globalThis.fetch;
let offMachine = 0;
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith("http://127.0.0.1:")) {
    offMachine += 1;
    throw new Error(`unexpected request to ${url}`);
  }
  return realFetch(url, options);
};

const {
  aiEnabled,
  buildRequest,
  toDraft,
  readNotification,
  aiCloud,
} = require("../services/inbox/extract");
const { createQueue } = require("../services/inbox/queue");
const { parseNames } = require("../auth/bankNames");

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}\n`);
};

// Everything console.log/console.error print, to look for the text in it.
let logged = "";
for (const level of ["log", "error", "warn"]) {
  const original = console[level];
  console[level] = (...args) => {
    logged += `${args.map(String).join(" ")}\n`;
    void original;
  };
}

// What the fake endpoint answers next, and what it was asked.
let respond = () => ({ status: 200, body: {} });
let asked = [];
let headersSeen = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    asked.push({ method: req.method, path: req.url, body });
    headersSeen.push(req.headers);
    const answer = respond(req.url, body);
    if (answer === "hang") return; // never answers: the timeout has to end it
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
  });
});

// A chat answer whose content is `content` (an object is sent as JSON).
const chat = (content) => ({
  status: 200,
  body: { choices: [{ message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) } }] },
});

// A wallet: what the controller would have read inside RLS.
const TEXT = "Sent €500.00 to Marco Todaro (Fineco) SECRET-CARD-4242";
const wallet = {
  text: TEXT,
  source: "Revolut",
  today: "2026-09-29",
  currency: "EUR",
  accounts: [
    { id: 11, name: "Revolut" },
    { id: 12, name: "Fineco" },
  ],
  expenseCategories: [
    { id: 21, name: "Spesa" },
    { id: 22, name: "Other" },
  ],
  incomeCategories: [
    { id: 31, name: "Stipendio" },
    { id: 32, name: "Other" },
  ],
  bankNames: ["Marco Todaro", "TODARO MARCO"],
  history: [{ description: "Esselunga", type: "expense", counterpart: "Spesa", account: "Revolut", count: 12 }],
};

const main = async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const opts = { url, model: "test-model", timeoutMs: 2000 };
  const KEY = "sk-test-SECRET-KEY-9f3a";

  // --- on and off ----------------------------------------------------------
  delete process.env.BUSSOLA_AI_URL;
  record("without BUSSOLA_AI_URL the reader is off", aiEnabled() === false);
  process.env.BUSSOLA_AI_URL = `${url}/`;
  delete process.env.BUSSOLA_AI_MODEL;
  record("with a URL and no model it is still off: there is no default", aiEnabled() === false);
  process.env.BUSSOLA_AI_MODEL = "test-model";
  record("with a URL and a model it is on", aiEnabled() === true);
  const where = [
    ["http://localhost:11434/v1", false], ["http://127.0.0.1:11434/v1", false], ["http://192.168.1.20:11434/v1", false],
    ["http://10.0.0.5/v1", false], ["http://172.20.0.2/v1", false], ["http://ollama:11434/v1", false],
    ["http://host.docker.internal:11434/v1", false], ["http://nas.local:11434/v1", false],
    ["https://api.groq.com/openai/v1", true], ["https://api.openai.com/v1", true], ["http://172.32.0.1/v1", true],
    ["http://8.8.8.8/v1", true], ["not a url", true],
  ];
  const wrongWhere = where.filter(([u, want]) => {
    process.env.BUSSOLA_AI_URL = u;
    return aiCloud() !== want;
  });
  record("aiCloud(): your own network is not the cloud, any other host is", !wrongWhere.length, JSON.stringify(wrongWhere));
  delete process.env.BUSSOLA_AI_URL;
  record("aiCloud(): off when the reader is off", aiCloud() === false);
  delete process.env.BUSSOLA_AI_MODEL;

  // --- the question --------------------------------------------------------
  const req = buildRequest(wallet);
  const p = req.schema.properties;
  record("the account is an enum of the wallet's accounts",
    JSON.stringify(p.account.enum) === JSON.stringify(["Revolut", "Fineco", null]), JSON.stringify(p.account));
  record("the other account is the same names, or null",
    JSON.stringify(p.other_account.enum) === JSON.stringify(["Revolut", "Fineco", null]), JSON.stringify(p.other_account));
  record("the category is the expense and income names once each, or null",
    JSON.stringify(p.category.enum) === JSON.stringify(["Spesa", "Other", "Stipendio", null]), JSON.stringify(p.category));
  record("the type is one of expense, income, transfer (null for a notification that is not a movement)",
    JSON.stringify(p.type.enum) === JSON.stringify(["expense", "income", "transfer", null]));
  record("the first field is kind, a transaction or other, and the amount may be null",
    Object.keys(p)[0] === "kind" && req.schema.required[0] === "kind"
      && JSON.stringify(p.kind.enum) === JSON.stringify(["transaction", "other"])
      && JSON.stringify(p.amount.type) === JSON.stringify(["number", "null"]));
  record("the prompt separates a movement from offers, tips, codes and summaries, and leans to transaction when unsure",
    /kind/.test(req.system) && /promotions and marketing/.test(req.system) && /security alerts/.test(req.system)
      && /answer transaction/.test(req.system), req.system);
  record("every field is required", req.schema.required.length === Object.keys(p).length);
  record("the prompt names the user's own names and what they mean",
    req.system.includes('"Marco Todaro"') && req.system.includes('"TODARO MARCO"') && /both the user is a transfer/.test(req.system),
    req.system);
  record("the prompt names the wallet's currency and today", req.system.includes("EUR") && req.system.includes("2026-09-29"));
  record("the question carries the notification and the line of history",
    req.user.includes(TEXT) && req.user.includes('"Esselunga": expense, category "Spesa", account "Revolut" (12 times)'),
    req.user);
  const bare = buildRequest({ ...wallet, bankNames: [], history: [], accounts: [] });
  record("no names, no line about them; no history, no line about it; no accounts, account null",
    !/own names/.test(bare.system) && !/similar payments/.test(bare.user) && JSON.stringify(bare.schema.properties.account.enum) === "[null]");

  // --- the answer, mapped ----------------------------------------------------
  asked = [];
  respond = () =>
    chat({
      amount: 500, currency: "eur", date: null, merchant: "Marco Todaro", type: "transfer", direction: "out",
      account: "Revolut", category: null, other_account: "Fineco",
    });
  logged = "";
  const out = await readNotification(wallet, { ...opts, label: "item 1" });
  const sent = asked[0] && asked[0].body;
  record("the endpoint is asked at <base>/chat/completions, not streaming, at temperature 0, with the schema as json_schema",
    asked[0] && asked[0].path === "/chat/completions" && sent.stream === false
      && sent.temperature === 0 && sent.model === "test-model"
      && sent.response_format.type === "json_schema" && sent.response_format.json_schema.strict === false
      && JSON.stringify(sent.response_format.json_schema.schema) === JSON.stringify(req.schema),
    JSON.stringify(sent).slice(0, 300));
  record("an outgoing transfer runs from the account to the other one",
    out.ok && out.draft.typeId === 3 && out.draft.fromId === 11 && out.draft.toId === 12 && out.draft.amount === 500,
    JSON.stringify(out));
  record("the currency is kept, upper-cased", out.ok && out.draft.currency === "EUR");
  record("no date: null (the item keeps the day it arrived)", out.ok && out.draft.date === null);

  // A notification that is not a movement is dropped, not drafted.
  record("kind other is a skip, with no draft", JSON.stringify(toDraft({ kind: "other", amount: null, type: null }, wallet)) === '{"skip":true}');
  record("kind transaction, or no kind at all, is a draft as before",
    toDraft({ kind: "transaction", amount: 5, type: "expense", account: "Fineco", category: "Spesa" }, wallet).amount === 5
      && toDraft({ amount: 5, type: "expense", account: "Fineco", category: "Spesa" }, wallet).amount === 5);
  respond = () => chat({ kind: "other", amount: null, currency: null, date: null, merchant: null, type: null, account: null, category: null, other_account: null, direction: null });
  const promo = await readNotification({ ...wallet, text: "SECRET-PROMO-TEXT: scopri Revolut Metal, 3 mesi gratis" }, { ...opts, label: "item promo" });
  record("the model says other: the reading succeeds as a skip, and nothing of the text is logged",
    promo.ok === true && promo.skip === true && !promo.draft && !logged.includes("SECRET-PROMO-TEXT") && /not a transaction, dropped/.test(logged), JSON.stringify(promo));

  const incoming = toDraft(
    { amount: 200, type: "transfer", direction: "in", account: "Revolut", other_account: "Fineco", category: null },
    wallet,
  );
  record("an incoming transfer runs from the other account to this one",
    incoming.fromId === 12 && incoming.toId === 11, JSON.stringify(incoming));

  const expense = toDraft(
    { amount: 12.4, currency: "EUR", date: "2026-09-28", merchant: "  Esselunga\n Milano ", type: "expense", direction: "out", account: "revolut", category: "Other", other_account: null },
    wallet,
  );
  record("names map to the wallet's ids, whatever the case; an expense takes the expense category of that name",
    expense.fromId === 11 && expense.toId === 22 && expense.typeId === 1 && expense.merchant === "Esselunga Milano"
      && expense.date === "2026-09-28" && expense.amount === 12.4,
    JSON.stringify(expense));
  const income = toDraft({ amount: 1, type: "income", account: "Fineco", category: "Other" }, wallet);
  record("an income takes the income category of that name", income.toId === 32 && income.typeId === 2, JSON.stringify(income));

  const stranger = toDraft(
    { amount: 5, type: "expense", account: "Someone else's bank", category: "B's category", other_account: "Nope" },
    wallet,
  );
  record("a name that is not the wallet's is null", stranger.fromId === null && stranger.toId === null, JSON.stringify(stranger));
  const wrongKind = toDraft({ amount: 5, type: "expense", account: "Fineco", category: "Stipendio" }, wallet);
  record("an income category for an expense is null", wrongKind.toId === null, JSON.stringify(wrongKind));
  const self = toDraft({ amount: 5, type: "transfer", direction: "out", account: "Fineco", other_account: "Fineco" }, wallet);
  record("a transfer to the same account has no other end", self.fromId === 12 && self.toId === null, JSON.stringify(self));

  const amounts = [[12.4, 12.4], [0.0021, null], [-3, null], [0, null], [12.345, null], ["7.5", 7.5], ["abc", null], [1e13, null]];
  const badAmounts = amounts.filter(([v, want]) => toDraft({ amount: v }, wallet).amount !== want);
  record("amounts: positive, at most two decimals", !badAmounts.length, JSON.stringify(badAmounts));
  const dates = [["2026-09-29", "2026-09-29"], ["2026-09-30", "2026-09-30"], ["2026-10-01", null], ["2026-02-30", null], ["29/09/2026", null], [null, null]];
  const badDates = dates.filter(([v, want]) => toDraft({ date: v }, wallet).date !== want);
  record("dates: YYYY-MM-DD, a real day, no later than tomorrow", !badDates.length, JSON.stringify(badDates));
  record("a type that is not one of the three is null", toDraft({ type: "payment" }, wallet).typeId === null);

  record("the log says the item was read, without the text or the answer",
    /item 1: read in/.test(logged) && !logged.includes("SECRET-CARD-4242") && !logged.includes("Marco Todaro"),
    logged);

  // --- what goes wrong -------------------------------------------------------
  const failures = [
    ["malformed JSON", () => chat("{amount: 12,")],
    ["an answer that is not an object", () => chat("[1,2]")],
    ["no message at all", () => ({ status: 200, body: { done: true } })],
    ["a body that is not JSON", () => ({ status: 200, body: "<html>" })],
    ["an error status", () => ({ status: 500, body: { error: "boom" } })],
    ["a missing model", () => ({ status: 404, body: { error: "model not found" } })],
  ];
  for (const [what, answer] of failures) {
    respond = answer;
    logged = "";
    let r;
    try {
      r = await readNotification(wallet, { ...opts, label: "item 2" });
    } catch (error) {
      r = { crashed: error.message };
    }
    record(`${what}: could not be read, no crash, nothing of the text in the log`,
      r && r.ok === false && typeof r.reason === "string" && /item 2: could not be read/.test(logged)
        && !logged.includes("SECRET-CARD-4242"),
      `${JSON.stringify(r)} / ${logged}`);
  }

  respond = () => "hang";
  logged = "";
  const started = Date.now();
  const late = await readNotification(wallet, { ...opts, timeoutMs: 300, label: "item 3" });
  record("silence until the timeout: could not be read (AI_TIMEOUT), and quickly",
    late.ok === false && late.reason === "AI_TIMEOUT" && Date.now() - started < 2000,
    JSON.stringify(late));

  logged = "";
  const down = await readNotification(wallet, { ...opts, url: "http://127.0.0.1:1", label: "item 4" });
  record("nobody listening: could not be read (AI_UNREACHABLE)", down.ok === false && down.reason === "AI_UNREACHABLE",
    JSON.stringify(down));

  // --- the key and the other answers a hosted endpoint gives --------------
  const completion = (content) => ({
    status: 200,
    body: { choices: [{ message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) } }] },
  });
  const good = { amount: 12.4, currency: "EUR", date: null, merchant: "Esselunga", type: "expense", direction: "out", account: "Fineco", category: "Spesa", other_account: null };
  const cloudOpts = { url, model: "cloud-model", apiKey: KEY, timeoutMs: 2000 };

  asked = [];
  headersSeen = [];
  respond = () => completion(good);
  logged = "";
  const cloudOut = await readNotification(wallet, { ...cloudOpts, label: "item 6" });
  const cs = asked[0] && asked[0].body;
  record("the model is asked at <base>/chat/completions with the schema as json_schema, at temperature 0",
    asked.length === 1 && asked[0].path === "/chat/completions" && cs.model === "cloud-model" && cs.temperature === 0
      && cs.response_format.type === "json_schema" && cs.response_format.json_schema.strict === false
      && JSON.stringify(cs.response_format.json_schema.schema) === JSON.stringify(req.schema),
    JSON.stringify(cs).slice(0, 300));
  record("it carries the prompt and the question",
    cs.messages[0].role === "system" && cs.messages[0].content === req.system && cs.messages[1].content === req.user);
  record("the key is sent as a Bearer token", headersSeen[0] && headersSeen[0].authorization === `Bearer ${KEY}`);
  record("the key is not in the request body", !JSON.stringify(cs).includes(KEY));
  record("the answer is mapped to a draft as before",
    cloudOut.ok && cloudOut.draft.fromId === 12 && cloudOut.draft.toId === 21 && cloudOut.draft.amount === 12.4,
    JSON.stringify(cloudOut));
  record("the log has neither the key nor the text", !logged.includes(KEY) && !logged.includes("SECRET-CARD-4242") && /item 6: read in/.test(logged), logged);
  record("the result carries no key", !JSON.stringify(cloudOut).includes(KEY));

  headersSeen = [];
  respond = () => completion(good);
  await readNotification(wallet, { ...cloudOpts, apiKey: "", label: "item 6b" });
  record("with no key (a local OpenAI-style server) no Authorization header is sent", headersSeen[0] && !("authorization" in headersSeen[0]));

  respond = () => completion({ kind: "other", amount: null, currency: null, date: null, merchant: null, type: null, account: null, category: null, other_account: null, direction: null });
  logged = "";
  const cloudPromo = await readNotification({ ...wallet, text: "SECRET-CLOUD-PROMO nuova funzione: prova ora" }, { ...cloudOpts, label: "item 6p" });
  record("cloud says other: a skip, and neither the text nor the key is logged",
    cloudPromo.ok === true && cloudPromo.skip === true && !logged.includes("SECRET-CLOUD-PROMO") && !logged.includes(KEY), JSON.stringify(cloudPromo));
  respond = () => completion(good);

  const cloudFailures = [
    ["429 (quota)", () => ({ status: 429, body: { error: { message: `rate limit for ${KEY}` } } }), "AI_RATE_LIMITED"],
    ["a refused key", () => ({ status: 401, body: { error: { message: "bad key" } } }), "AI_AUTH"],
    ["an unknown model", () => ({ status: 404, body: {} }), "AI_MODEL_MISSING"],
    ["a server error", () => ({ status: 503, body: {} }), "AI_HTTP_503"],
    ["malformed JSON in the message", () => completion("{amount: 12,"), "AI_BAD_ANSWER"],
    ["an array in the message", () => completion("[1]"), "AI_BAD_ANSWER"],
    ["no choices", () => ({ status: 200, body: { choices: [] } }), "AI_BAD_ANSWER"],
    ["a body that is not JSON", () => ({ status: 200, body: "<html>" }), "AI_BAD_ANSWER"],
  ];
  for (const [what, answer, code] of cloudFailures) {
    respond = answer;
    logged = "";
    const r = await readNotification(wallet, { ...cloudOpts, label: "item 7" });
    record(`cloud, ${what}: could not be read (${code}), key and text not in the log`,
      r.ok === false && r.reason === code && /item 7: could not be read/.test(logged)
        && !logged.includes(KEY) && !logged.includes("SECRET-CARD-4242") && !JSON.stringify(r).includes(KEY),
      `${JSON.stringify(r)} / ${logged}`);
  }

  // A schema-invalid answer parses as JSON but names nothing the wallet has:
  // it becomes a draft of nulls, never an id from elsewhere.
  respond = () => completion({ amount: "lots", type: "gift", account: "Elsewhere", category: "X", date: "tomorrow-ish" });
  const invalid = await readNotification(wallet, { ...cloudOpts, label: "item 8" });
  record("cloud, an answer that breaks the schema: every field null, no foreign id",
    invalid.ok && invalid.draft.amount === null && invalid.draft.typeId === null && invalid.draft.fromId === null
      && invalid.draft.toId === null && invalid.draft.date === null,
    JSON.stringify(invalid));

  respond = () => "hang";
  const cloudLate = await readNotification(wallet, { ...cloudOpts, timeoutMs: 300, label: "item 9" });
  record("cloud, silence until the timeout: AI_TIMEOUT", cloudLate.ok === false && cloudLate.reason === "AI_TIMEOUT");

  // --- the queue -------------------------------------------------------------
  let running = 0;
  let most = 0;
  const done = [];
  const q = createQueue(async (job) => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 20));
    running -= 1;
    if (job.id === 2) throw new Error("boom");
    done.push(job.id);
  });
  for (const id of [1, 2, 3, 3, 4]) q.push({ id });
  await q.idle();
  record("the queue runs one job at a time, in order, once per id, and survives a failure",
    most === 1 && JSON.stringify(done) === "[1,3,4]", `most ${most}, done ${JSON.stringify(done)}`);

  // --- the bank names setting ----------------------------------------------
  const cases = [
    [["Marco Todaro", " TODARO  MARCO "], ["Marco Todaro", "TODARO MARCO"]],
    ["Marco Todaro, TODARO MARCO, marco todaro", ["Marco Todaro", "TODARO MARCO"]],
    [[], []],
    ["", []],
    [["a", "b", "c", "d", "e", "f"], null],
    [["x".repeat(81)], null],
    [[42], null],
    [{ names: 1 }, null],
  ];
  const badNames = cases.filter(([v, want]) => JSON.stringify(parseNames(v)) !== JSON.stringify(want));
  record("bank names: at most five, each at most 80 characters, trimmed, once each", !badNames.length, JSON.stringify(badNames));

  // --- accepting an item read in another currency ---------------------------
  // POST /api/inbox/:id/accept with the database and the transaction insert
  // stubbed: an item whose reading found USD, in an EUR wallet, is refused
  // with 409 INBOX_CURRENCY_MISMATCH before any transaction is created (the
  // real request's transaction then rolls back and the item stays pending).
  // The same currency, in any case, and no currency at all are accepted.
  {
    const db = require("../dbConn");
    const transactionsController = require("../controllers/transactions_controller");
    const inbox = require("../controllers/inbox_controller");
    const realQuery = db.query;
    const realInsert = transactionsController.insertTransaction;
    let itemCurrency = null;
    let inserted = 0;
    db.query = async (text) =>
      /update inbox_items\s+set status/.test(text)
        ? { rows: [{ has_text: false, currency: itemCurrency }], rowCount: 1 }
        : { rows: [], rowCount: 1 };
    transactionsController.insertTransaction = async () => {
      inserted += 1;
      return 99;
    };
    const acceptAs = async (currency) => {
      itemCurrency = currency;
      try {
        return await inbox.accept({ params: { id: "7" }, body: {}, user: { wallet: { currency: "EUR" } } });
      } catch (error) {
        return error;
      }
    };
    const refused = await acceptAs("USD");
    record("accept: an item read in USD, in an EUR wallet, is refused (409 INBOX_CURRENCY_MISMATCH) and nothing is inserted",
      refused instanceof Error && refused.status === 409 && refused.code === "INBOX_CURRENCY_MISMATCH" && inserted === 0,
      `${refused && refused.code} inserted=${inserted}`);
    const same = await acceptAs("eur");
    const none = await acceptAs(null);
    record("accept: the wallet's currency (any case) or no currency is accepted",
      same && same.transaction_id === 99 && none && none.transaction_id === 99 && inserted === 2,
      `${JSON.stringify(same)} ${JSON.stringify(none)} inserted=${inserted}`);
    db.query = realQuery;
    transactionsController.insertTransaction = realInsert;
  }

  record("nothing left this machine", offMachine === 0, `${offMachine} requests`);

  server.close();
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((error) => {
  process.stdout.write(`crashed: ${error.stack}\n`);
  process.exit(1);
});
