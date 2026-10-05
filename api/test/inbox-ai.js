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
// runs one job at a time and survives a failing one; POST /api/inbox answers a
// body that explains itself (and never echoes the text), and its refusals say
// what to do; a reading that fails for a passing reason (429, 5xx, timeout,
// endpoint down) is tried again on the backoff, Retry-After obeyed, and only
// the last failure, or one waiting cannot mend, leaves the item 'failed' and
// is announced; the scheduler's claim queues each due item once; a clientId
// already seen answers 200 "duplicate" with the first item and stores nothing,
// also when two copies race.
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
  parseRetryAfter,
} = require("../services/inbox/extract");
const { createQueue } = require("../services/inbox/queue");
const { nextDelayMs, BACKOFF_MS, MAX_ATTEMPTS } = require("../services/inbox/retry");
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
    res.writeHead(answer.status, { "content-type": "application/json", ...(answer.headers || {}) });
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
    ["429 (quota)", () => ({ status: 429, body: { error: { message: `rate limit for ${KEY}` } } }), "AI_RATE_LIMITED", true],
    ["a refused key", () => ({ status: 401, body: { error: { message: "bad key" } } }), "AI_AUTH", false],
    ["a forbidden key", () => ({ status: 403, body: {} }), "AI_AUTH", false],
    ["an unknown model", () => ({ status: 404, body: {} }), "AI_MODEL_MISSING", false],
    ["a server error", () => ({ status: 503, body: {} }), "AI_HTTP_503", true],
    ["a bad request", () => ({ status: 400, body: {} }), "AI_HTTP_400", false],
    ["malformed JSON in the message", () => completion("{amount: 12,"), "AI_BAD_ANSWER", false],
    ["an array in the message", () => completion("[1]"), "AI_BAD_ANSWER", false],
    ["no choices", () => ({ status: 200, body: { choices: [] } }), "AI_BAD_ANSWER", false],
    ["a body that is not JSON", () => ({ status: 200, body: "<html>" }), "AI_BAD_ANSWER", false],
  ];
  for (const [what, answer, code, transient] of cloudFailures) {
    respond = answer;
    logged = "";
    const r = await readNotification(wallet, { ...cloudOpts, label: "item 7" });
    record(`cloud, ${what}: could not be read (${code}), ${transient ? "worth trying again" : "not worth trying again"}, key and text not in the log`,
      r.ok === false && r.reason === code && r.transient === transient && /item 7: could not be read/.test(logged)
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
  record("cloud, silence until the timeout: AI_TIMEOUT, worth trying again",
    cloudLate.ok === false && cloudLate.reason === "AI_TIMEOUT" && cloudLate.transient === true);
  const cloudDown = await readNotification(wallet, { ...cloudOpts, url: "http://127.0.0.1:1", label: "item 9b" });
  record("cloud, nobody listening: AI_UNREACHABLE, worth trying again",
    cloudDown.ok === false && cloudDown.reason === "AI_UNREACHABLE" && cloudDown.transient === true);

  // --- Retry-After and the backoff ------------------------------------------
  respond = () => ({ status: 429, headers: { "retry-after": "90" }, body: {} });
  const told = await readNotification(wallet, { ...cloudOpts, label: "item 10" });
  record("a 429 with Retry-After: 90 carries 90 s to wait",
    told.ok === false && told.reason === "AI_RATE_LIMITED" && told.retryAfterMs === 90000, JSON.stringify(told));
  const NOW = Date.parse("2026-10-05T10:00:00Z");
  const retryAfters = [
    ["120", 120000], ["0", null], ["", null], ["soon", null], [null, null],
    ["Mon, 05 Oct 2026 10:05:00 GMT", 300000], ["Mon, 05 Oct 2026 09:00:00 GMT", null],
  ];
  const badRetryAfter = retryAfters.filter(([v, want]) => parseRetryAfter(v, NOW) !== want);
  record("Retry-After: seconds or an HTTP date, a moment past or nonsense is nothing", !badRetryAfter.length, JSON.stringify(badRetryAfter));
  const MIN = 60000;
  record("the backoff: 1 min, 5 min, 30 min, 2 h, then no more (five readings in all)",
    JSON.stringify(BACKOFF_MS) === JSON.stringify([MIN, 5 * MIN, 30 * MIN, 120 * MIN]) && MAX_ATTEMPTS === 5
      && nextDelayMs(1) === MIN && nextDelayMs(2) === 5 * MIN && nextDelayMs(3) === 30 * MIN && nextDelayMs(4) === 120 * MIN
      && nextDelayMs(5) === null && nextDelayMs(0) === null);
  record("Retry-After counts when it asks for longer than the table, capped at 2 h; shorter, the table wins",
    nextDelayMs(1, 10 * MIN) === 10 * MIN && nextDelayMs(1, 10 * 3600 * 1000) === 120 * MIN
      && nextDelayMs(3, MIN) === 30 * MIN && nextDelayMs(5, MIN) === null);

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

  // --- what POST /api/inbox answers ------------------------------------------
  // The controller with the database stubbed: the 201 body has to explain
  // itself to an automation app that only saves the status and the body, keep
  // { id } for older senders, and never echo the notification's text.
  {
    const db = require("../dbConn");
    const inbox = require("../controllers/inbox_controller");
    const realQuery = db.query;
    db.query = async (text) => (/insert into inbox_items/.test(text) ? { rows: [{ id: 42 }], rowCount: 1 } : { rows: [], rowCount: 0 });
    const fakeRes = () => ({ statusCode: 200, once() {}, status(code) { this.statusCode = code; return this; } });
    const post = async (body) => {
      const res = fakeRes();
      try {
        return { res, out: await inbox.createItem({ body, token: { walletId: 1, userId: 1 } }, res) };
      } catch (error) {
        return { res, error };
      }
    };

    process.env.BUSSOLA_AI_URL = url;
    process.env.BUSSOLA_AI_MODEL = "test-model";
    const textOnly = await post({ source: "Revolut", text: `  ${TEXT}  ` });
    const t = textOnly.out || {};
    record("POST /api/inbox, text: 201 with id, status, what was received, that it is queued, the source and a message",
      textOnly.res.statusCode === 201 && t.id === 42 && t.status === "pending" && t.reading === "queued"
        && t.source === "Revolut" && t.received && t.received.kind === "text" && t.received.chars === TEXT.length
        && typeof t.message === "string" && /42/.test(t.message) && /background/.test(t.message),
      JSON.stringify(textOnly.out || textOnly.error));
    record("POST /api/inbox, text: the answer never carries the notification's text",
      !JSON.stringify(t).includes("SECRET-CARD-4242") && !JSON.stringify(t).includes("Marco Todaro"));

    const drafted = await post({ draft: { amount: 12.4, description: "Esselunga" } });
    const d = drafted.out || {};
    record("POST /api/inbox, draft: 201, no reading needed, source defaults to api",
      drafted.res.statusCode === 201 && d.id === 42 && d.reading === "not_needed" && d.received.kind === "draft"
        && d.received.chars === 0 && d.source === "api" && /draft/.test(d.message),
      JSON.stringify(drafted.out || drafted.error));

    const empty = await post({ source: "x", text: "   " });
    record("POST /api/inbox, nothing to read: 400 INBOX_EMPTY that says how to send it",
      empty.error && empty.error.status === 400 && empty.error.code === "INBOX_EMPTY" && /text\/plain/.test(empty.error.message),
      String(empty.error && empty.error.message));

    delete process.env.BUSSOLA_AI_URL;
    delete process.env.BUSSOLA_AI_MODEL;
    const off = await post({ source: "x", text: TEXT });
    record("POST /api/inbox, no model: 409 AI_DISABLED that says nothing was kept and why",
      off.error && off.error.status === 409 && off.error.code === "AI_DISABLED" && /Not kept/.test(off.error.message)
        && /BUSSOLA_AI_URL/.test(off.error.message),
      String(off.error && off.error.message));
    db.query = realQuery;
  }

  // --- a reading tried again: readItem against a row in memory ----------------
  // The database is a few rows in memory that answer the controller's
  // statements the way Postgres would for one wallet; the model is the fake
  // endpoint above, reached through BUSSOLA_AI_URL as in production. What is
  // checked is the controller's decision after each answer, and who is told.
  {
    const db = require("../dbConn");
    const notifier = require("../services/notify");
    const inbox = require("../controllers/inbox_controller");
    const real = { query: db.query, withTenant: db.withTenant, queryAuth: db.queryAuth, enabled: notifier.enabled, notify: notifier.notify };
    process.env.BUSSOLA_AI_URL = url;
    process.env.BUSSOLA_AI_MODEL = "test-model";
    delete process.env.BUSSOLA_AI_API_KEY;

    let rows = [];
    const announced = [];
    notifier.enabled = () => true;
    notifier.notify = (n) => announced.push(n.kind);
    db.withTenant = async (_t, fn) => fn();
    db.queryAuth = async (text) =>
      /wallet_members/.test(text) ? { rows: [{ id: 1, writers: [1] }] } : { rows: [{ bank_names: [], currency: "EUR" }] };
    const due = (r, fresh) => r.status === "pending" && r.extraction === "pending"
      && (r.next == null ? fresh : r.next <= Date.now());
    db.query = async (text, params = []) => {
      const live = (id) => rows.find((r) => r.id === id && r.status === "pending" && r.extraction === "pending");
      if (/select raw_text, source, attempts/.test(text)) {
        const r = live(params[0]);
        return { rows: r && r.raw_text ? [{ raw_text: r.raw_text, source: "Revolut", attempts: r.attempts, today: "2026-09-29" }] : [] };
      }
      if (/select id, name from accounts where is_account/.test(text)) return { rows: wallet.accounts };
      if (/type_id = 1/.test(text) && /select id, name/.test(text)) return { rows: wallet.expenseCategories };
      if (/type_id = 2/.test(text) && /select id, name/.test(text)) return { rows: wallet.incomeCategories };
      if (/select id, type_id, is_account from accounts/.test(text)) return { rows: [] };
      if (/set attempts = attempts \+ 1, next_attempt_at = now\(\)/.test(text)) {
        const r = live(params[0]);
        if (!r) return { rowCount: 0, rows: [] };
        r.attempts += 1;
        r.next = Date.now() + params[1];
        r.delay = params[1];
        return { rowCount: 1, rows: [] };
      }
      if (/set extraction = 'failed'/.test(text)) {
        const r = live(params[0]);
        if (!r) return { rowCount: 0, rows: [] };
        Object.assign(r, { extraction: "failed", attempts: r.attempts + 1, next: null });
        return { rowCount: 1, rows: [] };
      }
      if (/set extraction = 'done'/.test(text)) {
        const r = live(params[0]);
        if (!r) return { rowCount: 0, rows: [] };
        Object.assign(r, { extraction: "done", next: null });
        return { rowCount: 1, rows: [] };
      }
      if (/for update skip locked/.test(text)) {
        // The claim, as one statement: due rows take the lease and are
        // returned; the next look finds them no longer due.
        const fresh = /next_attempt_at is null/.test(text);
        await new Promise((r) => setImmediate(r));
        const claimed = rows.filter((r) => due(r, fresh));
        for (const r of claimed) r.next = Date.now() + params[0];
        return { rows: claimed.map((r) => ({ id: r.id, created_by: 1 })), rowCount: claimed.length };
      }
      return { rows: [], rowCount: 0 };
    };
    const item = (id, extra = {}) => {
      const r = { id, status: "pending", extraction: "pending", raw_text: TEXT, attempts: 0, next: null, ...extra };
      rows.push(r);
      return r;
    };
    const readOnce = async (id) => {
      announced.length = 0;
      logged = "";
      await inbox._readItem({ id, walletId: 1, userId: 1 });
      await new Promise((r) => setTimeout(r, 20));
    };
    const near = (r, ms) => r.next != null && Math.abs(r.next - Date.now() - ms) < 3000;

    const a = item(101);
    respond = () => ({ status: 429, body: {} });
    await readOnce(101);
    record("a 429: still pending, attempts 1, next try in a minute, nobody told",
      a.extraction === "pending" && a.attempts === 1 && near(a, MIN) && announced.length === 0, JSON.stringify(a));
    record("the log says when it is tried again, and has no text",
      /inbox item 101: attempt 1 of 5 failed, next in 60 s/.test(logged) && !logged.includes("SECRET-CARD-4242"), logged);

    respond = () => ({ status: 429, headers: { "retry-after": "600" }, body: {} });
    await readOnce(101);
    record("a second 429 that asks for 10 minutes: Retry-After wins over the table's 5",
      a.extraction === "pending" && a.attempts === 2 && a.delay === 10 * MIN && announced.length === 0, JSON.stringify(a));

    respond = () => chat({ kind: "transaction", amount: 12.4, currency: "EUR", date: null, merchant: "Esselunga", type: "expense", account: "Fineco", category: "Spesa", other_account: null, direction: "out" });
    await readOnce(101);
    record("then the model answers: read, nothing scheduled, the draft announced once",
      a.extraction === "done" && a.next === null && a.attempts === 2 && JSON.stringify(announced) === '["ready"]', `${JSON.stringify(a)} ${JSON.stringify(announced)}`);

    const b = item(102);
    respond = () => ({ status: 401, body: {} });
    await readOnce(102);
    record("a 401: failed at once, nothing scheduled, the failure announced",
      b.extraction === "failed" && b.attempts === 1 && b.next === null && JSON.stringify(announced) === '["unread"]', `${JSON.stringify(b)} ${JSON.stringify(announced)}`);

    const c = item(103);
    respond = () => chat("{not json");
    await readOnce(103);
    record("an answer that is not JSON: failed at once", c.extraction === "failed" && c.attempts === 1 && announced.length === 1);

    const d = item(104, { attempts: 3 });
    respond = () => ({ status: 503, body: {} });
    await readOnce(104);
    record("a 503 at the fourth reading: pending, two hours to wait, nobody told",
      d.extraction === "pending" && d.attempts === 4 && d.delay === 120 * MIN && announced.length === 0, JSON.stringify(d));
    await readOnce(104);
    record("a 503 at the fifth and last: failed, and only now announced",
      d.extraction === "failed" && d.attempts === 5 && d.next === null && JSON.stringify(announced) === '["unread"]', `${JSON.stringify(d)} ${JSON.stringify(announced)}`);

    process.env.BUSSOLA_AI_URL = "http://127.0.0.1:1";
    const e = item(105);
    await readOnce(105);
    record("the endpoint down: pending, tried again in a minute", e.extraction === "pending" && e.attempts === 1 && near(e, MIN), JSON.stringify(e));
    process.env.BUSSOLA_AI_URL = url;

    const f = item(106, { status: "dismissed", raw_text: null });
    respond = () => ({ status: 429, body: {} });
    await readOnce(106);
    record("an item dismissed meanwhile is not read nor scheduled", f.attempts === 0 && f.next === null);

    // The scheduler's claim. Due: 107 and 108 (their time has come); not due:
    // 109 (later), 110 (just received: its receiver has it), 101 (read). Two
    // looks at once queue each due item once, and the fresh look of a start
    // also takes 110.
    rows = [];
    item(107, { attempts: 1, next: Date.now() - 1000 });
    item(108, { attempts: 2, next: Date.now() - 5 });
    item(109, { attempts: 1, next: Date.now() + MIN });
    item(110);
    item(101, { extraction: "done" });
    const queue = inbox._queue();
    const realPush = queue.push;
    const pushed = [];
    queue.push = (job) => pushed.push(job.id);
    const [one, two] = await Promise.all([inbox._claimDue(), inbox._claimDue()]);
    record("two looks at once: each due item is claimed and queued once, nothing else",
      one + two === 2 && JSON.stringify([...pushed].sort()) === "[107,108]", `${one}+${two} ${JSON.stringify(pushed)}`);
    record("a claimed item holds a lease: it is not due again for a while",
      rows.filter((r) => [107, 108].includes(r.id)).every((r) => r.next > Date.now() + 5 * MIN));
    pushed.length = 0;
    const atStart = await inbox._claimDue({ fresh: true });
    record("at start, the item just received (no schedule) is taken too, the scheduled ones wait",
      atStart === 1 && JSON.stringify(pushed) === "[110]", JSON.stringify(pushed));
    queue.push = realPush;

    // --- clientId: the same notification twice -----------------------------
    // The table, keyed as the unique index is: (wallet, client_id). The
    // insert is ON CONFLICT DO NOTHING, so a conflicting copy gets no row.
    const table = [];
    let nextId = 500;
    let inserts = 0;
    db.query = async (text, params = []) => {
      await new Promise((r) => setImmediate(r));
      if (/insert into inbox_items/.test(text)) {
        inserts += 1;
        const clientId = params[12];
        if (!/on conflict \(wallet_id, client_id\) where client_id is not null do nothing/.test(text)) throw new Error("no ON CONFLICT");
        if (clientId != null && table.some((r) => r.client_id === clientId)) return { rows: [], rowCount: 0 };
        const row = { id: nextId++, source: params[0], status: "pending", extraction: params[11], attempts: 0, client_id: clientId };
        table.push(row);
        return { rows: [{ id: row.id }], rowCount: 1 };
      }
      if (/from inbox_items where client_id = \$1/.test(text)) {
        const r = table.find((x) => x.client_id === params[0]);
        return { rows: r ? [{ id: r.id, source: r.source, status: r.status, extraction: r.extraction, attempts: r.attempts }] : [] };
      }
      return { rows: [], rowCount: 0 };
    };
    const send = async ({ body = {}, query = {}, headers = {} }) => {
      const listeners = [];
      const res = { statusCode: 200, once: (ev) => listeners.push(ev), status(code) { this.statusCode = code; return this; } };
      const req = { body, query, token: { walletId: 1, userId: 1 }, get: (h) => headers[h.toLowerCase()] };
      try {
        return { res, listeners, out: await inbox.createItem(req, res) };
      } catch (error) {
        return { res, listeners, error };
      }
    };

    const first = await send({ body: { source: "Revolut", text: TEXT, clientId: "  notif-1 " } });
    record("clientId: the first POST is 201, stored with the id trimmed, and queued",
      first.res.statusCode === 201 && first.out.id === 500 && !first.out.duplicate && table[0].client_id === "notif-1"
        && first.listeners.includes("finish"), JSON.stringify(first.out || first.error));
    const again = await send({ body: { source: "Revolut", text: TEXT }, query: { clientId: "notif-1" } });
    const ag = again.out || {};
    record("the same clientId again (in the query): 200, duplicate, the same item, nothing stored or queued",
      again.res.statusCode === 200 && ag.duplicate === true && ag.id === 500 && ag.status === "pending" && ag.reading === "queued"
        && ag.source === "Revolut" && ag.received && ag.received.kind === "text" && ag.received.chars === TEXT.length
        && /Already received/.test(ag.message) && table.length === 1 && again.listeners.length === 0,
      JSON.stringify(again.out || again.error));
    record("the duplicate's answer never carries the text", !JSON.stringify(ag).includes("SECRET-CARD-4242"));

    table[0].status = "accepted";
    table[0].extraction = "done";
    const late = await send({ body: { text: TEXT }, headers: { "x-bussola-client-id": "notif-1" } });
    record("a late copy (in the header) of an item already accepted: 200, duplicate, status accepted, not brought back",
      late.res.statusCode === 200 && late.out.duplicate === true && late.out.status === "accepted" && late.out.reading === "done"
        && table.length === 1, JSON.stringify(late.out || late.error));

    delete process.env.BUSSOLA_AI_URL;
    const offDup = await send({ body: { text: TEXT, clientId: "notif-1" } });
    record("a duplicate is answered as one even when the model has been switched off since",
      offDup.res.statusCode === 200 && offDup.out && offDup.out.duplicate === true, JSON.stringify(offDup.out || offDup.error));
    process.env.BUSSOLA_AI_URL = url;

    inserts = 0;
    const racing = await Promise.all([
      send({ body: { draft: { amount: 5 }, clientId: "race" } }),
      send({ body: { draft: { amount: 5 }, clientId: "race" } }),
    ]);
    const codes = racing.map((r) => r.res.statusCode).sort();
    record("two identical POSTs racing: both get past the first look, one row, one 201 and one 200 duplicate of it",
      inserts === 2 && table.filter((r) => r.client_id === "race").length === 1 && JSON.stringify(codes) === "[200,201]"
        && racing[0].out.id === racing[1].out.id && racing.some((r) => r.out.duplicate === true),
      JSON.stringify(racing.map((r) => r.out || r.error)));

    const before = table.length;
    const bad = [];
    for (const clientId of ["", "   ", "x".repeat(101), 42, ["a", "b"]]) {
      const r = await send({ body: { text: TEXT, clientId } });
      if (!(r.error && r.error.status === 400 && r.error.code === "INVALID_CLIENT_ID")) bad.push([clientId, r.error && r.error.code]);
    }
    const arr = await send({ body: { text: TEXT }, query: { clientId: ["a", "b"] } });
    if (!(arr.error && arr.error.code === "INVALID_CLIENT_ID")) bad.push(["query array", arr.error && arr.error.code]);
    record("an empty, blank, too long or non-text clientId: 400 INVALID_CLIENT_ID, nothing stored",
      !bad.length && table.length === before, JSON.stringify(bad));
    const ok100 = await send({ body: { draft: { amount: 1 }, clientId: "y".repeat(100) } });
    record("a clientId of 100 characters is taken", ok100.res.statusCode === 201);
    const none = await send({ body: { draft: { amount: 1 } } });
    const none2 = await send({ body: { draft: { amount: 1 } } });
    record("no clientId: every POST is stored, as before", none.res.statusCode === 201 && none2.res.statusCode === 201 && none.out.id !== none2.out.id);

    Object.assign(db, { query: real.query, withTenant: real.withTenant, queryAuth: real.queryAuth });
    Object.assign(notifier, { enabled: real.enabled, notify: real.notify });
    delete process.env.BUSSOLA_AI_URL;
    delete process.env.BUSSOLA_AI_MODEL;
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
