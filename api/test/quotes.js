// ---------------------------------------------------------------------------
// The quote client, without the network
// ---------------------------------------------------------------------------
// Runs on its own, no stack needed:
//
//   node api/test/quotes.js
//
// A local HTTP server plays the quotes service of BUSSOLA_QUOTES_URL. What it
// checks is when quotes are on and the refusals: without a URL they are off
// and nothing is asked; the service is sent the three parameters and no
// Authorization header; anything it cannot answer properly -- an error status,
// a 429, a price in another currency, a price that is not a number, silence
// until the timeout -- is "no quote"; and the one answer that says why comes
// back as such: CURRENCY_UNSUPPORTED.
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

const { lookupQuote, quotesEnabled, probeQuotes } = require("../services/quotes");
const { TIMEOUT_MS } = require("../services/quotes/shared");

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

// What the fake service answers next, and what it was asked.
let respond = () => ({ status: 200, body: {} });
let asked = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  asked.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization });
  const answer = respond(url);
  if (answer === "hang") return; // never answers: the timeout has to end it
  res.writeHead(answer.status, { "content-type": "application/json", ...(answer.headers || {}) });
  res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
});

const ETF = { isin: "XX0000000001", typeCode: "ETF", currency: "EUR" };

const main = async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The base address: the client adds /v1/quote.
  const serviceUrl = `http://127.0.0.1:${server.address().port}/quotes`;
  const reset = () => {
    asked = [];
    offMachine = 0;
  };

  // --- no service configured ------------------------------------------------
  delete process.env.BUSSOLA_QUOTES_URL;
  reset();
  let q = await lookupQuote(ETF);
  record("without a URL, quotes are off and nothing is asked",
    !quotesEnabled() && q.price === null && q.source === null && asked.length === 0 && offMachine === 0,
    JSON.stringify(q));

  process.env.BUSSOLA_QUOTES_URL = "  ";
  record("a blank value counts as unset", !quotesEnabled());

  process.env.BUSSOLA_QUOTES_URL = serviceUrl;
  record("a URL turns them on", quotesEnabled());

  // --- the service answers ----------------------------------------------------
  reset();
  respond = () => ({ status: 200, body: { price: 42.5, currency: "EUR", change: -0.4, symbol: "MIL" } });
  q = await lookupQuote(ETF);
  record("the service's price is used",
    q.source === "http" && q.price === 42.5 && q.quoteCurrency === "EUR" && q.change === -0.4 && q.symbol === "MIL",
    JSON.stringify(q));
  record("no Authorization header is sent, and nothing leaves the machine",
    asked.length === 1 && asked[0].authorization === undefined && offMachine === 0, JSON.stringify(asked));
  record("at /v1/quote under the configured base, which keeps its own path",
    asked.length === 1 && asked[0].path === "/quotes/v1/quote", JSON.stringify(asked));
  record("and the id, the type code and the wallet's currency",
    asked.length === 1 && asked[0].query.id === ETF.isin && asked[0].query.type === "ETF"
      && asked[0].query.currency === "EUR", JSON.stringify(asked));

  reset();
  respond = () => ({ status: 200, body: { price: 60000, currency: "USD" } });
  q = await lookupQuote({ isin: "BTC-EUR", typeCode: "CRYPTO", currency: "usd" });
  record("the currency asked is the wallet's, upper-cased, crypto included",
    q.source === "http" && asked[0].query.currency === "USD" && asked[0].query.type === "CRYPTO"
      && asked[0].query.id === "BTC-EUR", JSON.stringify({ q, asked }));

  reset();
  respond = () => ({ status: 200, body: { price: 1, currency: "EUR" } });
  q = await lookupQuote({ isin: ETF.isin, currency: "EUR" });
  record("no type is sent when there is none",
    q.price === 1 && asked.length === 1 && !("type" in asked[0].query),
    JSON.stringify(asked));

  // --- what the service cannot answer is no quote -----------------------------
  const noQuote = async (label, answer, args = ETF) => {
    reset();
    respond = () => answer;
    const quote = await lookupQuote(args);
    record(label, asked.length === 1 && quote.price === null && quote.source === null && !quote.unsupportedCurrency,
      JSON.stringify(quote));
  };
  await noQuote("an error status is no quote", { status: 500, body: { error: "down" } });
  await noQuote("so is a 404 for an instrument it does not know", { status: 404, body: {} });
  await noQuote("a 401 is no quote", { status: 401, body: { error: "UNAUTHORIZED" } });
  await noQuote("a 429 is just no quote", { status: 429, body: { error: "RATE_LIMITED" }, headers: { "retry-after": "3600" } });
  await noQuote("a price in another currency is refused", { status: 200, body: { price: 42.5, currency: "USD" } });
  await noQuote("a price with no currency is refused too", { status: 200, body: { price: 42.5 } });
  await noQuote("a price that is not a number is ignored", { status: 200, body: { price: "n/a", currency: "EUR" } });
  await noQuote("a zero or negative price is ignored", { status: 200, body: { price: 0, currency: "EUR" } });
  await noQuote("a body that is not JSON is ignored", { status: 200, body: "<html>maintenance</html>" });
  await noQuote("an error body that is not JSON is ignored", { status: 502, body: "<html>bad gateway</html>" });

  reset();
  respond = () => ({ status: 422, body: { error: "CURRENCY_UNSUPPORTED" } });
  q = await lookupQuote({ isin: ETF.isin, typeCode: "ETF", currency: "jpy" });
  record("CURRENCY_UNSUPPORTED says so, in the currency that was asked",
    q.price === null && q.unsupportedCurrency === "JPY", JSON.stringify(q));

  process.env.BUSSOLA_QUOTES_URL = "not a url";
  reset();
  q = await lookupQuote(ETF);
  record("a malformed BUSSOLA_QUOTES_URL is skipped, not fatal",
    q.price === null && asked.length === 0 && offMachine === 0, JSON.stringify(q));
  process.env.BUSSOLA_QUOTES_URL = serviceUrl;

  // --- a service that never answers -------------------------------------------
  reset();
  respond = () => "hang";
  const started = Date.now();
  q = await lookupQuote(ETF);
  const waited = Date.now() - started;
  record(`a service that never answers is given up after ${TIMEOUT_MS / 1000} s`,
    q.price === null && waited >= TIMEOUT_MS - 500 && waited < TIMEOUT_MS + 3000,
    `waited ${waited} ms: ${JSON.stringify(q)}`);

  // --- opt-in: nothing answering means off, an answer (any) means on ----------
  const real = process.env.BUSSOLA_QUOTES_URL;
  record("before any look the service is taken as there", quotesEnabled() === true);
  process.env.BUSSOLA_QUOTES_URL = "http://127.0.0.1:1";
  await probeQuotes();
  record("nothing answering at the address: quotes are off (the container was not started)", quotesEnabled() === false);
  const none = await lookupQuote(ETF);
  record("and a lookup does not even try", none.price === null);
  process.env.BUSSOLA_QUOTES_URL = real;
  respond = () => ({ status: 404, body: {} });
  await probeQuotes();
  record("any HTTP answer, even 404 for /v1/sources, means it is there: quotes are on", quotesEnabled() === true);

  server.closeAllConnections();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
