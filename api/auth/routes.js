const router = require("express").Router();
const db = require("../dbConn");
const sessions = require("./sessions");
const { hashPassword, verifyPassword, passwordAcceptable, MIN_PASSWORD_LENGTH } = require("./password");
const { requireAuth, requireAdmin } = require("./middleware");
const { createAccount, createWalletWithStarterData } = require("./bootstrap");
const wallets = require("./wallets");
const { relyingParty, passkeyRoutes } = require("./passkeys");
const { tokenRoutes } = require("./tokens");
const { pushRoutes } = require("./push");
const push = require("../services/push");
const lockout = require("./lockout");
const { limits, tooMany } = require("./throttle");
const { quotesEnabled, quoteSources } = require("../services/quotes");
const { aiEnabled, aiCloud } = require("../services/inbox/extract");
const { bankNamesRoute } = require("./bankNames");

// Every error carries a stable code alongside its English text. The interface
// translates the code and falls back to the text, so switching the UI language
// does not leave error messages stranded in English.
const fail = (res, status, code, message) => res.status(status).json({ code, error: message });

// A username, not an address: this application has never sent an email, so
// demanding the shape of one only ever refused good names. Letters, digits and
// a few separators, because it also has to be typeable on a phone keyboard.
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,64}$/;
const validUsername = (name) => typeof name === "string" && USERNAME_RE.test(name);

const signupOpen = () => (process.env.BUSSOLA_SIGNUP || "closed").toLowerCase() === "open";

// The throttles live in throttle.js and the account lock in lockout.js. The
// keys below are what each throttle counts against.
const userKey = (req, username) => `${req.ip}|${String(username || "").toLowerCase()}`;

