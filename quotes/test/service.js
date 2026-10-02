// ============================================================================
// The service, without the network
// ============================================================================
//   node test/service.js      (npm test)
//
// Fake CoinGecko, OpenFIGI, Twelve Data and Eulerpool on one local port stand
// in for the real ones (COINGECKO_BASE_URL, OPENFIGI_BASE_URL,
// TWELVEDATA_BASE_URL, EULERPOOL_BASE_URL). The first half runs the real
// providers against them: routing, the contract's shape, CoinGecko's optional
// Demo key, Twelve Data's path (OpenFIGI -> symbol_search -> quote) and its
// 24 h listing cache, the fall-through to Eulerpool (quota used up, no
// listing in the currency, an ISIN OpenFIGI does not know), a provider with
// no key being skipped, the currency refusal, a refused key logged once, and
// that a spent quota is not negative-cached. The second half replaces the
// providers with a stub and checks what sits in front of them: the cache, the
// negative cache, the de-duplication, the cap on concurrent lookups. And
// throughout, that no log line names an instrument or carries a secret.
//
// The Eulerpool shapes served here are the live API's (checked 2026-09-29):
// stocks from market/quotes/exchanges, ETFs from etf/profile + etf/quotes.
// Part 1 asks Twelve Data first (QUOTES_STOCK_ORDER), to exercise the
// fall-through; the default order, Eulerpool first, has its own tests.
// ============================================================================
const assert = require("node:assert");
const http = require("node:http");

// Every log line, the service's and the providers' console.log alike.
const logs = [];
const print = (line) => process.stdout.write(`${line}\n`);
console.log = (...args) => logs.push(args.map(String).join(" "));

const { start } = require("../src/service");
const { setLookup } = require("../src/quotes");
const { clearTwelveData } = require("../providers/twelvedata");
const { clearFigi } = require("../providers/openfigi");
const { forgetSaid } = require("../providers/shared");
const { clearEulerpoolCache } = require("../providers/eulerpool");
const { clearEodhd } = require("../providers/eodhd");

const clearProviders = () => {
  clearEulerpoolCache();
  clearTwelveData();
  clearEodhd();
  clearFigi();
  forgetSaid();
};

const results = [];
const test = async (name, fn) => {
  try {
    await fn();
    results.push(true);
    print(`  ok    ${name}`);
  } catch (e) {
    results.push(false);
    print(`  FAIL  ${name}\n        ${e.message}`);
  }
};

// ---------------------------------------------------------------------------
// The fake upstreams
// ---------------------------------------------------------------------------
const TD_KEY = "td-key-secret-1234";
const BAD_TD_KEY = "td-key-refused-5678";
const EP_KEY = "ep-key-secret-1234";
const BAD_EP_KEY = "ep-key-refused-5678";
const EOD_KEY = "eod-key-secret-1234";
const BAD_EOD_KEY = "eod-key-refused-5678";
const FIGI_KEY = "figi-key-secret-1234";
const CG_KEY = "cg-demo-key-secret";

const upstream = [];
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

