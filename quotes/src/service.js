// ============================================================================
// The HTTP service
// ============================================================================
//   GET /health                          { status: "ok" }
//   GET /v1/sources                      { sources: ["coingecko", "eulerpool", ...] }, the providers on
//   GET /v1/quote?id=&type=&currency=    a price, per the contract below
//
// No keys, no accounts, no limits: the service runs next to Bussola's API on
// the compose network and is not published to the host. The quote endpoint
// implements the contract Bussola's api/services/quotes/http.js documents:
//
//   400 INVALID_REQUEST        a parameter missing or malformed
//   200 { price, currency, change, symbol }
//   422 CURRENCY_UNSUPPORTED   the source cannot price in that currency
//   404 NO_QUOTE               no source knows the instrument (or none is
//                              configured for it: ETFs need EULERPOOL_API_KEY,
//                              TWELVEDATA_API_KEY and/or EODHD_API_KEY)
//   502 UPSTREAM_FAILED        a provider threw (they are not meant to)
//
// Bussola treats every status but 200 as "no quote" (422 says why), so the
// codes are for the person reading a log, not for the app.
//
// One log line per request: method, path, status, duration and cache. Never
// the instrument -- which ETFs somebody holds is their business.
// ============================================================================
const http = require("node:http");
const { createQuotes } = require("./quotes");
const { stockProviders } = require("../providers/stocks");

const intEnv = (name, fallback) => {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const config = () => ({
  port: intEnv("PORT", 8080),
  host: process.env.HOST || "0.0.0.0",
  cacheSeconds: intEnv("QUOTES_CACHE_SECONDS", 900),
  negativeSeconds: intEnv("QUOTES_NEGATIVE_CACHE_SECONDS", 300),
  cacheMax: Math.max(1, intEnv("QUOTES_CACHE_MAX", 5000)),
  concurrency: Math.max(1, intEnv("QUOTES_UPSTREAM_CONCURRENCY", 4)),
});

// An ISIN ("IE00B4L5Y983") or a symbol ("BTC-EUR"); upper-cased, since every
// provider upper-cases anyway and the cache should not hold "btc-eur" and
// "BTC-EUR" twice.
const ID_RE = /^[A-Z0-9][A-Z0-9.-]{0,31}$/;
const TYPE_RE = /^[A-Z0-9_]{1,32}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

const parseQuery = (searchParams) => {
  const id = String(searchParams.get("id") || "").trim().toUpperCase();
  const type = String(searchParams.get("type") || "").trim().toUpperCase();
  const currency = String(searchParams.get("currency") || "").trim().toUpperCase();
  if (!ID_RE.test(id)) return { error: "id must be an ISIN or a symbol such as BTC-EUR" };
  if (type && !TYPE_RE.test(type)) return { error: "type must be a holding type code such as ETF or CRYPTO" };
  if (!CURRENCY_RE.test(currency)) return { error: "currency must be an ISO 4217 code such as EUR" };
  return { query: { id, type: type || null, currency } };
};

const send = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(text);
};

const start = async (options = {}) => {
  const cfg = { ...config(), ...options };
  const log = cfg.log || console.log;
  const quotes = cfg.quotes || createQuotes({ ...cfg, log });

  const stocks = stockProviders();
  log(
    stocks.length
      ? `[quotes] ETF and stock prices: ${stocks.join(", ")}`
      : "[quotes] ETF and stock prices off: set EULERPOOL_API_KEY, TWELVEDATA_API_KEY and/or EODHD_API_KEY (crypto still works)",
  );

  const handle = async (req, res, note) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/health") {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "METHOD_NOT_ALLOWED" }, { Allow: "GET" });
      return send(res, 200, { status: "ok" });
    }
    if (url.pathname === "/v1/sources") {
      if (req.method !== "GET") return send(res, 405, { error: "METHOD_NOT_ALLOWED" }, { Allow: "GET" });
      // Which providers are configured, by id, never their keys: the interface
      // shows the credit a free plan asks for (Eulerpool) only when it is on.
      const ids = stocks.map((n) => n.toLowerCase().replace(/[^a-z]/g, ""));
      // OpenFIGI has no key of its own: Twelve Data maps ISINs to tickers
      // through it, so it is on exactly when Twelve Data is.
      const mapping = ids.includes("twelvedata") ? ["openfigi"] : [];
      return send(res, 200, { sources: ["coingecko", ...ids, ...mapping] });
    }
    if (url.pathname !== "/v1/quote") return send(res, 404, { error: "NOT_FOUND" });
    if (req.method !== "GET") return send(res, 405, { error: "METHOD_NOT_ALLOWED" }, { Allow: "GET" });

    const parsed = parseQuery(url.searchParams);
    if (parsed.error) return send(res, 400, { error: "INVALID_REQUEST", message: parsed.error });

    const { answer, cached } = await quotes.get(parsed.query);
    note.cache = cached ? "hit" : "miss";
    return send(res, answer.status, answer.body);
  };

  const server = http.createServer((req, res) => {
    const started = process.hrtime.bigint();
    const note = { cache: null };
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const path = String(req.url || "").split("?")[0];
      log(
        `${new Date().toISOString()} ${req.method} ${path} ${res.statusCode} ${ms.toFixed(0)}ms` +
          (note.cache ? ` cache=${note.cache}` : ""),
      );
    });
    handle(req, res, note).catch((e) => {
      log(`[service] ${e.message}`);
      if (!res.headersSent) send(res, 500, { error: "INTERNAL" });
      else res.destroy();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, resolve);
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  };

  return { server, port: server.address().port, quotes, close };
};

module.exports = { start, config, parseQuery };
