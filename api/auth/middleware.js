const sessions = require("./sessions");
const db = require("../dbConn");

// Works out who is calling. It does not block: rejecting is requireAuth's job,
// so the public routes (login, status) can still know who you are.
const identifyUser = async (req, res, next) => {
  try {
    const token = req.cookies ? req.cookies[sessions.COOKIE_NAME] : null;
    req.user = await sessions.userFromToken(token);
    if (req.user) {
      // Pushing the end back is a convenience: failing it must not sign
      // anybody out, so it has its own catch.
      try {
        const renewed = await sessions.renewIfDue(token, req.user.session_expires_at);
        if (renewed) res.cookie(sessions.COOKIE_NAME, token, sessions.cookieOptions(renewed));
      } catch (error) {
        console.error("Could not renew the session:", error.message);
      }
    }
  } catch (error) {
    console.error("Could not resolve the session:", error.message);
    req.user = null;
  }
  next();
};

const requireAuth = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ code: "NOT_AUTHENTICATED", error: "Not authenticated" });
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ code: "NOT_AUTHENTICATED", error: "Not authenticated" });
  }
  if (!req.user.is_admin) {
    return res.status(403).json({ code: "ADMIN_ONLY", error: "Administrators only" });
  }
  next();
};

// ---------------------------------------------------------------------------
// The wrapper that replaces the routes' boilerplate
// ---------------------------------------------------------------------------
// Every endpoint used to repeat a dozen lines of .then/.catch. Now a route only
// says which function to call and whether it writes, and going through
// withTenant is not a convention to remember but the only road available.
//
// The three refusals are here rather than in a middleware mounted alongside,
// so that they cannot be left off one route by accident: no endpoint reaches a
// controller without a wallet in context and the right to do what it is about
// to do.
const run = (fn, write) => async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ code: "NOT_AUTHENTICATED", error: "Not authenticated" });
  }

  // Signed in, but not looking at anything yet. 409 rather than 403: nothing
  // was refused, something is missing, and the frontend answers it by showing
  // the wallet picker.
  if (!req.user.wallet) {
    return res.status(409).json({ code: "NO_WALLET_SELECTED", error: "No wallet selected" });
  }

  // A read-only member is refused here *and* by the database. This one exists
  // for the message: the policy would reject the statement too, but as an
  // error about row-level security that means nothing to whoever is reading it.
  if (write && req.user.wallet.role !== "rw") {
    return res
      .status(403)
      .json({ code: "READ_ONLY", error: "You have read-only access to this wallet" });
  }

  try {
    const result = await db.withTenant(
      { userId: req.user.id, walletId: req.user.wallet.id, write },
      () => fn(req, res),
    );
    if (res.headersSent) return;
    res.status(200).json(result === undefined ? null : result);
  } catch (error) {
    console.error(`Error in ${req.method} ${req.originalUrl}:`, error);
    if (res.headersSent) return;
    const { status, body } = publicError(error);
    res.status(status).json(body);
  }
};

// ---------------------------------------------------------------------------
// What a failure is allowed to say
// ---------------------------------------------------------------------------
// The full error goes to the server log above. The client gets a status that
// means something and a sentence that gives nothing away: a raw Postgres
// message names tables, constraints and policies ("new row violates row-level
// security policy for table accounts"), which is a map of the schema handed to
// whoever sends a malformed id.
//
// Errors raised on purpose keep their words: a DataError (services/
// dataError.js) was written for the person reading it.
const DataError = require("../services/dataError");

const GENERIC = {
  400: ["INVALID_REQUEST", "The request is not valid"],
  403: ["NOT_ALLOWED", "This is not allowed"],
  404: ["NOT_FOUND", "Not found"],
  409: ["REQUEST_CONFLICT", "The request conflicts with the current state"],
  500: ["REQUEST_FAILED", "The request failed"],
};

// Postgres' SQLSTATE classes that describe the request rather than a bug:
// class 22 is bad data (an id that is not a number, a date that is not a
// date, a value out of range), 23503 a reference to a row that is not there,
// 23505 a duplicate, 42501 a row-level security refusal.
const statusForSqlState = (code) => {
  if (typeof code !== "string") return null;
  if (code.startsWith("22") || code === "23502" || code === "23503" || code === "23514") return 400;
  if (code === "23505") return 409;
  if (code === "42501") return 403;
  return null;
};

const publicError = (error) => {
  if (error instanceof DataError) {
    return {
      status: error.status,
      body: { code: error.code, error: error.message, ...(error.extra || {}) },
    };
  }

  // A controller that set a 4xx (a foreign key it recognised, a conflict)
  // keeps the status, not the message: those messages are built from the
  // database's own.
  const declared = Number(error && error.statusCode);
  const status =
    (declared >= 400 && declared < 500 && declared) || statusForSqlState(error && error.code) || 500;
  const [code, message] = GENERIC[status] || GENERIC[500];
  return { status, body: { code, error: message } };
};