// OpenFIGI: ISIN -> listings.
const FIGI = {
  IE00B4L5Y983: [
    { figi: "BBG1", ticker: "SWDA", exchCode: "LN", name: "ISHARES CORE MSCI WORLD", securityType: "ETP", marketSector: "Equity" },
    { figi: "BBG2", ticker: "EUNL", exchCode: "GY", name: "ISHARES CORE MSCI WORLD", securityType: "ETP", marketSector: "Equity" },
    { figi: "BBG3", ticker: "IWDA", exchCode: "NA", name: "ISHARES CORE MSCI WORLD", securityType: "ETP", marketSector: "Equity" },
  ],
  DE0000000003: [{ figi: "BBG4", ticker: "CUR", exchCode: "US", marketSector: "Equity" }],
  GB0000000012: [{ figi: "BBG6", ticker: "PNC", exchCode: "LN", marketSector: "Equity" }],
  US0000000002: [{ figi: "BBG5", ticker: "ONLY", exchCode: "US", marketSector: "Equity" }],
};
// Twelve Data: symbol_search by ticker, quote by symbol + MIC.
const SEARCH = {
  EUNL: [
    { symbol: "EUNL", instrument_name: "iShares Core MSCI World", exchange: "OTC", mic_code: "OTCM", currency: "USD" },
    { symbol: "EUNL", instrument_name: "iShares Core MSCI World", exchange: "FSX", mic_code: "XFRA", currency: "EUR" },
    { symbol: "EUNL", instrument_name: "iShares Core MSCI World", exchange: "XETR", mic_code: "XETR", currency: "EUR" },
    { symbol: "EUNLX", instrument_name: "Something else", exchange: "XETR", mic_code: "XETR", currency: "EUR" },
  ],
  CUR: [{ symbol: "CUR", exchange: "NASDAQ", mic_code: "XNAS", currency: "USD" }],
  ONLY: [{ symbol: "ONLY", exchange: "NYSE", mic_code: "XNYS", currency: "USD" }],
  // London quotes in pence: GBp is not GBP.
  PNC: [{ symbol: "PNC", exchange: "LSE", mic_code: "XLON", currency: "GBp" }],
};
const QUOTE = {
  "PNC|XLON": { symbol: "PNC", exchange: "LSE", mic_code: "XLON", currency: "GBp", close: "1234.5" },
  "EUNL|XETR": { symbol: "EUNL", name: "iShares Core MSCI World", exchange: "XETR", mic_code: "XETR", currency: "EUR", close: "98.31", percent_change: "-0.4211" },
};
// Eulerpool, in the live API's shapes: stocks per exchange; an ETF is 404
// there and has a profile listing its tickers, and a daily series per ticker.
const EP_EXCHANGES = {
  DE0000000003: { primary: "XETRA", exchanges: [{ exchange: "Xetra", source: "x", currency: "EUR", bid: 10.4, ask: 10.6, timestamp: 1 }] },
  US0000000002: { primary: "NYSE", exchanges: [{ exchange: "NYSE", source: "x", currency: "USD", bid: 5, ask: 5, timestamp: 1 }] },
  // No buyer on Xetra: a bid of 0 is no bid, not half the price.
  DE0000000011: { primary: "XETRA", exchanges: [{ exchange: "Xetra", source: "x", currency: "EUR", bid: 0, ask: 20, timestamp: 1 }] },
};
const EP_PROFILES = {
  IE00B4L5Y983: { isin: "IE00B4L5Y983", currency: "GBP", tickers: [
    { ticker: "IWDA.L", exchange: "london" }, { ticker: "EUNL.F", exchange: "frankfurt" }, { ticker: "EUNL.DE", exchange: "xetra" },
  ] },
  LU0000000005: { isin: "LU0000000005", currency: "EUR", tickers: [{ ticker: "LUX.MI", exchange: "Milan" }] },
};
const EP_SERIES = {
  "EUNL.DE": [[1759000000000, 99], [1759086400000, 98.3]],
  "EUNL.F": [[1759000000000, 99], [1759086400000, 98.2]],
  "LUX.MI": [[1759000000000, 12.5], [1759086400000, 12.75]],
};

// EODHD: search by ISIN (one entry per listing), real-time by CODE.EXCHANGE.
// The gold ETC is the case it is there for: Eulerpool knows it only in London.
const EOD_SEARCH = {
  IE00B4ND3602: [
    { Code: "IGLN", Exchange: "LSE", Name: "Gold ETC", Currency: "USD", ISIN: "IE00B4ND3602" },
    { Code: "PPFB", Exchange: "F", Name: "Gold ETC", Currency: "EUR", ISIN: "IE00B4ND3602" },
    { Code: "PPFB", Exchange: "XETRA", Name: "Gold ETC EUR", Currency: "EUR", ISIN: "IE00B4ND3602" },
  ],
  GB0000000006: [{ Code: "ONLYUSD", Exchange: "NYSE", Name: "Only dollars", Currency: "USD", ISIN: "GB0000000006" }],
};
const EOD_REALTIME = {
  "PPFB.XETRA": { code: "PPFB.XETRA", close: 71.23, previousClose: 71.145, change: 0.085, change_p: 0.1195 },
  "PPFB.F": { code: "PPFB.F", close: "NA" },
};

// How the fakes behave: "ok", or a failure mode.
let tdMode = "ok"; // "429body" (HTTP 200, code in the body), "429http"
let epMode = "ok"; // "429"
let eodMode = "ok"; // "402"