// The current password, asked again of somebody already signed in (password
// and username changes; passkeys.js does the same before adding a passkey).
// Wrong answers are throttled per account, so a stolen session is not a free
// brute-force oracle for the password behind it. They do not feed the account
// lock: the caller is already inside, and a typo here must not lock them out.
// Answers the refusal itself and returns false when the password was not right.
const reauthenticate = async (req, res, password) => {
  const key = String(req.user.id);
  const wait = await limits.reauthPerUser.blocked(key);
  if (wait) {
    tooMany(res, wait);
    return false;
  }

  const { rows } = await db.queryAuth("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
  if (!(await verifyPassword(String(password || ""), rows[0] && rows[0].password_hash))) {
    await limits.reauthPerUser.hit(key);
    fail(res, 401, "WRONG_CURRENT_PASSWORD", "Current password is not correct");
    return false;
  }
  await limits.reauthPerUser.reset(key);
  return true;
};

const publicProfile = (u) => ({
  id: u.id,
  username: u.username,
  email: u.email,
  locale: u.locale,
  currency: u.currency,
  isAdmin: u.is_admin,
  // The wallet in context, or null when none is chosen: the frontend shows
  // the picker on null rather than an app with nothing to show.
  wallet: u.wallet || null,
  // Whether this instance has a quote service: without one the refresh
  // buttons are drawn disabled rather than left to fail with QUOTES_DISABLED.
  quotes: quotesEnabled(),
  // Which providers the quote service has on (ids, no keys): the interface
  // credits Eulerpool, whose free plan requires it, only when it is one.
  quoteSources: quoteSources(),
  // Whether bank notifications are read by a model (BUSSOLA_AI_URL + MODEL):
  // the inbox says "Reading..." only when something is reading.
  ai: aiEnabled(),
  // Whether that model is outside the owner's network (a yes or
  // no: the About page says it; hosts, models and keys are never exposed).
  aiCloud: aiCloud(),
  // How this person's banks write their name (auth/bankNames.js).
  bankNames: u.bank_names || [],
});

const token = (req) => (req.cookies ? req.cookies[sessions.COOKIE_NAME] : null);

// What the frontend is told about a wallet: which one, what this account may
// do in it, and whether it may change who else is in it. canManage decides
// what gets drawn; the endpoints check it again for themselves.
const walletShape = (wallet, role, userId, isAdmin) => ({
  id: wallet.id,
  name: wallet.name,
  // The unit its amounts are counted in, so the interface can format them
  // without asking a second time. Shared by every member -- the language is
  // personal, the currency is a property of the money itself.
  currency: wallet.currency || wallets.DEFAULT_CURRENCY,
  role,
  canManage: Boolean(isAdmin) || wallet.created_by === userId,
});

// Signing in with exactly one wallet should not stop to ask which one. With
// more than one the choice is real and the picker is shown; with none -- a new
// account nobody has shared a wallet with yet, or one whose only wallet was
// taken away -- so is it, asking for the name of a new one.
//
// The session token is passed in rather than read from the request: at login
// the cookie is on its way out in the response and is not on the way in yet.
const autoSelectWallet = async (sessionToken, userId, isAdmin) => {
  const list = await wallets.listForUser(userId);
  if (list.length !== 1) return null;

  await sessions.setSessionWallet(sessionToken, list[0].id);
  return walletShape(list[0], list[0].role, userId, isAdmin);
};

// The moment after the proof. Whatever established who this is -- a password
// here, a passkey in passkeys.js -- the rest is the same: a fresh session, the
// failure count wiped, the cookie, and the wallet chosen when there is only
// one to choose. One function, so the two ways in cannot drift apart.
//
// That includes the refusals that may only be spoken once the proof is in: an
// account an administrator switched off, and one the wrong-password lock is
// holding shut. Both are checked here, so neither way in can forget them.
// `user` must come from lockout.findByUsername/findById, which compute the
// lock. Returns true when a session was opened.
const completeSignIn = async (req, res, user) => {
  if (lockout.refuseIfLocked(res, user)) return false;

  const { token, expiresAt } = await sessions.createSession(user.id, req.get("user-agent"));
  await db.queryAuth(`UPDATE users SET last_login = now(), ${lockout.CLEARED} WHERE id = $1`, [
    user.id,
  ]);

  res.cookie(sessions.COOKIE_NAME, token, sessions.cookieOptions(expiresAt));
  res.json({ ...publicProfile(user), wallet: await autoSelectWallet(token, user.id, user.is_admin) });
  return true;
};

// Deleting an account, on the caller's transaction: the wallets it created go
// first -- with everything in them, for every member they were shared with --
// because a wallet whose creator is gone has nobody left to manage its
// members, and one it was the only member of would be unreachable by anyone.
// Wallets somebody else created and shared with it stay; it simply stops being
// a member. Sessions, passkeys and memberships follow the user row (ON DELETE
// CASCADE); rows it created in other people's wallets keep existing with
// created_by set to NULL. Anyone who was looking at a deleted wallet lands on
// the picker at their next request (sessions.wallet_id, SET NULL).
//
// One copy for both ways an account goes: the administrator's DELETE
// /users/:username and the account's own DELETE /me. Returns the wallets
// deleted.
const deleteAccountAndWallets = async (client, userId) => {
  const { rows: gone } = await client.query(
    "DELETE FROM wallets WHERE created_by = $1 RETURNING id, name",
    [userId],
  );
  await client.query("DELETE FROM users WHERE id = $1", [userId]);
  return gone;
};

// The only trace that will remain, since the rows themselves are gone.
const logAccountDeleted = (user, by, gone) =>
  console.log(
    `[auth] account "${user.username}" (id ${user.id}) deleted by "${by}", ` +
      `with ${gone.length} wallet(s) it created` +
      (gone.length ? `: ${gone.map((w) => `${w.id} "${w.name}"`).join(", ")}` : "") +
      ".",
  );

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Who am I. The frontend calls this at boot to decide whether to show login.
router.get("/me", (req, res) => {
  if (!req.user) return fail(res, 401, "NOT_AUTHENTICATED", "Not authenticated");
  res.json(publicProfile(req.user));
});

// What this instance offers: lets the frontend show or hide the "sign up"
// link instead of having to guess.
//
// passkeyOrigin is the one address passkeys work from. The login page compares
// it with its own location: opened on the LAN address of an instance whose
// passkeys belong to its public domain, the browser would refuse the ceremony,
// and a button that can only fail is better not drawn. It is the configured
// public URL, so it discloses nothing that is not already on the address bar.
router.get("/status", (req, res) => {
  const rp = relyingParty();
  res.json({
    signupOpen: signupOpen(),
    passkeys: Boolean(rp),
    passkeyOrigin: rp ? rp.origin : null,
    // Web Push (services/push.js): on when BUSSOLA_PUBLIC_URL is, like the
    // passkeys. The VAPID public key is public by design: the browser needs it
    // to subscribe.
    push: push.enabled(),
    pushPublicKey: push.publicKey(),
  });
});

router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  const perUser = userKey(req, username);

  // Two throttles: one address against one username, and one address against
  // all of them, which is what stops a single machine from trying one common
  // password on every account in turn.
  const wait = Math.max(
    ...(await Promise.all([limits.loginPerUser.blocked(perUser), limits.loginPerIp.blocked(req.ip)])),
  );
  if (wait) return tooMany(res, wait);

  try {
    const user = await lockout.findByUsername(username);

    // Same message and same cost either way: verifyPassword runs a full scrypt
    // against a dummy hash when there is no account, so the timing does not
    // reveal who has one here. A locked account is checked too, for the same
    // reason -- and because its lock may only be mentioned after a right answer.
    const ok = await verifyPassword(String(password || ""), user ? user.password_hash : null);

    if (!ok) {
      await Promise.all([limits.loginPerUser.hit(perUser), limits.loginPerIp.hit(req.ip)]);
      await lockout.recordWrongPassword(user);
      return fail(res, 401, "INVALID_CREDENTIALS", "Wrong username or password");
    }

    // The password was right, so it is now safe to say the account is
    // disabled or locked: completeSignIn does, and opens nothing if so.
    if (await completeSignIn(req, res, user)) await limits.loginPerUser.reset(perUser);
  } catch (error) {
    console.error("Login failed:", error);
    fail(res, 500, "LOGIN_FAILED", "Login failed");
  }
});

