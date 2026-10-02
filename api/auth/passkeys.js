// ===========================================================================
// Passkeys (WebAuthn)
// ===========================================================================
// What gives "sign in with the fingerprint" on a phone. There is no biometric
// API on the web: the device holds a private key that its fingerprint, face or
// screen lock unlocks, and it signs a challenge this server hands out. The
// server only ever holds the public half (the passkeys table).
//
// Three rules shape everything below:
//
//   - A passkey is an *additional* proof of identity. The password always
//     remains, and a passkey sign-in ends in exactly the cookie session a
//     password sign-in does: completeSignIn() is handed in from routes.js, so
//     the session, the last_login bookkeeping and the wallet auto-selection
//     are the same code, not a copy of it.
//
//   - Adding one asks for the password again. A passkey is a permanent way in;
//     a stolen session cookie must not be enough to plant one.
//
//   - A failed passkey sign-in says nothing, and costs nothing. It never counts
//     toward the five-wrong-passwords lockout (that counter guards against
//     guessing a password, and nobody guesses an ECDSA signature), and an
//     unknown credential and a bad signature get the same answer.
const crypto = require("node:crypto");
const router = require("express").Router;
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const { decodeClientDataJSON, isoBase64URL } = require("@simplewebauthn/server/helpers");
const db = require("../dbConn");
const { requireAuth } = require("./middleware");
const lockout = require("./lockout");
const { limits, tooMany } = require("./throttle");
const { parseRelyingParty } = require("./publicUrl");

// ---------------------------------------------------------------------------
// The relying party: which site the passkeys belong to
// ---------------------------------------------------------------------------
// A passkey is bound to a domain (the "rpID") and every signature it makes
// names the page's origin. The server has to know both in advance to check
// them, and they come from BUSSOLA_PUBLIC_URL -- e.g.
// https://bussola.example.com -- or passkeys are off.
//
// Why not work them out from the request when the variable is unset. The
// only sources are the Host and X-Forwarded-* headers, and neither is fit to
// be trusted with this:
//
//   - Host is whatever the client sent. nginx (frontend/nginx/
//     default.conf.template) passes it through as $host, and the API sets
//     `trust proxy`, so a request can claim any hostname it likes. Checking a
//     signature against an origin the request itself named is checking the
//     request against itself.
//   - X-Forwarded-Proto is overwritten by our own nginx with *its* $scheme,
//     which is "http" whenever TLS ends at an outer proxy (Caddy, Traefik, a
//     tunnel) -- the recommended way to run Bussola behind HTTPS. So "derive
//     only when the request is https" would be wrong in the very deployment it
//     is meant for, and right only when it could just as well be configured.
//
// So: unset means disabled, loudly, and /api/auth/status says so, which is
// how the login page knows not to draw the button. The standard deployment is
// plain http on a LAN, where browsers refuse WebAuthn anyway.
//
// The rule for what is accepted lives in publicUrl.js (Web Push shares it).

// Read once: the value cannot change under a running process, and a bad one
// deserves one clear line in the log at startup rather than one per request.
const { rp: RELYING_PARTY, reason } = parseRelyingParty(process.env.BUSSOLA_PUBLIC_URL);
if (RELYING_PARTY) {
  console.log(`[auth] passkeys enabled for ${RELYING_PARTY.origin} (rpID ${RELYING_PARTY.rpID}).`);
} else if (reason) {
  console.warn(`[auth] passkeys disabled: ${reason}.`);
}

const relyingParty = () => RELYING_PARTY;

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------
// In the database (passkey_challenges), not in memory: the API may run as
// several replicas, and the request that returns a challenge signed need not
// land on the one that issued it. Five minutes is generous
// for a ceremony that takes a few seconds, and short enough that a leaked one
// is useless by the time anyone could do anything with it.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// Handed to the browser: how long it keeps its own prompt open.
const CEREMONY_TIMEOUT_MS = 2 * 60 * 1000;