const readBody = (req) =>
  new Promise((resolve) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => resolve(text));
  });

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://fake");
  const body = await readBody(req);
  upstream.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });

  if (url.pathname === "/cg/api/v3/simple/price") {
    const vs = url.searchParams.get("vs_currencies");
    if (url.searchParams.get("ids") === "bitcoin" && vs === "eur") {
      return json(res, 200, { bitcoin: { eur: 60000, eur_24h_change: 1.2345 } });
    }
    return json(res, 200, { bitcoin: {} });
  }

  if (url.pathname === "/figi/v3/mapping") {
    if (req.method !== "POST") return json(res, 405, {});
    const jobs = JSON.parse(body);
    return json(res, 200, jobs.map((j) => (FIGI[j.idValue] ? { data: FIGI[j.idValue] } : { warning: "No identifier found." })));
  }

  if (url.pathname.startsWith("/td/")) {
    const key = url.searchParams.get("apikey");
    if (key !== TD_KEY) return json(res, 401, { code: 401, message: "invalid api key", status: "error" });
    if (tdMode === "429body") return json(res, 200, { code: 429, message: "run out of API credits", status: "error" });
    if (tdMode === "429http") return json(res, 429, { code: 429, message: "run out of API credits", status: "error" });
    if (url.pathname === "/td/symbol_search") {
      const data = SEARCH[url.searchParams.get("symbol")] || [];
      return json(res, 200, { data, status: "ok" });
    }
    if (url.pathname === "/td/quote") {
      const q = QUOTE[`${url.searchParams.get("symbol")}|${url.searchParams.get("mic_code")}`];
      return q ? json(res, 200, q) : json(res, 200, { code: 404, message: "symbol not found", status: "error" });
    }
  }

  if (url.pathname.startsWith("/ep/api/1/")) {
    const token = url.searchParams.get("token");
    if (token !== EP_KEY) return json(res, 401, { error: { type: "authentication_error" } });
    if (epMode === "429") return json(res, 429, { error: { type: "rate_limit_exceeded" } });
    const m = (re) => re.exec(url.pathname);
    const byExchange = m(/^\/ep\/api\/1\/market\/quotes\/exchanges\/([^/]+)$/);
    if (byExchange) {
      const q = EP_EXCHANGES[decodeURIComponent(byExchange[1])];
      return q ? json(res, 200, q) : json(res, 404, { error: "Security not found" });
    }
    const profile = m(/^\/ep\/api\/1\/etf\/profile\/([^/]+)$/);
    if (profile) {
      const p = EP_PROFILES[decodeURIComponent(profile[1])];
      return p ? json(res, 200, p) : json(res, 404, { error: "Security not found" });
    }
    const series = m(/^\/ep\/api\/1\/etf\/quotes\/([^/]+)$/);
    if (series) {
      const q = EP_SERIES[decodeURIComponent(series[1])];
      return q ? json(res, 200, q) : json(res, 404, { error: "Security not found" });
    }
  }
  if (url.pathname.startsWith("/eodhd/")) {
    if (url.searchParams.get("api_token") !== EOD_KEY) return json(res, 401, "Unauthenticated.");
    if (eodMode === "402") return json(res, 402, "Payment Required");
    const search = /^\/eodhd\/search\/([^/]+)$/.exec(url.pathname);
    if (search) return json(res, 200, EOD_SEARCH[decodeURIComponent(search[1])] || []);
    const rt = /^\/eodhd\/real-time\/([^/]+)$/.exec(url.pathname);
    if (rt) {
      const q = EOD_REALTIME[decodeURIComponent(rt[1])];
      return q ? json(res, 200, q) : json(res, 404, "Ticker Not Found.");
    }
  }
  json(res, 404, {});
});

const count = (prefix) => upstream.filter((u) => u.path.startsWith(prefix)).length;
const paths = () => upstream.map((u) => u.path);

