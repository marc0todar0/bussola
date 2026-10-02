// ---------------------------------------------------------------------------
// Personal API tokens: how an automation reaches the inbox
// ---------------------------------------------------------------------------
// A bank notification on a phone becomes a draft in Bussola (routes/inbox.js).
// Whatever sends it -- an iPhone Shortcuts automation, an Android app -- has
// no browser session, so it carries a personal token instead:
//
//   Authorization: Bearer bpt_<43 characters>
//
// What a token can do is deliberately small. It is accepted by exactly two
// endpoints, POST /api/inbox and GET /api/inbox/context, and by nothing else:
// identifyUser (middleware.js) only ever reads the session cookie, so a Bearer
// header anywhere else authenticates nobody. It drops drafts into one wallet,
// and a draft becomes a transaction only when a person confirms it.
//
// A token belongs to a person and a wallet, and the membership is checked
// again on every use: when the person leaves the wallet, or is made read-only
// there, the token stops working at that very request -- nobody has to
// remember to revoke it. RLS then checks it once more inside the transaction.
//
// Creating one asks for the password again, as adding a passkey does
// (reauthenticate() in routes.js): a stolen session cookie must not be enough
// to mint a credential that outlives it. The token is shown once; only its
// sha256 is stored, as for sessions.
//
// api_tokens is an identity table (migration 002): no RLS, reached only from
// here through db.queryAuth(), and every statement that serves a signed-in
// person names their user id.
const crypto = require("node:crypto");
const router = require("express").Router;
const db = require("../dbConn");
const { requireAuth, publicError } = require("./middleware");
const { limits, tooMany } = require("./throttle");

const PREFIX = "bpt_";
// 32 random bytes are 43 characters of base64url.
const TOKEN_RE = /^bpt_[A-Za-z0-9_-]{43}$/;
const MAX_ACTIVE_TOKENS = 25;
const LABEL_MAX = 64;

const fingerprint = (token) => crypto.createHash("sha256").update(token).digest("hex");

const newToken = () => PREFIX + crypto.randomBytes(32).toString("base64url");

// The one refusal for every token that does not open anything: malformed,
// unknown, revoked, or its account disabled. Telling them apart would help
// nobody but somebody guessing.
const TOKEN_INVALID = { code: "TOKEN_INVALID", error: "The token is not valid" };
const TOKEN_FORBIDDEN = {
  code: "TOKEN_FORBIDDEN",
  error: "The token's account can no longer write to its wallet",
};

const bearer = (req) => {
  const header = String(req.get("authorization") || "");
  const m = header.match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
};

// Who the token speaks for, and whether they may still write to its wallet.
// The membership is read here, on every use, never trusted from the moment the
// token was made.
const resolve = async (token) => {
  const { rows } = await db.queryAuth(
    `SELECT t.id, t.user_id, t.wallet_id, m.role, w.currency, w.name AS wallet_name
       FROM api_tokens t
       JOIN users   u ON u.id = t.user_id AND u.active
       JOIN wallets w ON w.id = t.wallet_id
       LEFT JOIN wallet_members m ON m.wallet_id = t.wallet_id AND m.user_id = t.user_id
      WHERE t.token_hash = $1
        AND t.revoked_at IS NULL`,
    [fingerprint(token)],
  );
  return rows[0] || null;
};

// ---------------------------------------------------------------------------
// withToken: the token counterpart of withWalletWrite
// ---------------------------------------------------------------------------
// Only the inbox's two token endpoints are wrapped in it. It answers the
// refusals itself -- throttled, invalid, forbidden -- and otherwise runs the
// handler inside withTenant with write access, so everything the handler
// touches goes through RLS like any other request. req.token carries who and
// where.
//
// Failed attempts are counted per address (throttle.js, tokenPerIp): a token
// cannot be guessed, but each attempt still costs a lookup.
const withToken = (fn) => async (req, res) => {
  const wait = await limits.tokenPerIp.blocked(req.ip);
  if (wait) return tooMany(res, wait);

  const raw = bearer(req);
  let found = null;
  try {
    found = raw && TOKEN_RE.test(raw) ? await resolve(raw) : null;
  } catch (error) {
    console.error("Could not resolve the token:", error.message);
    return res.status(500).json({ code: "REQUEST_FAILED", error: "The request failed" });
  }
  if (!found) {
    await limits.tokenPerIp.hit(req.ip);
    return res.status(401).json(TOKEN_INVALID);
  }
  if (found.role !== "rw") return res.status(403).json(TOKEN_FORBIDDEN);

  req.token = {
    id: found.id,
    userId: found.user_id,
    walletId: found.wallet_id,
    walletCurrency: String(found.currency || "EUR").trim().toUpperCase(),
  };

  try {
    await db.queryAuth("UPDATE api_tokens SET last_used_at = now() WHERE id = $1 AND user_id = $2", [
      found.id,
      found.user_id,
    ]);
    const result = await db.withTenant({ userId: found.user_id, walletId: found.wallet_id, write: true }, () =>
      fn(req, res),
    );
    if (res.headersSent) return;
    // 200 unless the handler said otherwise (201 for a new item).
    res.json(result === undefined ? null : result);
  } catch (error) {
    console.error(`Error in ${req.method} ${req.originalUrl}:`, error);
    if (res.headersSent) return;
    const { status, body } = publicError(error);
    res.status(status).json(body);
  }
};