router.post("/logout", async (req, res) => {
  const token = req.cookies ? req.cookies[sessions.COOKIE_NAME] : null;
  try {
    if (token) await sessions.deleteSession(token);
  } catch (error) {
    console.error("Logout failed:", error.message);
  }
  res.clearCookie(sessions.COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

router.post("/signup", async (req, res) => {
  if (!signupOpen()) {
    return fail(
      res,
      403,
      "SIGNUP_CLOSED",
      "Sign-up is closed on this instance. Whoever administers it can open it " +
        "by setting BUSSOLA_SIGNUP=open.",
    );
  }

  // Every attempt counts, successful or not: each runs a 64 MB scrypt.
  const wait = await limits.signupPerIp.blocked(req.ip);
  if (wait) return tooMany(res, wait);
  await limits.signupPerIp.hit(req.ip);

  const { username, password, locale } = req.body || {};
  if (!validUsername(username)) {
    return fail(
      res,
      400,
      "INVALID_USERNAME",
      "The username must be 3 to 64 characters: letters, digits, dot, dash or underscore",
    );
  }
  if (!passwordAcceptable(password)) {
    return fail(
      res,
      400,
      "PASSWORD_TOO_SHORT",
      `The password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
    );
  }

  try {
    // The account only. The answer's `wallet` is null, so the interface shows
    // the picker: the wallets shared with this account so far (none, unless
    // somebody was quick), and a field to name a first one of its own.
    const { user } = await createAccount({
      username,
      passwordHash: await hashPassword(password),
      locale: String(locale || "").slice(0, 2) || null,
    });

    const { token, expiresAt } = await sessions.createSession(user.id, req.get("user-agent"));
    res.cookie(sessions.COOKIE_NAME, token, sessions.cookieOptions(expiresAt));
    res.status(201).json({
      ...publicProfile(user),
      wallet: await autoSelectWallet(token, user.id, user.is_admin),
    });
  } catch (error) {
    if (error.code === "23505") {
      return fail(res, 409, "USERNAME_TAKEN", "That username is already taken");
    }
    console.error("Sign-up failed:", error);
    fail(res, 500, "SIGNUP_FAILED", "Sign-up failed");
  }
});

// The interface language, stored on the account so the choice follows the
// person to any browser they sign in from. The interface has already switched
// by the time this is called: failing here costs nothing but the persistence.
router.post("/locale", requireAuth, async (req, res) => {
  const locale = String((req.body || {}).locale || "").slice(0, 2).toLowerCase();
  if (!/^[a-z]{2}$/.test(locale)) return fail(res, 400, "INVALID_LOCALE", "Invalid locale");

  try {
    await db.queryAuth("UPDATE users SET locale = $1 WHERE id = $2", [locale, req.user.id]);
    res.json({ locale });
  } catch (error) {
    console.error("Could not save the locale:", error);
    fail(res, 500, "LOCALE_SAVE_FAILED", "Could not save the language");
  }
});

// The names the notification reader is told are the user's own.
router.post("/bank-names", ...bankNamesRoute(fail));

router.post("/password", requireAuth, async (req, res) => {
  const { current, next } = req.body || {};
  if (!passwordAcceptable(next)) {
    return fail(
      res,
      400,
      "PASSWORD_TOO_SHORT",
      `The password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
    );
  }

  try {
    if (!(await reauthenticate(req, res, current))) return;

    await db.queryAuth("UPDATE users SET password_hash = $1 WHERE id = $2", [
      await hashPassword(next),
      req.user.id,
    ]);

    // Changing a password must throw out anyone else who was inside: that is
    // precisely the fear that makes someone change it. The caller stays, on a
    // new session that keeps the wallet it was looking at (and this device's
    // notifications); if that wallet is gone, the usual choice is made again.
    const fresh = await sessions.replaceUserSessions(
      token(req),
      req.user.id,
      req.get("user-agent"),
      req.user.wallet ? req.user.wallet.id : null,
    );
    if (!fresh.walletId) await autoSelectWallet(fresh.token, req.user.id, req.user.is_admin);
    res.cookie(sessions.COOKIE_NAME, fresh.token, sessions.cookieOptions(fresh.expiresAt));
    res.json({ ok: true });
  } catch (error) {
    console.error("Password change failed:", error);
    fail(res, 500, "PASSWORD_CHANGE_FAILED", "Password change failed");
  }
});

// The username is the credential you type to get in, so changing it asks for
// the password: a session left open on a borrowed machine should not be enough
// to rename somebody's account out from under them.
router.post("/username", requireAuth, async (req, res) => {
  const { username, password } = req.body || {};

  try {
    if (!(await reauthenticate(req, res, password))) return;
    const { rows } = await db.queryAuth("SELECT username FROM users WHERE id = $1", [req.user.id]);

    if (!validUsername(username)) {
      return fail(
        res,
        400,
        "INVALID_USERNAME",
        "The username must be 3 to 64 characters: letters, digits, dot, dash or underscore",
      );
    }

    // Already this name. Uniqueness is case-insensitive, so "Marco" and
    // "marco" are the same name and there is nothing to write; answering 200
    // is truer than a 409 about a collision with oneself. The stored spelling
    // comes back, because that is what the account is actually called.
    if (rows[0].username.toLowerCase() === username.toLowerCase()) {
      return res.json({ username: rows[0].username });
    }

    // Asked first so the answer is a readable 409 rather than a constraint
    // violation -- and caught again below, because between this SELECT and the
    // UPDATE somebody else may have taken the name. The index is the authority;
    // this query is only for the wording.
    const { rows: clash } = await db.queryAuth(
      "SELECT 1 FROM users WHERE lower(username) = lower($1) AND id <> $2",
      [username, req.user.id],
    );
    if (clash[0]) return fail(res, 409, "USERNAME_TAKEN", "That username is already taken");

    const { rows: updated } = await db.queryAuth(
      "UPDATE users SET username = $1 WHERE id = $2 RETURNING username",
      [username, req.user.id],
    );

    // Open sessions are deliberately left alone. A session resolves to a
    // user_id and never to a username, so none of them refers to the old name,
    // and unlike a password change nothing secret has been rotated: there is
    // nobody to throw out. Signing out every device to change a display of
    // one's own name would be theatre.
    res.json({ username: updated[0].username });
  } catch (error) {
    if (error.code === "23505") {
      return fail(res, 409, "USERNAME_TAKEN", "That username is already taken");
    }
    console.error("Username change failed:", error);
    fail(res, 500, "USERNAME_CHANGE_FAILED", "Could not change the username");
  }
});

// Deleting one's own account: the administrator's deletion below, asked for by
// the person themselves -- the right to erasure, and a way out that does not
// depend on somebody else. It takes every wallet this account created, the
// first one included: FIRST_WALLET exists so that an account is never left
// with nowhere to put anything, and an account that is going needs nowhere.
//
// Two proofs, as for the other credential operations: the password, so that a
// session left open on a borrowed machine is not enough to erase somebody, and
// the username typed back, so that a slip of the finger is not enough either.
//
// An administrator cannot leave this way. The first one is created from
// BUSSOLA_AUTH_* at first boot and is meant to live as long as the instance:
// without it nobody can unlock or delete accounts, and only a shell could put
// one back. The same refusal the admin endpoint below gives for oneself.
router.delete("/me", requireAuth, async (req, res) => {
  if (req.user.is_admin) {
    return fail(res, 409, "CANNOT_DELETE_SELF", "An administrator's account cannot be deleted");
  }

  const { password, confirm } = req.body || {};
  if (String(confirm || "").trim().toLowerCase() !== req.user.username.toLowerCase()) {
    return fail(res, 400, "USERNAME_MISMATCH", "Type your username exactly to confirm");
  }

  try {
    if (!(await reauthenticate(req, res, password))) return;

    const gone = await db.transactionAuth((client) => deleteAccountAndWallets(client, req.user.id));

    logAccountDeleted(req.user, "themselves", gone);
    // The session row went with the account; the cookie is only a name now.
    res.clearCookie(sessions.COOKIE_NAME, { path: "/" });
    res.json({ ok: true, walletsDeleted: gone.length });
  } catch (error) {
    console.error("Could not delete the account:", error);
    fail(res, 500, "USER_DELETE_FAILED", "Could not delete the account");
  }
});

// ---------------------------------------------------------------------------
// Passkeys
// ---------------------------------------------------------------------------
// A second way to prove who you are, never a replacement for the password. The
// ceremonies live in passkeys.js; what happens once one succeeds is
// completeSignIn above, handed over so there is one copy of it.
router.use("/passkeys", passkeyRoutes({ fail, completeSignIn, reauthenticate }));

// ---------------------------------------------------------------------------
// Personal API tokens
// ---------------------------------------------------------------------------
// For apps and automations that post bank notifications to the inbox. Making
// one asks for the password again, like adding a passkey; tokens.js explains
// why and what a token can (very little) do.
router.use("/tokens", tokenRoutes({ fail, reauthenticate }));

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------
// A device's subscription to "something is waiting in the inbox" (push.js).
router.use("/push", pushRoutes({ fail }));

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------
// The data lives in a wallet and people reach it through a membership. These
// endpoints are about *who may open what*; what a member can then do with the
// data is decided by the RLS policies, not here.

// The wallets I can open, with my role on each. This is what fills the picker.
router.get("/wallets", requireAuth, async (req, res) => {
  try {
    res.json(await wallets.listForUser(req.user.id));
  } catch (error) {
    console.error("Could not list the wallets:", error);
    fail(res, 500, "WALLET_LIST_FAILED", "Could not list the wallets");
  }
});

// Create one and open it. The creator joins it as rw and gets the same starter
// data a new account gets: an empty wallet is a form that refuses to be filled
// in.
router.post("/wallets", requireAuth, async (req, res) => {
  const name = wallets.cleanName((req.body || {}).name);
  if (!name) return fail(res, 400, "INVALID_WALLET_NAME", "The wallet needs a name");

  try {
    // The new wallet counts in the same currency as the one this session was
    // looking at. Somebody with a second wallet almost always keeps the same
    // money in it, and being handed a euro wallet when everything else you own
    // is in francs is a setting you have to go and correct. With no wallet in
    // context -- the very first one an account gets -- the column default
    // applies and the owner can change it on the profile page.
    const currency = req.user.wallet ? req.user.wallet.currency : null;
    const wallet = await createWalletWithStarterData(req.user, name, req.user.locale, currency);
    await sessions.setSessionWallet(token(req), wallet.id);

    res.status(201).json(walletShape(wallet, "rw", req.user.id, req.user.is_admin));
  } catch (error) {
    console.error("Could not create the wallet:", error);
    fail(res, 500, "WALLET_CREATE_FAILED", "Could not create the wallet");
  }
});

// Choose which wallet this session is looking at. The membership is checked
// here, and again by every policy on every statement afterwards: naming a
// wallet is not the same as being allowed into it.
router.post("/wallet", requireAuth, async (req, res) => {
  const walletId = Number((req.body || {}).walletId);
  if (!Number.isInteger(walletId)) return fail(res, 400, "INVALID_WALLET", "Invalid wallet");

  try {
    const role = await wallets.roleFor(walletId, req.user.id);
    if (!role) return fail(res, 403, "NOT_A_MEMBER", "You are not a member of that wallet");

    const wallet = await wallets.byId(walletId);
    await sessions.setSessionWallet(token(req), walletId);
    res.json(walletShape(wallet, role, req.user.id, req.user.is_admin));
  } catch (error) {
    console.error("Could not select the wallet:", error);
    fail(res, 500, "WALLET_SELECT_FAILED", "Could not select the wallet");
  }
});

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------
// Reading the list is open to every member: knowing who else can see your
// accounts is the point, and it is what makes an administrator adding
// themselves to a wallet visible rather than silent. Changing it is not.
const walletParam = (req, res, next) => {
  const walletId = Number(req.params.id);
  if (!Number.isInteger(walletId)) return fail(res, 400, "INVALID_WALLET", "Invalid wallet");
  req.walletId = walletId;
  next();
};

const requireMember = async (req, res, next) => {
  try {
    if (await wallets.roleFor(req.walletId, req.user.id)) return next();
    if (await wallets.canManage(req.user, req.walletId)) return next();
    fail(res, 403, "NOT_A_MEMBER", "You are not a member of that wallet");
  } catch (error) {
    console.error("Membership check failed:", error);
    fail(res, 500, "REQUEST_FAILED", "Request failed");
  }
};

// Whoever created a wallet manages its members, and so does the instance
// administrator. Two roles were enough for the data; a third one just to say
// "may invite" would not have earned its keep.
const requireManager = async (req, res, next) => {
  try {
    if (await wallets.canManage(req.user, req.walletId)) return next();
    fail(res, 403, "NOT_WALLET_MANAGER", "Only the wallet's owner or an administrator can do this");
  } catch (error) {
    console.error("Manager check failed:", error);
    fail(res, 500, "REQUEST_FAILED", "Request failed");
  }
};

// The refusals wallets.addMember/setRole/removeMember can come back with.
const membershipRefusal = (res, status) => {
  switch (status) {
    case "LAST_WRITER":
      return fail(res, 409, "LAST_WRITER", "A wallet needs at least one member who can write");
    case "USER_NOT_FOUND":
      return fail(res, 404, "USER_NOT_FOUND", "No account with that username");
    case "WALLET_NOT_FOUND":
      return fail(res, 404, "WALLET_NOT_FOUND", "No such wallet");
    default:
      return fail(res, 404, "NOT_A_MEMBER", "That account is not a member of this wallet");
  }
};

router.get("/wallets/:id/members", requireAuth, walletParam, requireMember, async (req, res) => {
  try {
    res.json(await wallets.members(req.walletId));
  } catch (error) {
    console.error("Could not list the members:", error);
    fail(res, 500, "MEMBER_LIST_FAILED", "Could not list the members");
  }
});

// By username: on a self-hosted instance the two people have already agreed
// offline, and there is no mailbox to send an invitation to. Adding somebody
// who is already there changes their role instead of failing, which is what
// the caller meant either way.
//
// The answer says whether the username exists -- it has to: the name either
// shows up in the members list or it does not. So the refusal stays a 404,
// and what is limited is asking: ten names that do not exist per account per
// quarter of an hour, which a person mistyping never meets and which makes
// walking a list of names through this form pointless. (With sign-up open,
// USERNAME_TAKEN says the same thing, under its own per-address limit.)
router.post("/wallets/:id/members", requireAuth, walletParam, requireManager, async (req, res) => {
  const { username, role } = req.body || {};
  if (!wallets.validRole(role)) return fail(res, 400, "INVALID_ROLE", "The role must be rw or r");

  const lookups = String(req.user.id);
  const wait = await limits.memberLookupPerUser.blocked(lookups);
  if (wait) return tooMany(res, wait);

  try {
    const result = await wallets.addMember(req.walletId, username, role);
    if (result.status === "USER_NOT_FOUND") await limits.memberLookupPerUser.hit(lookups);
    if (result.status !== "OK") return membershipRefusal(res, result.status);
    const added = result.user;

    console.log(
      `[auth] "${added.username}" now has ${role} on wallet ${req.walletId} ` +
        `(by "${req.user.username}").`,
    );
    res.status(201).json({ id: added.id, username: added.username, role });
  } catch (error) {
    console.error("Could not add the member:", error);
    fail(res, 500, "MEMBER_ADD_FAILED", "Could not add the member");
  }
});

router.post(
  "/wallets/:id/members/:userId",
  requireAuth,
  walletParam,
  requireManager,
  async (req, res) => {
    const userId = Number(req.params.userId);
    const { role } = req.body || {};
    if (!Number.isInteger(userId)) return fail(res, 400, "USER_NOT_FOUND", "No such account");
    if (!wallets.validRole(role)) return fail(res, 400, "INVALID_ROLE", "The role must be rw or r");

    try {
      // Demoting the last read-write member would leave a wallet nobody can
      // write to and nobody can share: wallets.setRole refuses it, atomically.
      const status = await wallets.setRole(req.walletId, userId, role);
      if (status !== "OK") return membershipRefusal(res, status);
      res.json({ id: userId, role });
    } catch (error) {
      console.error("Could not change the role:", error);
      fail(res, 500, "MEMBER_ROLE_FAILED", "Could not change the role");
    }
  },
);

router.delete(
  "/wallets/:id/members/:userId",
  requireAuth,
  walletParam,
  async (req, res, next) => {
    // Leaving a wallet somebody shared with you needs nobody's permission.
    if (Number(req.params.userId) === req.user.id) return next();
    return requireManager(req, res, next);
  },
  async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) return fail(res, 400, "USER_NOT_FOUND", "No such account");

    try {
      const status = await wallets.removeMember(req.walletId, userId);
      if (status !== "OK") return membershipRefusal(res, status);

      // Anyone who was looking at it stops looking at it. The session stays
      // valid: they land on the picker, not on the login screen.
      await wallets.clearFromUserSessions(req.walletId, userId);
      res.json({ ok: true });
    } catch (error) {
      console.error("Could not remove the member:", error);
      fail(res, 500, "MEMBER_REMOVE_FAILED", "Could not remove the member");
    }
  },
);

// ---------------------------------------------------------------------------
// Renaming and deleting a wallet
// ---------------------------------------------------------------------------
// Down here, below the members, because they need walletParam and
// requireManager and those are defined above. Which is also the rule: whoever
// decides who may come in decides what happens to the wallet itself.

router.post("/wallets/:id/name", requireAuth, walletParam, requireManager, async (req, res) => {
  const name = wallets.cleanName((req.body || {}).name);
  if (!name) return fail(res, 400, "INVALID_WALLET_NAME", "The wallet needs a name");

  try {
    const wallet = await wallets.rename(req.walletId, name);
    // Only an administrator gets this far on a wallet that is not there:
    // canManage() short-circuits on is_admin without looking it up.
    if (!wallet) return fail(res, 404, "WALLET_NOT_FOUND", "No such wallet");

    res.json({ id: wallet.id, name: wallet.name });
  } catch (error) {
    console.error("Could not rename the wallet:", error);
    fail(res, 500, "WALLET_RENAME_FAILED", "Could not rename the wallet");
  }
});

// The currency the wallet's amounts are counted in. Guarded by requireManager,
// exactly like the rename above and for the same reason: it is a property of
// the wallet, every member reads it, and so it is the owner's to set and not
// each member's. A read-write member changes the numbers; only the owner
// changes what the numbers mean.
//
// It converts nothing. 1000 stays 1000 and the symbol beside it changes --
// this application has never known an exchange rate, and pretending otherwise
// by multiplying every row would be the one operation here that silently
// rewrites data.
//
// The allow-list lives in auth/wallets.js and is the source of truth;
// frontend/src/config.js carries the same codes to fill the picker.
router.post("/wallets/:id/currency", requireAuth, walletParam, requireManager, async (req, res) => {
  const currency = wallets.cleanCurrency((req.body || {}).currency);
  if (!wallets.validCurrency(currency)) {
    return fail(res, 400, "INVALID_CURRENCY", "That is not a currency this instance offers");
  }

  try {
    const wallet = await wallets.setCurrency(req.walletId, currency);
    // Only an administrator gets this far on a wallet that is not there:
    // canManage() short-circuits on is_admin without looking it up.
    if (!wallet) return fail(res, 404, "WALLET_NOT_FOUND", "No such wallet");

    res.json({ id: wallet.id, name: wallet.name, currency: wallet.currency });
  } catch (error) {
    console.error("Could not change the wallet's currency:", error);
    fail(res, 500, "WALLET_CURRENCY_FAILED", "Could not change the currency");
  }
});

// The most destructive thing this application can do. The foreign keys cascade
// from wallets down to all four data tables, so this takes the accounts, the
// categories, the transactions and the holdings with it, and nothing here
// keeps a copy.
//
// Hence the confirmation, and hence it being checked here: a dialog that asks
// "are you sure" is a courtesy of the interface, while the rule has to live
// where nobody can skip it by calling the endpoint directly.
router.delete("/wallets/:id", requireAuth, walletParam, requireManager, async (req, res) => {
  try {
    const wallet = await wallets.byId(req.walletId);
    if (!wallet) return fail(res, 404, "WALLET_NOT_FOUND", "No such wallet");

    if (String((req.body || {}).confirm || "").trim() !== wallet.name) {
      return fail(res, 400, "CONFIRMATION_MISMATCH", "Type the wallet's name exactly to confirm");
    }

    // The wallet sign-up handed somebody is not deletable: without it they are
    // left with an account that has nowhere to put anything and a picker whose
    // only offer is "create". Every other wallet they made themselves, and
    // deleting one of those leaves them with somewhere to land.
    // The administrator is exempt: deleting the account would take this
    // wallet anyway, and cleaning up an instance is their job.
    if (!req.user.is_admin && (await wallets.isFirst(req.walletId))) {
      return fail(res, 409, "FIRST_WALLET", "The first wallet of an account cannot be deleted");
    }

    const { rowCount } = await wallets.remove(req.walletId);

    // Anyone who was looking at it stops looking at it and lands on the picker
    // rather than the login screen -- their session is still perfectly valid,
    // only its choice is gone. The foreign key on sessions.wallet_id is ON
    // DELETE SET NULL and has already done this; saying it out loud means the
    // behaviour does not depend on remembering that.
    await wallets.clearFromSessions(req.walletId);

    // The only trace that will remain of it, since the rows themselves are
    // gone.
    console.log(
      `[auth] wallet ${req.walletId} "${wallet.name}" deleted by "${req.user.username}" ` +
        `(${rowCount} wallet row, and everything the cascade took with it).`,
    );
    res.json({ ok: true });
  } catch (error) {
    console.error("Could not delete the wallet:", error);
    fail(res, 500, "WALLET_DELETE_FAILED", "Could not delete the wallet");
  }
});

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------
// Enough to find and open an account that is locked or switched off. Keyed on
// the username rather than the id, because that is what an admin has to hand:
// the name the person typed when they could not get in.

router.get("/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    // `locked` is the wrong-password lock as it stands right now; it lifts by
    // itself at locked_until, and the unlock below lifts it sooner.
    const { rows } = await db.queryAuth(
      `SELECT id, username, is_admin, active, failed_logins, locked_at, locked_until,
              (locked_until IS NOT NULL AND locked_until > now()) AS locked, last_login
         FROM users ORDER BY id`,
    );
    res.json(rows);
  } catch (error) {
    console.error("Could not list users:", error);
    fail(res, 500, "USER_LIST_FAILED", "Could not list the accounts");
  }
});