const main = async () => {
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const fakeBase = `http://127.0.0.1:${fake.address().port}`;
  process.env.COINGECKO_BASE_URL = `${fakeBase}/cg/api/v3`;
  process.env.OPENFIGI_BASE_URL = `${fakeBase}/figi`;
  process.env.TWELVEDATA_BASE_URL = `${fakeBase}/td`;
  process.env.EULERPOOL_BASE_URL = `${fakeBase}/ep/api/1`;
  process.env.EODHD_BASE_URL = `${fakeBase}/eodhd`;
  for (const k of ["TWELVEDATA_API_KEY", "EULERPOOL_API_KEY", "OPENFIGI_API_KEY", "COINGECKO_API_KEY", "EODHD_API_KEY", "DEBUG_QUOTES"]) delete process.env[k];
  process.env.QUOTES_STOCK_ORDER = "twelvedata,eulerpool";

  // --- Part 1: the real providers against the fakes, no quote cache ----------
  const service = await start({ port: 0, host: "127.0.0.1", cacheSeconds: 0 });
  const base = `http://127.0.0.1:${service.port}`;
  const quote = (query) => fetch(`${base}/v1/quote?${new URLSearchParams(query)}`);
  const ETF = { id: "IE00B4L5Y983", type: "ETF", currency: "EUR" };

  await test("/health answers ok", async () => {
    const res = await fetch(`${base}/health`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { status: "ok" });
  });

  await test("400 on missing or malformed parameters, with no upstream call", async () => {
    const before = upstream.length;
    for (const q of [{ currency: "EUR" }, { id: "IE00B4L5Y983" }, { id: "IE00B4L5Y983", currency: "EURO" }, { id: "a b", currency: "EUR" }, { id: "IE00B4L5Y983", currency: "EUR", type: "E T F" }]) {
      const res = await quote(q);
      assert.strictEqual(res.status, 400, JSON.stringify(q));
      assert.strictEqual((await res.json()).error, "INVALID_REQUEST");
    }
    assert.strictEqual(upstream.length, before);
  });

  await test("unknown paths are 404, other methods 405; no Authorization is asked for", async () => {
    assert.strictEqual((await fetch(`${base}/v2/quote`)).status, 404);
    assert.strictEqual((await fetch(`${base}/v1/quote`, { method: "POST" })).status, 405);
  });

  await test("with no ETF provider key: said once at startup, and an ETF is 404 NO_QUOTE with no upstream call", async () => {
    assert.ok(logs.some((l) => l.includes("ETF and stock prices off: set EULERPOOL_API_KEY, TWELVEDATA_API_KEY and/or EODHD_API_KEY")), "no startup line");
    const before = upstream.length;
    const res = await quote(ETF);
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: "NO_QUOTE" });
    assert.strictEqual(upstream.length, before);
  });

  process.env.TWELVEDATA_API_KEY = TD_KEY;
  process.env.EULERPOOL_API_KEY = EP_KEY;

  await test("the startup line names the providers on, in the order they are tried", async () => {
    const other = await start({ port: 0, host: "127.0.0.1", cacheSeconds: 0 });
    await other.close();
    assert.ok(logs.some((l) => l.endsWith("[quotes] ETF and stock prices: Twelve Data, Eulerpool")), "no startup line");
    delete process.env.QUOTES_STOCK_ORDER;
    const dflt = await start({ port: 0, host: "127.0.0.1", cacheSeconds: 0 });
    await dflt.close();
    process.env.QUOTES_STOCK_ORDER = "twelvedata,eulerpool";
    assert.ok(logs.some((l) => l.endsWith("[quotes] ETF and stock prices: Eulerpool, Twelve Data")), "the default order is Eulerpool first");
  });

  await test("/v1/sources lists the providers on, by id, and no key", async () => {
    const other = await start({ port: 0, host: "127.0.0.1", cacheSeconds: 0 });
    const res = await fetch(`http://127.0.0.1:${other.port}/v1/sources`);
    const text = await res.text();
    await other.close();
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(text).sources, ["coingecko", "twelvedata", "eulerpool", "openfigi"]);
    assert.ok(!text.includes(EP_KEY) && !text.includes(TD_KEY));
  });

  await test("Twelve Data: OpenFIGI -> symbol_search -> quote; the XETR listing in EUR over the USD one; Eulerpool not asked", async () => {
    upstream.length = 0;
    const res = await quote(ETF);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { price: 98.31, currency: "EUR", change: -0.42, symbol: "XETR" });
    assert.deepStrictEqual(paths(), ["/figi/v3/mapping", "/td/symbol_search", "/td/quote"]);
    const [figi, search, q] = upstream;
    assert.strictEqual(figi.method, "POST");
    assert.deepStrictEqual(JSON.parse(figi.body), [{ idType: "ID_ISIN", idValue: "IE00B4L5Y983" }]);
    assert.strictEqual(figi.headers["content-type"], "application/json");
    assert.strictEqual(figi.headers["x-openfigi-apikey"], undefined);
    assert.strictEqual(search.query.symbol, "EUNL", "the Xetra ticker is searched first");
    assert.deepStrictEqual(q.query, { symbol: "EUNL", mic_code: "XETR", apikey: TD_KEY });
    assert.ok(upstream.slice(1).every((u) => u.query.apikey === TD_KEY));
    assert.strictEqual(count("/ep/"), 0);
  });

  await test("Twelve Data: the listing is cached -- a second quote is one quote call, no OpenFIGI or symbol_search", async () => {
    upstream.length = 0;
    assert.strictEqual((await quote(ETF)).status, 200);
    assert.deepStrictEqual(paths(), ["/td/quote"]);
  });

  await test("OPENFIGI_API_KEY, when set, goes as X-OPENFIGI-APIKEY", async () => {
    clearProviders();
    process.env.OPENFIGI_API_KEY = FIGI_KEY;
    upstream.length = 0;
    assert.strictEqual((await quote(ETF)).status, 200);
    assert.strictEqual(upstream[0].headers["x-openfigi-apikey"], FIGI_KEY);
    delete process.env.OPENFIGI_API_KEY;
  });

  await test("fallback: Twelve Data's quota used up (code 429 in an HTTP 200 body) -> Eulerpool's Xetra quote in EUR", async () => {
    tdMode = "429body";
    upstream.length = 0;
    const res = await quote(ETF);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { price: 98.3, currency: "EUR", change: -0.71, symbol: "xetra" });
    assert.deepStrictEqual(paths(), ["/td/quote", "/ep/api/1/market/quotes/exchanges/IE00B4L5Y983", "/ep/api/1/etf/profile/IE00B4L5Y983", "/ep/api/1/etf/quotes/EUNL.DE"]);
    assert.strictEqual(upstream[1].query.token, EP_KEY);
    assert.ok(logs.some((l) => l.includes("Twelve Data: quota used up (429)")));
    tdMode = "ok";
  });

  await test("fallback: Twelve Data's quota used up (HTTP 429, at symbol_search) -> Eulerpool", async () => {
    clearProviders();
    tdMode = "429http";
    upstream.length = 0;
    const res = await quote(ETF);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).price, 98.3);
    assert.deepStrictEqual(paths(), ["/figi/v3/mapping", "/td/symbol_search", "/ep/api/1/market/quotes/exchanges/IE00B4L5Y983", "/ep/api/1/etf/profile/IE00B4L5Y983", "/ep/api/1/etf/quotes/EUNL.DE"]);
    tdMode = "ok";
  });

  await test("fallback: Twelve Data has no listing in the wallet's currency -> Eulerpool's EUR quote", async () => {
    upstream.length = 0;
    const res = await quote({ id: "DE0000000003", type: "STOCK", currency: "EUR" });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { price: 10.5, currency: "EUR", change: null, symbol: "Xetra" });
    assert.strictEqual(count("/td/quote"), 0);
    assert.strictEqual(count("/ep/"), 1);
  });

  await test("fallback: OpenFIGI does not know the ISIN -> Eulerpool (quotes/exchanges 404, then the ETF's profile and its Milan series)", async () => {
    process.env.DEBUG_QUOTES = "1";
    upstream.length = 0;
    const res = await quote({ id: "LU0000000005", type: "ETF", currency: "EUR" });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { price: 12.75, currency: "EUR", change: 2, symbol: "Milan" });
    assert.deepStrictEqual(paths(), ["/figi/v3/mapping", "/ep/api/1/market/quotes/exchanges/LU0000000005", "/ep/api/1/etf/profile/LU0000000005", "/ep/api/1/etf/quotes/LUX.MI"]);
    assert.ok(logs.some((l) => l.includes("DEBUG Eulerpool etf/profile")), "no debug line");
    delete process.env.DEBUG_QUOTES;
  });

  await test("both find the instrument only in USD: an EUR wallet gets 422 CURRENCY_UNSUPPORTED", async () => {
    const res = await quote({ id: "US0000000002", type: "STOCK", currency: "EUR" });
    assert.strictEqual(res.status, 422);
    assert.deepStrictEqual(await res.json(), { error: "CURRENCY_UNSUPPORTED" });
  });

  await test("nobody knows the ISIN: 404 NO_QUOTE", async () => {
    assert.strictEqual((await quote({ id: "XS0000000404", type: "ETF", currency: "EUR" })).status, 404);
  });

  await test("Twelve Data: a London listing in pence (GBp) is not a GBP price -- never quoted, 422 for a GBP wallet", async () => {
    upstream.length = 0;
    const res = await quote({ id: "GB0000000012", type: "STOCK", currency: "GBP" });
    assert.strictEqual(res.status, 422);
    assert.deepStrictEqual(await res.json(), { error: "CURRENCY_UNSUPPORTED" });
    assert.strictEqual(count("/td/symbol_search"), 1);
    assert.strictEqual(count("/td/quote"), 0, "the pence listing was asked for a price");
  });

  await test("Eulerpool: a bid of 0 is no bid -- the price is the ask, not half of it", async () => {
    const res = await quote({ id: "DE0000000011", type: "STOCK", currency: "EUR" });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { price: 20, currency: "EUR", change: null, symbol: "Xetra" });
  });

  await test("only Eulerpool configured: Twelve Data and OpenFIGI are never called", async () => {
    clearProviders();
    delete process.env.TWELVEDATA_API_KEY;
    upstream.length = 0;
    assert.strictEqual((await quote(ETF)).status, 200);
    assert.strictEqual(count("/td/") + count("/figi/"), 0);
    assert.ok(count("/ep/") >= 1);
    process.env.TWELVEDATA_API_KEY = TD_KEY;
  });

  await test("only Twelve Data configured, and it fails: 404, Eulerpool never called", async () => {
    delete process.env.EULERPOOL_API_KEY;
    tdMode = "429body";
    upstream.length = 0;
    assert.strictEqual((await quote(ETF)).status, 404);
    assert.ok(count("/td/") > 0);
    assert.strictEqual(count("/ep/"), 0);
    tdMode = "ok";
    process.env.EULERPOOL_API_KEY = EP_KEY;
  });

  await test("a refused key (401) falls through, and is logged once, not per request", async () => {
    process.env.TWELVEDATA_API_KEY = BAD_TD_KEY;
    for (let i = 0; i < 2; i += 1) {
      const res = await quote(ETF);
      assert.strictEqual(res.status, 200, "Eulerpool answers");
    }
    assert.strictEqual(logs.filter((l) => l.includes("Twelve Data refused the key (401)")).length, 1);
    process.env.TWELVEDATA_API_KEY = TD_KEY;

    process.env.EULERPOOL_API_KEY = BAD_EP_KEY;
    tdMode = "429body";
    for (let i = 0; i < 2; i += 1) assert.strictEqual((await quote(ETF)).status, 404);
    assert.strictEqual(logs.filter((l) => l.includes("Eulerpool refused the key (401)")).length, 1);
    tdMode = "ok";
    process.env.EULERPOOL_API_KEY = EP_KEY;
  });

  await test("default order: Eulerpool first -- an ETF priced from its Xetra series, Twelve Data and OpenFIGI never asked", async () => {
    clearProviders();
    delete process.env.QUOTES_STOCK_ORDER;
    upstream.length = 0;
    const res = await quote(ETF);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { price: 98.3, currency: "EUR", change: -0.71, symbol: "xetra" });
    assert.strictEqual(count("/td/") + count("/figi/"), 0);
    upstream.length = 0;
    assert.strictEqual((await quote(ETF)).status, 200);
    assert.deepStrictEqual(paths(), ["/ep/api/1/market/quotes/exchanges/IE00B4L5Y983", "/ep/api/1/etf/quotes/EUNL.DE"], "the profile is cached");
    process.env.QUOTES_STOCK_ORDER = "twelvedata,eulerpool";
  });

  // EODHD, the last of the chain: the gold ETC that Eulerpool knows only in London.
  const GOLD = { id: "IE00B4ND3602", type: "ETP", currency: "EUR" };

  await test("EODHD unset: never called, and the ETC is 404 NO_QUOTE", async () => {
    clearProviders();
    upstream.length = 0;
    assert.strictEqual((await quote(GOLD)).status, 404);
    assert.strictEqual(count("/eodhd/"), 0);
  });

  process.env.EODHD_API_KEY = EOD_KEY;

  await test("EODHD: after the others find nothing, search by ISIN -> the Xetra listing in EUR -> a real-time quote", async () => {
    clearProviders();
    upstream.length = 0;
    const res = await quote(GOLD);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { price: 71.23, currency: "EUR", change: 0.12, symbol: "XETRA" });
    const eod = upstream.filter((u) => u.path.startsWith("/eodhd/"));
    assert.deepStrictEqual(eod.map((u) => u.path), ["/eodhd/search/IE00B4ND3602", "/eodhd/real-time/PPFB.XETRA"]);
    assert.ok(eod.every((u) => u.query.fmt === "json" && u.query.api_token === EOD_KEY));
    assert.ok(upstream.findIndex((u) => u.path.startsWith("/ep/")) < upstream.findIndex((u) => u.path.startsWith("/eodhd/")), "asked last");
  });

  await test("EODHD: the listing is cached -- a second quote is one real-time call, no search", async () => {
    upstream.length = 0;
    assert.strictEqual((await quote(GOLD)).status, 200);
    assert.deepStrictEqual(upstream.filter((u) => u.path.startsWith("/eodhd/")).map((u) => u.path), ["/eodhd/real-time/PPFB.XETRA"]);
  });

  await test("EODHD: only in another currency is 422 CURRENCY_UNSUPPORTED", async () => {
    const res = await quote({ id: "GB0000000006", type: "ETF", currency: "EUR" });
    assert.strictEqual(res.status, 422);
    assert.deepStrictEqual(await res.json(), { error: "CURRENCY_UNSUPPORTED" });
  });

  await test("EODHD: an ISIN it does not cover is searched once a day, not on every refresh", async () => {
    const nobody = { id: "XX0000000404", type: "ETF", currency: "EUR" };
    upstream.length = 0;
    assert.strictEqual((await quote(nobody)).status, 404);
    assert.strictEqual((await quote(nobody)).status, 404);
    assert.strictEqual(count("/eodhd/search/"), 1);
  });

  await test("EODHD: the day's calls used up (402) is 404 and is not remembered; a refused key is logged once", async () => {
    clearProviders();
    eodMode = "402";
    assert.strictEqual((await quote(GOLD)).status, 404);
    eodMode = "ok";
    upstream.length = 0;
    assert.strictEqual((await quote(GOLD)).status, 200, "asked again once the quota is back");
    clearProviders();
    process.env.EODHD_API_KEY = BAD_EOD_KEY;
    for (let i = 0; i < 2; i += 1) assert.strictEqual((await quote(GOLD)).status, 404);
    assert.strictEqual(logs.filter((l) => l.includes("EODHD refused the key (401)")).length, 1);
    process.env.EODHD_API_KEY = EOD_KEY;
  });

  await test("EODHD: a price it writes as \"NA\" is not a quote", async () => {
    clearProviders();
    const saved = EOD_SEARCH.IE00B4ND3602;
    EOD_SEARCH.IE00B4ND3602 = saved.filter((e) => e.Exchange === "F");
    assert.strictEqual((await quote(GOLD)).status, 404);
    EOD_SEARCH.IE00B4ND3602 = saved;
  });

  delete process.env.EODHD_API_KEY;
  clearProviders();

  await test("CoinGecko: a crypto symbol is priced, with no key header when COINGECKO_API_KEY is unset", async () => {
    upstream.length = 0;
    const res = await quote({ id: "BTC-EUR", type: "CRYPTO", currency: "EUR" });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { price: 60000, currency: "EUR", change: 1.23, symbol: "BTC-EUR" });
    assert.strictEqual(upstream.length, 1);
    assert.strictEqual(upstream[0].query.ids, "bitcoin");
    assert.strictEqual(upstream[0].query.vs_currencies, "eur");
    assert.strictEqual(upstream[0].headers["x-cg-demo-api-key"], undefined);
  });

  await test("CoinGecko: COINGECKO_API_KEY is sent as x-cg-demo-api-key; routing by symbol with no type", async () => {
    process.env.COINGECKO_API_KEY = CG_KEY;
    upstream.length = 0;
    assert.strictEqual((await quote({ id: "BTC-USD", currency: "EUR" })).status, 200);
    assert.strictEqual(upstream[0].headers["x-cg-demo-api-key"], CG_KEY);
    assert.strictEqual(upstream[0].query.vs_currencies, "eur", "the wallet's currency wins over the suffix");
    delete process.env.COINGECKO_API_KEY;
  });

  await test("CoinGecko: a currency it has no price in, or an unknown coin, is no quote", async () => {
    assert.strictEqual((await quote({ id: "BTC-JPY", type: "CRYPTO", currency: "JPY" })).status, 404);
    upstream.length = 0;
    assert.strictEqual((await quote({ id: "NOPE-EUR", type: "CRYPTO", currency: "EUR" })).status, 404);
    assert.strictEqual(upstream.length, 0);
  });

  await test("an id that is neither an ISIN nor a crypto symbol has no source", async () => {
    upstream.length = 0;
    assert.strictEqual((await quote({ id: "AAPL", currency: "USD" })).status, 404);
    assert.strictEqual(upstream.length, 0);
  });

  await service.close();

  // --- Part 1b: the real providers behind the quote cache -------------------
  clearProviders();
  const withCache = await start({ port: 0, host: "127.0.0.1" });
  const quoteC = (query) => fetch(`http://127.0.0.1:${withCache.port}/v1/quote?${new URLSearchParams(query)}`);

  await test("a spent quota is not negative-cached: once the providers answer again, so does the service", async () => {
    tdMode = "429http";
    epMode = "429";
    assert.strictEqual((await quoteC(ETF)).status, 404);
    tdMode = "ok";
    epMode = "ok";
    upstream.length = 0;
    const res = await quoteC(ETF);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).price, 98.31);
    assert.ok(upstream.length > 0, "asked again");
  });

  await test("a definitive \"not found anywhere\" is negative-cached", async () => {
    const XS = { id: "XS0000000404", type: "ETF", currency: "EUR" };
    assert.strictEqual((await quoteC(XS)).status, 404);
    upstream.length = 0;
    assert.strictEqual((await quoteC(XS)).status, 404);
    assert.strictEqual(upstream.length, 0);
  });

  await withCache.close();

  // --- Part 2: a stub behind the cache ---------------------------------------
  const calls = [];
  let gate = null;
  let active = 0;
  let maxActive = 0;
  setLookup(async ({ isin, typeCode, currency }) => {
    calls.push({ isin, typeCode, currency });
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (gate) await gate;
    } finally {
      active -= 1;
    }
    if (isin === "XX0000000404") return { price: null, quoteCurrency: null };
    if (isin === "XX0000000429") return { price: null, quoteCurrency: null, transient: true };
    if (isin === "XX0000000502") throw new Error("boom");
    if (currency === "JPY") return { price: null, unsupportedCurrency: "JPY" };
    return { price: 98.31, change: -0.42, quoteCurrency: currency, symbol: "XETRA", source: "stub" };
  });
  const cached = await start({ port: 0, host: "127.0.0.1" });
  const base2 = `http://127.0.0.1:${cached.port}`;
  const quote2 = (query) => fetch(`${base2}/v1/quote?${new URLSearchParams(query)}`);

  await test("the stub's answer, in the contract's shape", async () => {
    const res = await quote2(ETF);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { price: 98.31, currency: "EUR", change: -0.42, symbol: "XETRA" });
    assert.deepStrictEqual(calls.at(-1), { isin: "IE00B4L5Y983", typeCode: "ETF", currency: "EUR" });
  });

  await test("the same quote again is a cache hit: the provider is not asked twice", async () => {
    const before = calls.length;
    const res = await quote2({ ...ETF, id: "ie00b4l5y983" }); // case does not make a new entry
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, before);
    assert.ok(logs.some((l) => l.includes("cache=hit")));
  });

  await test("another currency or type is another cache entry", async () => {
    const before = calls.length;
    await quote2({ ...ETF, currency: "USD" });
    await quote2({ ...ETF, type: "" });
    assert.strictEqual(calls.length, before + 2);
  });

  await test("404 NO_QUOTE is cached too (the negative cache)", async () => {
    const before = calls.length;
    const first = await quote2({ ...ETF, id: "XX0000000404" });
    const second = await quote2({ ...ETF, id: "XX0000000404" });
    assert.strictEqual(first.status, 404);
    assert.strictEqual(second.status, 404);
    assert.strictEqual(calls.length, before + 1);
  });

  await test("a transient 404 (a provider could not answer) is not cached", async () => {
    const before = calls.length;
    assert.strictEqual((await quote2({ ...ETF, id: "XX0000000429" })).status, 404);
    assert.strictEqual((await quote2({ ...ETF, id: "XX0000000429" })).status, 404);
    assert.strictEqual(calls.length, before + 2);
  });

  await test("422 CURRENCY_UNSUPPORTED from the provider", async () => {
    const res = await quote2({ ...ETF, currency: "JPY" });
    assert.strictEqual(res.status, 422);
    assert.deepStrictEqual(await res.json(), { error: "CURRENCY_UNSUPPORTED" });
  });

  await test("a provider that throws is 502 UPSTREAM_FAILED, and not cached", async () => {
    const before = calls.length;
    assert.strictEqual((await quote2({ ...ETF, id: "XX0000000502" })).status, 502);
    assert.strictEqual((await quote2({ ...ETF, id: "XX0000000502" })).status, 502);
    assert.strictEqual(calls.length, before + 2);
  });

  await test("concurrent identical requests share one lookup", async () => {
    const before = calls.length;
    let open;
    gate = new Promise((resolve) => (open = resolve));
    const pending = [1, 2, 3].map(() => quote2({ id: "BTC-EUR", type: "CRYPTO", currency: "EUR" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    open();
    gate = null;
    const statuses = (await Promise.all(pending)).map((r) => r.status);
    assert.deepStrictEqual(statuses, [200, 200, 200]);
    assert.strictEqual(calls.length, before + 1);
  });

  await test("no more than 4 lookups reach the sources at once", async () => {
    maxActive = 0;
    let open;
    gate = new Promise((resolve) => (open = resolve));
    const ids = ["XX0000000011", "XX0000000012", "XX0000000013", "XX0000000014", "XX0000000015", "XX0000000016"];
    const pending = ids.map((id) => quote2({ id, type: "ETF", currency: "EUR" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(active, 4, `${active} lookups in flight`);
    open();
    gate = null;
    assert.deepStrictEqual((await Promise.all(pending)).map((r) => r.status), ids.map(() => 200));
    assert.strictEqual(maxActive, 4);
  });

  await cached.close();

  await test("no log line names an instrument or a price, or carries a key", async () => {
    const text = logs.join("\n");
    assert.ok(logs.some((l) => /GET \/v1\/quote 200/.test(l)), "the request lines are there");
    for (const secret of [TD_KEY, BAD_TD_KEY, EP_KEY, BAD_EP_KEY, EOD_KEY, BAD_EOD_KEY, FIGI_KEY, CG_KEY]) assert.ok(!text.includes(secret), "a secret is in the logs");
    for (const id of [
      "IE00B4L5Y983", "LU0000000005", "US0000000002", "DE0000000003", "XS0000000404", "XX0000000404", "XX0000000429",
      "IE00B4ND3602", "GB0000000006", "PPFB", "BTC-EUR", "BTC-USD", "NOPE", "AAPL", "EUNL", "SWDA", "IWDA", "ONLY", "bitcoin", "98.31", "110.5", "71.23",
    ]) {
      assert.ok(!text.toUpperCase().includes(id.toUpperCase()), `${id} is in the logs`);
    }
  });

  fake.close();
  const failed = results.filter((ok) => !ok).length;
  print(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
};

main().catch((e) => {
  print(e.stack || String(e));
  process.exit(1);
});