// The login screen issues challenges to anybody, so the table could be filled
// by someone asking in a loop. Two bounds: per address and per process, a
// short window -- short so that a person retrying, or the isolation test run
// twice in a row, never meets it -- and a ceiling on anonymous challenges
// outstanding at once, as the backstop against many addresses.
const ISSUE_WINDOW_MS = 60 * 1000;
const ISSUE_MAX_PER_WINDOW = 30;
const MAX_OUTSTANDING_ANONYMOUS = 10000;
const issued = new Map();

const tooManyIssued = (ip) => {
  const now = Date.now();
  const entry = issued.get(ip);
  if (!entry || now - entry.first > ISSUE_WINDOW_MS) {
    issued.set(ip, { n: 1, first: now });
    return false;
  }
  entry.n += 1;
  return entry.n > ISSUE_MAX_PER_WINDOW;
};

setInterval(() => {
  const cutoff = Date.now() - ISSUE_WINDOW_MS;
  for (const [k, v] of issued) if (v.first < cutoff) issued.delete(k);
}, ISSUE_WINDOW_MS).unref();

// Expired rows are swept here, every time a new one is written: often enough
// that the table stays small, and no scheduled job has to exist for it.
const storeChallenge = async (challenge, purpose, userId) => {
  await db.queryAuth("DELETE FROM passkey_challenges WHERE expires_at <= now()");
  await db.queryAuth(
    `INSERT INTO passkey_challenges (challenge, purpose, user_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [challenge, purpose, userId, new Date(Date.now() + CHALLENGE_TTL_MS)],
  );
};

// The challenge is read out of what the browser signed, and redeemed in the
// same statement that finds it: the row is gone before the signature is even
// checked, so a response can be used once and only once -- including a bad
// one. A 'register' challenge is only redeemable by the account it was issued
// to; an 'authenticate' one belongs to nobody.
const redeemChallenge = async (response, purpose, userId) => {
  let challenge;
  try {
    challenge = decodeClientDataJSON(response.response.clientDataJSON).challenge;
  } catch {
    return null;
  }
  if (typeof challenge !== "string" || !challenge) return null;

  const { rows } = await db.queryAuth(
    `DELETE FROM passkey_challenges
      WHERE challenge = $1
        AND purpose   = $2
        AND user_id IS NOT DISTINCT FROM $3
        AND expires_at > now()
  RETURNING challenge`,
    [challenge, purpose, userId],
  );
  return rows[0] ? rows[0].challenge : null;
};

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
// A name somebody typed, tidied: trimmed, inner whitespace collapsed, capped
// at the length the column allows. Empty comes back as null so each caller
// decides what empty means -- a default at registration, a refusal on rename.
const NAME_MAX = 64;
const cleanName = (raw) => {
  const name = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return name || null;
};

// What the profile page is told about a passkey. Not the key, not the counter,
// not the credential id: nothing it needs, and nothing worth showing.
const publicPasskey = (row) => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

// The account's user handle, created the first time it is needed. coalesce()
// makes the two-tabs-at-once case harmless: whichever write lands second keeps
// the first one's value.
const userHandle = async (userId) => {
  const { rows } = await db.queryAuth(
    `UPDATE users SET passkey_handle = coalesce(passkey_handle, $2)
      WHERE id = $1
  RETURNING passkey_handle`,
    [userId, isoBase64URL.fromBuffer(crypto.randomBytes(32))],
  );
  return rows[0].passkey_handle;
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
// A factory rather than a plain router: `fail` and `completeSignIn` live in
// routes.js, which mounts this, and passing them in keeps a single copy of
// each without the two files requiring one another.
const passkeyRoutes = ({ fail, completeSignIn, reauthenticate }) => {
  const r = router();

  // One refusal, shared by every way a passkey sign-in can go wrong: no such
  // challenge, no such credential, a bad signature, a counter gone backwards.
  // Telling them apart would help nobody but someone probing.
  //
  // Each one counts against the address it came from (never against the
  // account: see the top of this file). A signature cannot be guessed, but
  // every attempt costs a challenge row and a verification.
  const signInRefused = async (req, res) => {
    await limits.passkeyPerIp.hit(req.ip);
    return fail(res, 401, "PASSKEY_FAILED", "The passkey could not be verified");
  };

  const requireEnabled = (req, res, next) => {
    if (RELYING_PARTY) return next();
    fail(
      res,
      404,
      "PASSKEYS_DISABLED",
      "Passkeys are not enabled on this instance. Whoever administers it can enable " +
        "them by setting BUSSOLA_PUBLIC_URL to the address Bussola is served from over HTTPS.",
    );
  };

  const passkeyParam = (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
      return fail(res, 404, "PASSKEY_NOT_FOUND", "No such passkey");
    }
    req.passkeyId = id;
    next();
  };

  // --- registration ---------------------------------------------------------
  // Step one: the password again, then a challenge. Asking here rather than at
  // the end means the password is typed before the device prompt, which is the
  // order people expect, and the challenge itself becomes the proof that it
  // was: only an account that just typed its password holds one.
  r.post("/register/options", requireAuth, requireEnabled, async (req, res) => {
    try {
      // The same check as the password and username changes, and the same
      // throttle behind it (routes.js): not counted toward the account lock --
      // the caller is already inside, and a typo here must not lock them out --
      // but a stolen session cannot use it to try password after password.
      if (!(await reauthenticate(req, res, (req.body || {}).password))) return;

      const { rows } = await db.queryAuth("SELECT username FROM users WHERE id = $1", [
        req.user.id,
      ]);

      const { rows: existing } = await db.queryAuth(
        "SELECT credential_id, transports FROM passkeys WHERE user_id = $1",
        [req.user.id],
      );

      const options = await generateRegistrationOptions({
        rpName: RELYING_PARTY.rpName,
        rpID: RELYING_PARTY.rpID,
        userName: rows[0].username,
        userDisplayName: rows[0].username,
        userID: isoBase64URL.toBuffer(await userHandle(req.user.id)),
        timeout: CEREMONY_TIMEOUT_MS,
        // Nothing here decides anything on the strength of which authenticator
        // model it is, so there is no reason to ask for an attestation.
        attestationType: "none",
        // A device that already holds one of this account's passkeys is told
        // so, and says "already registered" instead of making a second.
        excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: c.transports })),
        authenticatorSelection: {
          // Discoverable, so the login screen needs no username: the device
          // itself knows which accounts it holds keys for.
          residentKey: "required",
          // The fingerprint (or face, or PIN) is the point: a key that only
          // proves somebody touched the phone is not a sign-in.
          userVerification: "required",
        },
      });

      await storeChallenge(options.challenge, "register", req.user.id);
      res.json(options);
    } catch (error) {
      console.error("Could not start the passkey registration:", error);
      fail(res, 500, "PASSKEY_REGISTRATION_FAILED", "Could not add the passkey");
    }
  });

  // Step two: the device's answer. It is checked against the challenge this
  // account was issued, the configured origin and rpID, and user verification.
  r.post("/register/verify", requireAuth, requireEnabled, async (req, res) => {
    const { response, name } = req.body || {};
    if (!response || typeof response !== "object" || !response.response) {
      return fail(res, 400, "PASSKEY_REGISTRATION_FAILED", "Could not add the passkey");
    }

    try {
      const challenge = await redeemChallenge(response, "register", req.user.id);
      if (!challenge) {
        return fail(
          res,
          400,
          "PASSKEY_CHALLENGE_EXPIRED",
          "The request expired or was already used. Start again.",
        );
      }

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge: challenge,
          expectedOrigin: RELYING_PARTY.origin,
          expectedRPID: RELYING_PARTY.rpID,
          requireUserVerification: true,
        });
      } catch (error) {
        console.warn(`[auth] passkey registration refused for user ${req.user.id}: ${error.message}`);
        return fail(res, 400, "PASSKEY_REGISTRATION_FAILED", "Could not add the passkey");
      }
      if (!verification.verified) {
        return fail(res, 400, "PASSKEY_REGISTRATION_FAILED", "Could not add the passkey");
      }

      const { credential } = verification.registrationInfo;
      const { rows } = await db.queryAuth(
        `INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, name)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          req.user.id,
          credential.id,
          Buffer.from(credential.publicKey),
          credential.counter || 0,
          Array.isArray(credential.transports) ? credential.transports.map(String) : [],
          cleanName(name) || "Passkey",
        ],
      );

      console.log(`[auth] "${req.user.username}" added a passkey ("${rows[0].name}").`);
      res.status(201).json(publicPasskey(rows[0]));
    } catch (error) {
      if (error.code === "23505") {
        return fail(res, 409, "PASSKEY_ALREADY_REGISTERED", "That passkey is already registered");
      }
      console.error("Could not add the passkey:", error);
      fail(res, 500, "PASSKEY_REGISTRATION_FAILED", "Could not add the passkey");
    }
  });

  // --- sign-in --------------------------------------------------------------
  // Usernameless: the challenge is issued to nobody in particular, the device
  // offers whichever of its passkeys belong to this site, and the credential
  // that comes back says whose account it is.
  r.post("/login/options", requireEnabled, async (req, res) => {
    if (tooManyIssued(req.ip)) {
      return fail(res, 429, "TOO_MANY_ATTEMPTS", "Too many attempts. Try again in a few minutes.");
    }

    try {
      const { rows } = await db.queryAuth(
        `SELECT count(*)::int AS n FROM passkey_challenges
          WHERE purpose = 'authenticate' AND expires_at > now()`,
      );
      if (rows[0].n >= MAX_OUTSTANDING_ANONYMOUS) {
        return fail(res, 429, "TOO_MANY_ATTEMPTS", "Too many attempts. Try again in a few minutes.");
      }

      const options = await generateAuthenticationOptions({
        rpID: RELYING_PARTY.rpID,
        timeout: CEREMONY_TIMEOUT_MS,
        userVerification: "required",
      });
      await storeChallenge(options.challenge, "authenticate", null);
      res.json(options);
    } catch (error) {
      console.error("Could not start the passkey sign-in:", error);
      fail(res, 500, "LOGIN_FAILED", "Login failed");
    }
  });

  // Every attempt has to redeem a fresh challenge, which the issuing limit
  // above already bounds; failures are throttled per address on top of that
  // (signInRefused), so one machine cannot keep the verifier busy.
  r.post("/login/verify", requireEnabled, async (req, res) => {
    const wait = await limits.passkeyPerIp.blocked(req.ip);
    if (wait) return tooMany(res, wait);

    const { response } = req.body || {};
    if (!response || typeof response !== "object" || !response.response || !response.id) {
      return signInRefused(req, res);
    }

    try {
      const challenge = await redeemChallenge(response, "authenticate", null);
      if (!challenge) return signInRefused(req, res);

      // Faster to answer for an unknown credential than for a bad signature,
      // and that is fine: a credential id is random bytes the device made up,
      // tied to no username, so learning that one does not exist tells nobody
      // anything about who has an account here.
      const { rows: found } = await db.queryAuth(
        "SELECT * FROM passkeys WHERE credential_id = $1",
        [String(response.id)],
      );
      const passkey = found[0];
      if (!passkey) return signInRefused(req, res);

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: challenge,
          expectedOrigin: RELYING_PARTY.origin,
          expectedRPID: RELYING_PARTY.rpID,
          requireUserVerification: true,
          credential: {
            id: passkey.credential_id,
            publicKey: new Uint8Array(passkey.public_key),
            counter: Number(passkey.counter),
            transports: passkey.transports,
          },
        });
      } catch (error) {
        // Includes a counter that did not move forward: the library refuses
        // it, because that is what a cloned authenticator looks like.
        console.warn(`[auth] passkey ${passkey.id} refused: ${error.message}`);
        return signInRefused(req, res);
      }
      if (!verification.verified) return signInRefused(req, res);

      // With the lock computed, which completeSignIn needs to refuse on it.
      const user = await lockout.findById(passkey.user_id);

      // The device vouched for the handle it stored at registration. It has to
      // be this account's: a mismatch means the credential and the account no
      // longer describe the same person, and that is a refusal like any other.
      const handle = response.response.userHandle;
      if (!user || (handle && handle !== user.passkey_handle)) return signInRefused(req, res);

      // The signature was valid, so the counter and the last use are recorded
      // whatever happens next -- GREATEST so that two sign-ins racing cannot
      // move it backwards.
      await db.queryAuth(
        `UPDATE passkeys
            SET counter = GREATEST(counter, $2), last_used_at = now()
          WHERE id = $1`,
        [passkey.id, verification.authenticationInfo.newCounter],
      );

      // Only now, with the identity proven, is it safe to say the account is
      // switched off or held by the wrong-password lock -- the same reasoning,
      // and the same answers, as a correct password. completeSignIn says it and
      // opens nothing: a passkey is not a way around the lock or an
      // administrator's decision.
      await completeSignIn(req, res, user);
    } catch (error) {
      console.error("Passkey sign-in failed:", error);
      fail(res, 500, "LOGIN_FAILED", "Login failed");
    }
  });

  // --- managing one's own ---------------------------------------------------
  // Every statement names req.user.id: somebody else's passkey is not a 403
  // but a 404, because from here it does not exist. Listing, renaming and
  // removing keep working when passkeys are switched off, so that an instance
  // that turns them off can still be tidied up.
  r.get("/", requireAuth, async (req, res) => {
    try {
      const { rows } = await db.queryAuth(
        `SELECT id, name, created_at, last_used_at FROM passkeys
          WHERE user_id = $1 ORDER BY created_at, id`,
        [req.user.id],
      );
      res.json(rows.map(publicPasskey));
    } catch (error) {
      console.error("Could not list the passkeys:", error);
      fail(res, 500, "PASSKEY_LIST_FAILED", "Could not list the passkeys");
    }
  });

  r.post("/:id/name", requireAuth, passkeyParam, async (req, res) => {
    const name = cleanName((req.body || {}).name);
    if (!name) return fail(res, 400, "INVALID_PASSKEY_NAME", "The passkey needs a name");

    try {
      const { rows } = await db.queryAuth(
        `UPDATE passkeys SET name = $3 WHERE id = $1 AND user_id = $2
         RETURNING id, name, created_at, last_used_at`,
        [req.passkeyId, req.user.id, name],
      );
      if (!rows[0]) return fail(res, 404, "PASSKEY_NOT_FOUND", "No such passkey");
      res.json(publicPasskey(rows[0]));
    } catch (error) {
      console.error("Could not rename the passkey:", error);
      fail(res, 500, "PASSKEY_RENAME_FAILED", "Could not rename the passkey");
    }
  });

  // No password asked: removing a passkey only takes a way in away, and the
  // password -- which always remains -- is still there. The device keeps its
  // half until somebody deletes it there too; without the public key here it
  // opens nothing.
  r.delete("/:id", requireAuth, passkeyParam, async (req, res) => {
    try {
      const { rows } = await db.queryAuth(
        "DELETE FROM passkeys WHERE id = $1 AND user_id = $2 RETURNING name",
        [req.passkeyId, req.user.id],
      );
      if (!rows[0]) return fail(res, 404, "PASSKEY_NOT_FOUND", "No such passkey");

      console.log(`[auth] "${req.user.username}" removed a passkey ("${rows[0].name}").`);
      res.json({ ok: true });
    } catch (error) {
      console.error("Could not remove the passkey:", error);
      fail(res, 500, "PASSKEY_DELETE_FAILED", "Could not remove the passkey");
    }
  });

  return r;
};

module.exports = { relyingParty, passkeyRoutes, parseRelyingParty };