// Lifts the wrong-password lock and starts its doubling over. It also switches
// the account back on, as it always has: this is the "let them back in" button,
// and scripts/unlock.js does the same from a shell.
router.post("/users/:username/unlock", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.queryAuth(
      `UPDATE users
          SET active = true, ${lockout.CLEARED}
        WHERE lower(username) = lower($1)
    RETURNING id, username`,
      [String(req.params.username || "")],
    );
    if (!rows[0]) return fail(res, 404, "USER_NOT_FOUND", "No account with that username");

    console.log(`[auth] account "${rows[0].username}" re-enabled by "${req.user.username}".`);
    res.json({ ok: true, username: rows[0].username });
  } catch (error) {
    console.error("Unlock failed:", error);
    fail(res, 500, "UNLOCK_FAILED", "Could not re-enable the account");
  }
});

// Adding somebody without opening sign-up to the whole internet, which is what
// BUSSOLA_SIGNUP=open would mean. Exactly as if they had signed up, they get
// no wallet: the administrator can add them to one straight away, and at their
// first sign-in they find it on the picker, or name one of their own.
router.post("/users", requireAuth, requireAdmin, async (req, res) => {
  const { username, password, locale, isAdmin } = req.body || {};
  if (!validUsername(username)) {
    return fail(
      res,
      400,
      "INVALID_USERNAME",
      "The username must be 3 to 64 characters: letters, digits, dot, dash or underscore",
    );
  }
  if (!passwordAcceptable(password)) {
    return fail(
      res,
      400,
      "PASSWORD_TOO_SHORT",
      `The password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
    );
  }

  try {
    const { user } = await createAccount({
      username,
      passwordHash: await hashPassword(password),
      locale: String(locale || "").slice(0, 2) || null,
      isAdmin: isAdmin === true,
    });

    console.log(`[auth] account "${user.username}" created by "${req.user.username}".`);
    res.status(201).json({
      id: user.id,
      username: user.username,
      locale: user.locale,
      is_admin: user.is_admin,
    });
  } catch (error) {
    if (error.code === "23505") {
      return fail(res, 409, "USERNAME_TAKEN", "That username is already taken");
    }
    console.error("Could not create the account:", error);
    fail(res, 500, "USER_CREATE_FAILED", "Could not create the account");
  }
});

// Switching an account off is an administrator's decision, and the only thing
// users.active means (the wrong-password lock is locked_until, and lifts by
// itself). It throws the person out of every session at once.
//
// `active` has to be said, as true or false. A missing body used to read as
// false -- so an empty POST, which a form on any page of the same site can
// send, switched the account off.
router.post("/users/:username/active", requireAuth, requireAdmin, async (req, res) => {
  const requested = (req.body || {}).active;
  if (typeof requested !== "boolean") {
    return fail(res, 400, "INVALID_REQUEST", "Say whether the account is active: true or false");
  }
  const active = requested;
  const username = String(req.params.username || "");

  // An administrator who switches themselves off on a single-admin instance
  // locks the instance, and only api/scripts/unlock.js gets back in.
  if (username.toLowerCase() === req.user.username.toLowerCase() && !active) {
    return fail(res, 409, "CANNOT_DISABLE_SELF", "You cannot disable your own account");
  }

  try {
    const { rows } = await db.queryAuth(
      `UPDATE users
          SET active = $2, failed_logins = 0, locked_at = NULL
        WHERE lower(username) = lower($1)
    RETURNING id, username, active`,
      [username, active],
    );
    if (!rows[0]) return fail(res, 404, "USER_NOT_FOUND", "No account with that username");

    if (!active) await sessions.deleteUserSessions(rows[0].id);
    console.log(
      `[auth] account "${rows[0].username}" ${active ? "enabled" : "disabled"} ` +
        `by "${req.user.username}".`,
    );
    res.json({ ok: true, username: rows[0].username, active: rows[0].active });
  } catch (error) {
    console.error("Could not change the account state:", error);
    fail(res, 500, "USER_STATE_FAILED", "Could not change the state of the account");
  }
});

// Deleting somebody else's account, for good, with the wallets it created
// (deleteAccountAndWallets above says what goes and why).
//
// The username has to be typed back, as a wallet's name is before deleting a
// wallet: the interface asks for it, and the rule lives here so that calling
// the endpoint directly does not skip it. Nobody deletes themselves this way,
// and an administrator cannot through DELETE /me either, so an instance always
// keeps the administrator it was installed with.
router.delete("/users/:username", requireAuth, requireAdmin, async (req, res) => {
  const username = String(req.params.username || "");
  if (String((req.body || {}).confirm || "").trim().toLowerCase() !== username.toLowerCase()) {
    return fail(res, 400, "USERNAME_MISMATCH", "Type the account's username exactly to confirm");
  }
  if (username.toLowerCase() === req.user.username.toLowerCase()) {
    return fail(res, 409, "CANNOT_DELETE_SELF", "You cannot delete your own account");
  }

  try {
    // One transaction: the wallets and the account go together or not at all.
    const outcome = await db.transactionAuth(async (client) => {
      const { rows } = await client.query(
        "SELECT id, username FROM users WHERE lower(username) = lower($1) FOR UPDATE",
        [username],
      );
      if (!rows[0]) return null;
      return { user: rows[0], wallets: await deleteAccountAndWallets(client, rows[0].id) };
    });
    if (!outcome) return fail(res, 404, "USER_NOT_FOUND", "No account with that username");

    logAccountDeleted(outcome.user, req.user.username, outcome.wallets);
    res.json({
      ok: true,
      username: outcome.user.username,
      walletsDeleted: outcome.wallets.length,
    });
  } catch (error) {
    console.error("Could not delete the account:", error);
    fail(res, 500, "USER_DELETE_FAILED", "Could not delete the account");
  }
});

// Every wallet on the instance, for the administration screen. The list says
// who created each one and how many members it has -- not what is inside it:
// administering the instance does not come with a key to the data.
router.get("/admin/wallets", requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await wallets.listAll());
  } catch (error) {
    console.error("Could not list the wallets:", error);
    fail(res, 500, "WALLET_LIST_FAILED", "Could not list the wallets");
  }
});

module.exports = router;