// ---------------------------------------------------------------------------
// Requests that change something must come from this application's own pages
// ---------------------------------------------------------------------------
// The session cookie is SameSite=Lax, and "same site" is wider than it sounds:
// another port on the same host, or a sibling subdomain, is the same site. A
// page on http://192.168.1.10:8080 (any other self-hosted application on the
// box) could post a plain HTML form to http://192.168.1.10:3000/api/... and
// the browser would attach the cookie. So every request that is not a read has
// to say where it comes from, and it has to be here.
//
// Browsers send Origin on every such request, form posts included; they also
// send Sec-Fetch-Site, but only over HTTPS. A request with neither is not from
// a browser (curl, the test scripts, a backup job) and carries no ambient
// cookie it did not put there itself, so it is let through.
//
// "Here" is the address the request was sent to: the Host header, or
// X-Forwarded-Host where a proxy rewrote Host (nginx sets it; so does the Vite
// development proxy, with xfwd). A page cannot forge either on a request its
// browser sends. Beyond that, CORS_ORIGINS and BUSSOLA_PUBLIC_URL name origins
// that are allowed explicitly.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const originOf = (value) => {
  try {
    return new URL(String(value).trim()).origin;
  } catch {
    return null;
  }
};

const EXTRA_ORIGINS = new Set(
  [...(process.env.CORS_ORIGINS || "").split(","), process.env.BUSSOLA_PUBLIC_URL || ""]
    .map((o) => o.trim())
    .filter(Boolean)
    .map(originOf)
    .filter(Boolean),
);

// host[:port], lower-cased, without the port a scheme implies anyway.
const normaliseHost = (host, protocol) => {
  const h = String(host || "").trim().toLowerCase();
  if (protocol === "http:" && h.endsWith(":80")) return h.slice(0, -3);
  if (protocol === "https:" && h.endsWith(":443")) return h.slice(0, -4);
  return h;
};

const sameOrigin = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const site = String(req.get("sec-fetch-site") || "").toLowerCase();
  if (site === "same-origin") return next();

  const origin = req.get("origin");
  if (origin === undefined) {
    // No Origin but a Sec-Fetch-Site that says "not from here": a browser, and
    // not one of ours.
    if (site === "same-site" || site === "cross-site") return refuseOrigin(res);
    return next();
  }

  let url;
  try {
    url = new URL(origin);
  } catch {
    return refuseOrigin(res); // includes the opaque "null" origin
  }
  if (EXTRA_ORIGINS.has(url.origin)) return next();

  const target = normaliseHost(url.host, url.protocol);
  const candidates = [req.get("x-forwarded-host"), req.get("host")]
    .filter(Boolean)
    .flatMap((h) => h.split(","))
    .map((h) => normaliseHost(h, url.protocol));
  if (candidates.includes(target)) return next();

  return refuseOrigin(res);
};

const refuseOrigin = (res) =>
  res.status(403).json({
    code: "CROSS_ORIGIN_REFUSED",
    error: "This request did not come from Bussola's own pages",
  });

// Two names, and the shorter one is the safe one: an endpoint written without
// thinking about it is born read-only, and its transaction is opened READ ONLY
// to match.
const withWallet = (fn) => run(fn, false);
const withWalletWrite = (fn) => run(fn, true);

// ---------------------------------------------------------------------------
// withWalletPhased: a write endpoint that is allowed to wait on the network
// ---------------------------------------------------------------------------
// run() makes the whole request one database transaction. That is the right
// shape for everything except the quote refresh, which spends most of its time
// waiting for the quote service: inside one transaction it held a pooled
// connection -- and the row locks of every account it had already recomputed
// -- for as long as the slowest provider took to answer. A handful of
// refreshes against a stalled provider was enough to empty the pool of ten
// connections, and then every wallet on the instance waited, sign-in included.
//
// Here the controller gets `tx(write, fn)` instead of an open transaction, and
// opens as many short ones as it needs: read what to fetch, let go of the
// connection, fetch, then write in a second transaction that lasts
// milliseconds. Each one goes through db.withTenant, so each one is the whole
// of the isolation -- app.user_id and app.wallet_id set, RLS deciding, READ
// ONLY unless it writes.
//
// The refusals are the same three as run()'s, in the same order and with the
// same codes, because an endpoint that answered differently from its
// neighbours would be the first thing the isolation test caught. Between two
// phases nothing is assumed: a membership revoked or demoted to read-only in
// the gap makes the second transaction's policies refuse the write, as they
// would any other.
const withWalletPhased = (fn) => async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ code: "NOT_AUTHENTICATED", error: "Not authenticated" });
  }
  if (!req.user.wallet) {
    return res.status(409).json({ code: "NO_WALLET_SELECTED", error: "No wallet selected" });
  }
  if (req.user.wallet.role !== "rw") {
    return res.status(403).json({ code: "READ_ONLY", error: "You have read-only access to this wallet" });
  }

  const tx = (write, work) =>
    db.withTenant({ userId: req.user.id, walletId: req.user.wallet.id, write: Boolean(write) }, work);

  try {
    const result = await fn(req, tx);
    if (res.headersSent) return;
    res.status(200).json(result === undefined ? null : result);
  } catch (error) {
    console.error(`Error in ${req.method} ${req.originalUrl}:`, error);
    if (res.headersSent) return;
    const { status, body } = publicError(error);
    res.status(status).json(body);
  }
};

module.exports = {
  identifyUser,
  requireAuth,
  requireAdmin,
  withWallet,
  withWalletWrite,
  withWalletPhased,
  sameOrigin,
  publicError,
};