// ---------------------------------------------------------------------------
// Managing one's tokens: /api/auth/tokens, with the session cookie
// ---------------------------------------------------------------------------
const listTokens = async (userId) => {
  const { rows } = await db.queryAuth(
    `SELECT t.id, t.label, t.wallet_id, w.name AS wallet_name, t.created_at, t.last_used_at
       FROM api_tokens t
       JOIN wallets w ON w.id = t.wallet_id
      WHERE t.user_id = $1 AND t.revoked_at IS NULL
      ORDER BY t.created_at DESC, t.id DESC`,
    [userId],
  );
  return rows;
};

const tokenRoutes = ({ fail, reauthenticate }) => {
  const r = router();

  // Every token of mine, whatever the wallet: they are my credentials, and
  // the list is where I revoke one. Never the hash, let alone the token.
  r.get("/", requireAuth, async (req, res) => {
    try {
      res.json(await listTokens(req.user.id));
    } catch (error) {
      console.error("Could not list the tokens:", error);
      fail(res, 500, "TOKEN_LIST_FAILED", "Could not list the tokens");
    }
  });

  // A new token, for the wallet this session is looking at. Only a member
  // who may write there can make one: the token's whole purpose is to write.
  r.post("/", requireAuth, async (req, res) => {
    const wallet = req.user.wallet;
    if (!wallet) return fail(res, 409, "NO_WALLET_SELECTED", "No wallet selected");
    if (wallet.role !== "rw") {
      return fail(res, 403, "READ_ONLY", "You have read-only access to this wallet");
    }

    const { label, password } = req.body || {};
    const name = typeof label === "string" ? label.trim() : "";
    if (!name || name.length > LABEL_MAX) {
      return fail(res, 400, "INVALID_TOKEN_LABEL", `The token needs a name of at most ${LABEL_MAX} characters`);
    }

    try {
      if (!(await reauthenticate(req, res, password))) return;

      const { rows: count } = await db.queryAuth(
        "SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL",
        [req.user.id],
      );
      if (count[0].n >= MAX_ACTIVE_TOKENS) {
        return fail(res, 409, "TOKEN_LIMIT", `At most ${MAX_ACTIVE_TOKENS} tokens: revoke one first`);
      }

      const token = newToken();
      const { rows } = await db.queryAuth(
        `INSERT INTO api_tokens (user_id, wallet_id, label, token_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, label, wallet_id, created_at, last_used_at`,
        [req.user.id, wallet.id, name, fingerprint(token)],
      );
      // The only time the token itself leaves the server.
      res.status(201).json({ ...rows[0], wallet_name: wallet.name, token });
    } catch (error) {
      console.error("Could not create the token:", error);
      fail(res, 500, "TOKEN_CREATE_FAILED", "Could not create the token");
    }
  });

  // Revoking: mine only. Someone else's id and an id that does not exist get
  // the same answer.
  r.delete("/:id", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
      return fail(res, 404, "TOKEN_NOT_FOUND", "No such token");
    }
    try {
      const { rowCount } = await db.queryAuth(
        "UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
        [id, req.user.id],
      );
      if (!rowCount) return fail(res, 404, "TOKEN_NOT_FOUND", "No such token");
      res.json({ ok: true });
    } catch (error) {
      console.error("Could not revoke the token:", error);
      fail(res, 500, "TOKEN_REVOKE_FAILED", "Could not revoke the token");
    }
  });

  return r;
};

module.exports = { withToken, tokenRoutes, TOKEN_RE };
