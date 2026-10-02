#!/usr/bin/env node
// ===========================================================================
// Security regression test
// ===========================================================================
// The companion of isolation.js. That one proves wallets cannot see each
// other; this one proves the doors are built the way the audit asked:
//
//   - the wrong-password lock is temporary, doubles, lifts by itself, says so
//     only after a correct password, leaves open sessions alone, and an
//     administrator can lift it sooner
//   - signing in as nobody costs as much as signing in as somebody (timing)
//   - X-Forwarded-For written by the client does not buy a fresh throttle
//   - re-typing the current password is throttled per account
//   - a POST from another origin is refused
//   - an empty POST to the admin's "active" switch no longer disables anyone
//   - the add-member path respects the last-writer rule, and asking it about
//     usernames that do not exist is throttled per account
//   - database errors reach the client as a code and a sentence, not as
//     Postgres' own words
//   - an account can delete itself, with the wallets it created, but only
//     with its password and its username typed back -- and an administrator
//     cannot
//   - a personal API token is made only with the password again (and those
//     attempts are throttled like the other re-authentications), is never
//     listed back, stops working when revoked, and every token that opens
//     nothing -- revoked, unknown, malformed -- gets the same 401, throttled
//     per address
//   - Web Push: every endpoint needs a session, a subscription is accepted
//     only for https endpoints on a real push service's host (no IP literal,
//     no internal name, no look-alike), and the test notification is
//     throttled per account; a subscription belongs to the session that
//     saved it, so signing out removes it and a password change carries it
//     (and the selected wallet) to the new session; the service worker is served uncached, as
//     JavaScript, with no fetch handler, the manifest with its own type
//   - the headers nginx sends (CSP and friends), on every kind of location
//   - chart labels are escaped before ApexCharts puts them in the page
//
//   BASE_URL=http://localhost:3000 node api/test/security.js
//
// Point it at the nginx frontend, not at the API: the headers and the
// X-Forwarded-For checks are about what nginx does (against the bare API the
// header checks are skipped, and the X-Forwarded-For one only passes when the
// API runs with BUSSOLA_TRUSTED_PROXIES=0, since nothing is in front of it).
//
// Needs BUSSOLA_SIGNUP=open: it creates its own accounts. Optional:
//
//   ADMIN_USER / ADMIN_PASS   the instance's first account (BUSSOLA_AUTH_*),
//                             for the unlock and "active" checks
//   BUSSOLA_LOCKOUT_SECONDS   set on the API to a few seconds (e.g. 3) and the
//                             test also waits out locks to check the doubling
//                             and the expiry; with the default quarter of an
//                             hour those two checks are skipped
//
// Like isolation.js: a throwaway instance only, never one with real data.
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
const RUN = Date.now().toString(36);

const results = [];
const notes = [];
let failures = 0;

const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
};
const note = (text) => notes.push(text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// An HTTP client that remembers the session cookie, as in isolation.js, plus
// headers of the caller's choosing per request.
// ---------------------------------------------------------------------------
const createClient = () => {
  let cookie = null;

  return async (method, url, body, extraHeaders = {}, raw = false) => {
    const headers = { ...extraHeaders };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers["Cookie"] = cookie;

    const response = await fetch(`${BASE}${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });

    for (const c of response.headers.getSetCookie ? response.headers.getSetCookie() : []) {
      if (c.startsWith("bussola_sess=")) cookie = c.split(";")[0];
    }

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: response.status, text, json, headers: response.headers };
  };
};

const signup = async (client, username, password) => {
  const r = await client("POST", "/api/auth/signup", { username, password, locale: "en" });
  if (r.status !== 201) throw new Error(`sign-up of ${username} failed: ${r.status} ${r.text.slice(0, 200)}`);
  // Sign-up creates no wallet; the tests below want one of their own.
  const w = await client("POST", "/api/auth/wallets", { name: `${username}'s wallet` });
  if (w.status !== 201) throw new Error(`wallet for ${username} failed: ${w.status} ${w.text.slice(0, 200)}`);
  return { ...r.json, wallet: w.json };
};

const login = (client, username, password, headers) =>
  client("POST", "/api/auth/login", { username, password }, headers);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const randomIp = () =>
  `${10 + Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 255)}.` +
  `${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 250)}`;

// ---------------------------------------------------------------------------
const main = async () => {
  const status = await createClient()("GET", "/api/auth/status");
  if (status.status !== 200) throw new Error(`${BASE} does not answer /api/auth/status (${status.status})`);
  if (!status.json.signupOpen) throw new Error("sign-up is closed on this instance: set BUSSOLA_SIGNUP=open");

  // Whether we are talking to nginx (the page itself is served) or to the bare
  // API (which answers / with a JSON 404).
  const home = await createClient()("GET", "/");
  const frontDoor = home.status === 200 && /<html/i.test(home.text);

  // --- 1. headers ------------------------------------------------------------
  if (frontDoor) {
    const csp = home.headers.get("content-security-policy") || "";
    const scriptSrc = (csp.match(/script-src ([^;]*)/) || [])[1] || "";
    record("the page carries a Content-Security-Policy", csp.includes("default-src 'self'"), csp);
    record("script-src allows no inline script but by hash",
      /'sha256-/.test(scriptSrc) && !/unsafe-inline|unsafe-eval/.test(scriptSrc), scriptSrc);
    record("frame-ancestors 'none'", /frame-ancestors 'none'/.test(csp), csp);

    // The hash in the policy has to be the hash of the script actually served.
    const inline = [...home.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs))
      .map(([, , bodyText]) => `'sha256-${crypto.createHash("sha256").update(bodyText, "utf8").digest("base64")}'`);
    record("every inline script on the page is allowed by the CSP",
      inline.length > 0 && inline.every((h) => scriptSrc.includes(h)),
      `served ${inline.join(" ")} / policy ${scriptSrc}`);

    const expectCommon = (label, r) => {
      const h = (n) => r.headers.get(n) || "";
      record(`${label}: security headers survive the location's own add_header`,
        h("content-security-policy") === csp &&
          h("x-content-type-options") === "nosniff" &&
          h("x-frame-options") === "DENY" &&
          h("referrer-policy") !== "" &&
          h("permissions-policy") !== "",
        [...r.headers].filter(([k]) => /policy|x-|referrer/.test(k)).map((p) => p.join(": ")).join(" | "));
    };
    expectCommon("/", home);

    const config = await createClient()("GET", "/config.json");
    expectCommon("/config.json", config);
    record("/config.json keeps its own no-store", /no-store/.test(config.headers.get("cache-control") || ""),
      config.headers.get("cache-control"));

    const asset = (home.text.match(/src="(\/assets\/[^"]+\.js)"/) || [])[1];
    if (asset) {
      const a = await createClient()("GET", asset);
      expectCommon("/assets/", a);
      record("/assets/ keeps its own immutable", /immutable/.test(a.headers.get("cache-control") || ""),
        a.headers.get("cache-control"));
    }

    // The PWA's two files: a service worker that must never be cached by the
    // browser's HTTP cache (updates have to reach people), served as
    // JavaScript, and a manifest with its own type. The policy lets the page
    // load both from this origin and from nowhere else.
    record("the CSP names worker-src and manifest-src as 'self'",
      /worker-src 'self'(;|$)/.test(csp) && /manifest-src 'self'(;|$)/.test(csp), csp);
    const sw = await createClient()("GET", "/sw.js");
    expectCommon("/sw.js", sw);
    record("/sw.js is JavaScript and is never cached",
      sw.status === 200 && /javascript/.test(sw.headers.get("content-type") || "")
        && /no-cache/.test(sw.headers.get("cache-control") || ""),
      `${sw.status} ${sw.headers.get("content-type")} / ${sw.headers.get("cache-control")}`);
    record("the service worker has no fetch handler and no cache API (it never touches the session's data)",
      !/addEventListener\(\s*["']fetch["']/.test(sw.text) && !/\bcaches\b/.test(sw.text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")),
      sw.text.slice(0, 120));
    const manifest = await createClient()("GET", "/manifest.webmanifest");
    expectCommon("/manifest.webmanifest", manifest);
    record("/manifest.webmanifest has the manifest type and names the app",
      manifest.status === 200 && /application\/manifest\+json/.test(manifest.headers.get("content-type") || "")
        && manifest.json && manifest.json.display === "standalone" && manifest.json.start_url === "/",
      `${manifest.status} ${manifest.headers.get("content-type")}`);
    record("the page links the manifest", /rel="manifest"\s+href="\/manifest\.webmanifest"/.test(home.text));

    const api = await createClient()("GET", "/api/auth/status");
    expectCommon("/api/", api);
    record("nginx does not name its version", !/nginx\//.test(home.headers.get("server") || ""),
      home.headers.get("server"));
  } else {
    note("BASE_URL is the bare API, not nginx: the header checks were skipped.");
  }

  // --- 2. the throttle does not believe X-Forwarded-For ---------------------
  // Twenty wrong passwords for one username from one address, each claiming
  // to come from somewhere else. If the claim were believed, every request
  // would start a fresh count and the 21st would still be a 401.
  {
    const target = `sec-xff-${RUN}`;
    const spoofer = createClient();
    let throttled = null;
    for (let i = 1; i <= 22 && !throttled; i++) {
      const r = await login(spoofer, target, "wrong-password", { "X-Forwarded-For": randomIp() });
      if (r.status === 429) throttled = { at: i, r };
    }
    record("a made-up X-Forwarded-For does not reset the sign-in throttle",
      Boolean(throttled) && throttled.at <= 21 && /TOO_MANY_ATTEMPTS/.test(throttled.r.text),
      throttled ? `429 at attempt ${throttled.at}` :
        "22 attempts and no 429" + (frontDoor ? "" : " (against the bare API this needs BUSSOLA_TRUSTED_PROXIES=0)"));
    if (throttled) {
      record("the 429 says how long to wait", Number(throttled.r.headers.get("retry-after")) > 0,
        `Retry-After: ${throttled.r.headers.get("retry-after")}`);
    }
  }

  // --- 3. timing: an unknown username costs a whole scrypt -------------------
  {
    const known = `sec-time-${RUN}`;
    await signup(createClient(), known, "timing-password");
    const c = createClient();
    await login(c, `sec-nobody-warmup-${RUN}`, "x"); // the dummy hash is made on first use

    const knownMs = [];
    const unknownMs = [];
    for (let i = 0; i < 4; i++) {
      let t = performance.now();
      await login(c, known, `wrong-${i}`);
      knownMs.push(performance.now() - t);
      t = performance.now();
      await login(c, `sec-nobody-${i}-${RUN}`, `wrong-${i}`);
      unknownMs.push(performance.now() - t);
    }
    const k = median(knownMs);
    const u = median(unknownMs);
    // Coarse on purpose: the point is "a scrypt ran" versus "answered in a
    // millisecond", not a statistical timing attack.
    record("an unknown username takes as long as a known one (scrypt runs either way)",
      k > 15 && u > k * 0.5 && u < k * 2,
      `known ${k.toFixed(0)} ms, unknown ${u.toFixed(0)} ms`);
  }

  // --- 4. the wrong-password lock --------------------------------------------
  {
    const victim = `sec-lock-${RUN}`;
    const password = "lock-password";
    const owner = createClient();
    await signup(owner, victim, password);

    const guesser = createClient();
    let last;
    for (let i = 0; i < 5; i++) last = await login(guesser, victim, "wrong-password");
    record("five wrong passwords: still only 'wrong username or password'",
      last.status === 401 && /INVALID_CREDENTIALS/.test(last.text) && !/LOCK/i.test(last.text),
      `status ${last.status}: ${last.text.slice(0, 140)}`);

    const whileLocked = await login(guesser, victim, "wrong-again");
    record("a wrong password during the lock says nothing about the lock",
      whileLocked.status === 401 && !/LOCK/i.test(whileLocked.text),
      `status ${whileLocked.status}: ${whileLocked.text.slice(0, 140)}`);

    const right = await login(createClient(), victim, password);
    const first = right.json && right.json.retryAfter;
    record("the right password during the lock: 403 ACCOUNT_LOCKED, with the wait",
      right.status === 403 && /ACCOUNT_LOCKED/.test(right.text) && first > 0 &&
        Number(right.headers.get("retry-after")) > 0,
      `status ${right.status}: ${right.text.slice(0, 160)}`);

    // Not a way to throw the owner out of devices already signed in.
    const stillIn = await owner("GET", "/api/auth/me");
    record("the lock leaves sessions already open alone", stillIn.status === 200, `status ${stillIn.status}`);

    // Doubling and expiry, when the instance's lock is short enough to wait.
    if (first && first <= 15) {
      await sleep((first + 1) * 1000);
      for (let i = 0; i < 5; i++) await login(guesser, victim, "wrong-password");
      const second = await login(createClient(), victim, password);
      const r2 = second.json && second.json.retryAfter;
      record("the lock lifted by itself (failures counted again) and the next one is twice as long",
        second.status === 403 && r2 >= first * 1.5,
        `first ${first}s, second ${r2}s (status ${second.status})`);

      if (!process.env.ADMIN_USER) {
        await sleep((r2 + 1) * 1000);
        const after = await login(createClient(), victim, password);
        record("once the lock runs out the right password signs in", after.status === 200,
          `status ${after.status}: ${after.text.slice(0, 140)}`);
      }
    } else {
      note(`The first lock lasts ${first}s: doubling and expiry were not waited for ` +
        "(run the API with BUSSOLA_LOCKOUT_SECONDS=3 to check them).");
    }

    // The administrator's unlock, and the switch that no longer flips on an
    // empty body.
    if (process.env.ADMIN_USER && process.env.ADMIN_PASS) {
      const admin = createClient();
      const signedIn = await login(admin, process.env.ADMIN_USER, process.env.ADMIN_PASS);
      if (signedIn.status !== 200) {
        record("the administrator can sign in (ADMIN_USER/ADMIN_PASS)", false,
          `status ${signedIn.status}: ${signedIn.text.slice(0, 140)}`);
      } else {
        const listed = await admin("GET", "/api/auth/users");
        const row = (listed.json || []).find((u) => u.username === victim);
        record("the admin list shows the account as locked, and still active",
          Boolean(row && row.locked === true && row.active === true), JSON.stringify(row || null));

        const unlocked = await admin("POST", `/api/auth/users/${victim}/unlock`);
        const back = await login(createClient(), victim, password);
        record("the administrator's unlock lets the right password in at once",
          unlocked.status === 200 && back.status === 200,
          `unlock ${unlocked.status}, sign-in ${back.status}: ${back.text.slice(0, 140)}`);

        const empty = await admin("POST", `/api/auth/users/${victim}/active`);
        const emptyJson = await admin("POST", `/api/auth/users/${victim}/active`, {});
        const stillActive = await login(createClient(), victim, password);
        record("an empty POST to /users/:u/active is refused and disables nobody",
          empty.status === 400 && emptyJson.status === 400 && /INVALID_REQUEST/.test(emptyJson.text) &&
            stillActive.status === 200,
          `empty ${empty.status}, {} ${emptyJson.status}, sign-in after ${stillActive.status}`);
      }
    } else {
      note("ADMIN_USER/ADMIN_PASS not given: the unlock and 'active' checks were skipped.");
    }
  }

  // --- 5. the current password, asked again, is throttled per account -------
  {
    const who = `sec-reauth-${RUN}`;
    const c = createClient();
    await signup(c, who, "reauth-password");
    let last;
    for (let i = 0; i < 5; i++) {
      last = await c("POST", "/api/auth/password", { current: `nope-${i}`, next: "another-password" });
    }
    const sixth = await c("POST", "/api/auth/password", { current: "reauth-password", next: "another-password" });
    record("five wrong current passwords, then even the right one waits",
      last.status === 401 && sixth.status === 429 && /TOO_MANY_ATTEMPTS/.test(sixth.text),
      `fifth ${last.status}, sixth ${sixth.status}: ${sixth.text.slice(0, 120)}`);
  }

  // --- 6. requests from another origin ---------------------------------------
  {
    const who = `sec-origin-${RUN}`;
    const c = createClient();
    await signup(c, who, "origin-password");

    const evil = await c("POST", "/api/auth/locale", { locale: "it" }, { Origin: "http://evil.example" });
    record("a POST with a foreign Origin is refused",
      evil.status === 403 && /CROSS_ORIGIN_REFUSED/.test(evil.text), `status ${evil.status}: ${evil.text.slice(0, 120)}`);

    // Another port on the same host is another origin, if the same site.
    const u = new URL(BASE);
    const otherPort = `${u.protocol}//${u.hostname}:${Number(u.port || 80) + 1}`;
    const sibling = await c("POST", "/api/auth/logout", undefined, { Origin: otherPort });
    const stillIn = await c("GET", "/api/auth/me");
    record("a POST from another port of the same host is refused, and signs nobody out",
      sibling.status === 403 && stillIn.status === 200, `logout ${sibling.status}, me ${stillIn.status}`);

    const sameSite = await c("POST", "/api/auth/locale", { locale: "it" }, { "Sec-Fetch-Site": "same-site" });
    record("Sec-Fetch-Site: same-site without an Origin is refused", sameSite.status === 403,
      `status ${sameSite.status}`);

    const nullOrigin = await createClient()("POST", "/api/auth/login",
      { username: who, password: "origin-password" }, { Origin: "null" });
    record("a sign-in posted from an opaque origin is refused", nullOrigin.status === 403,
      `status ${nullOrigin.status}`);

    const own = await c("POST", "/api/auth/locale", { locale: "it" }, { Origin: u.origin });
    record("a POST with this instance's own Origin goes through", own.status === 200,
      `status ${own.status}: ${own.text.slice(0, 120)}`);
  }

  // --- 7. the last writer, through the add-member upsert ---------------------
  {
    const who = `sec-writer-${RUN}`;
    const c = createClient();
    const me = await signup(c, who, "writer-password");
    const demote = await c("POST", `/api/auth/wallets/${me.wallet.id}/members`, { username: who, role: "r" });
    const members = await c("GET", `/api/auth/wallets/${me.wallet.id}/members`);
    const mine = (members.json || []).find((m) => m.username === who);
    record("add-member cannot turn the only writer into a reader",
      demote.status === 409 && /LAST_WRITER/.test(demote.text) && mine && mine.role === "rw",
      `status ${demote.status}: ${demote.text.slice(0, 120)}; role now ${mine && mine.role}`);

    // --- 7b. add-member cannot be used to walk a list of usernames ----------
    // Whether a name exists cannot be hidden from somebody who then reads the
    // members list, so the answer stays a 404; the asking is what is limited.
    const other = `sec-member-${RUN}`;
    await signup(createClient(), other, "member-password");
    const misses = [];
    for (let i = 0; i < 10; i++) {
      misses.push((await c("POST", `/api/auth/wallets/${me.wallet.id}/members`,
        { username: `nobody-${RUN}-${i}`, role: "r" })).status);
    }
    const eleventh = await c("POST", `/api/auth/wallets/${me.wallet.id}/members`, { username: other, role: "r" });
    record("ten unknown usernames to add-member, then even a real one waits",
      misses.every((s) => s === 404) && eleventh.status === 429 && /TOO_MANY_ATTEMPTS/.test(eleventh.text) &&
        Number(eleventh.headers.get("retry-after")) > 0,
      `misses ${misses.join(",")}; eleventh ${eleventh.status}: ${eleventh.text.slice(0, 120)}`);

    const elsewhere = createClient();
    const them = await signup(elsewhere, `sec-member2-${RUN}`, "member-password");
    const theirs = await elsewhere("POST", `/api/auth/wallets/${them.wallet.id}/members`, { username: other, role: "r" });
    record("the add-member limit is per account: another manager is not held up",
      theirs.status === 201, `status ${theirs.status}: ${theirs.text.slice(0, 120)}`);

    // --- 8. errors say a code and a sentence, not Postgres' words -----------
    const badId = await c("DELETE", "/api/accounts/not-a-number");
    record("a malformed id is a 400 with a code, not a 500 with a database message",
      badId.status === 400 && /INVALID_REQUEST/.test(badId.text) &&
        !/syntax|integer|relation|policy|violates/i.test(badId.text),
      `status ${badId.status}: ${badId.text.slice(0, 160)}`);

    const badJson = await c("POST", "/api/auth/locale", "{not json", {}, true);
    record("a body that is not JSON is a 400 with a code, not an HTML stack trace",
      badJson.status === 400 && /INVALID_REQUEST/.test(badJson.text) && !/<html|at .*\.js/i.test(badJson.text),
      `status ${badJson.status}: ${badJson.text.slice(0, 160)}`);
  }

  // --- 8b. the administrator deletes an account, and the wallets it created --
  if (process.env.ADMIN_USER && process.env.ADMIN_PASS) {
    const admin = createClient();
    const adminIn = await login(admin, process.env.ADMIN_USER, process.env.ADMIN_PASS);
    const ownerName = `sec-gone-${RUN}`;
    const keptName = `sec-kept-${RUN}`;
    const owner = createClient();
    const kept = createClient();
    const o = await signup(owner, ownerName, "owner-password");
    const k = await signup(kept, keptName, "kept-password");
    // Each shares their wallet with the other, and the survivor is looking at
    // the one that is about to go.
    await owner("POST", `/api/auth/wallets/${o.wallet.id}/members`, { username: keptName, role: "rw" });
    await kept("POST", `/api/auth/wallets/${k.wallet.id}/members`, { username: ownerName, role: "rw" });
    const looking = await kept("POST", "/api/auth/wallet", { walletId: o.wallet.id });

    const byMember = await kept("DELETE", `/api/auth/users/${ownerName}`, { confirm: ownerName });
    const mistyped = await admin("DELETE", `/api/auth/users/${ownerName}`, { confirm: "somebody-else" });
    const self = await admin("DELETE", `/api/auth/users/${process.env.ADMIN_USER}`, {
      confirm: process.env.ADMIN_USER,
    });
    record("deleting an account: admin only, the username typed back, never oneself",
      adminIn.status === 200 && looking.status === 200 && byMember.status === 403 &&
        mistyped.status === 400 && /USERNAME_MISMATCH/.test(mistyped.text) &&
        self.status === 409 && /CANNOT_DELETE_SELF/.test(self.text),
      `member ${byMember.status}, mistyped ${mistyped.status}, self ${self.status}`);

    const deleted = await admin("DELETE", `/api/auth/users/${ownerName}`, { confirm: ownerName });
    record("the administrator deletes an account, and the one wallet it created goes with it",
      deleted.status === 200 && deleted.json && deleted.json.walletsDeleted === 1,
      `status ${deleted.status}: ${deleted.text.slice(0, 140)}`);

    const signIn = await login(createClient(), ownerName, "owner-password");
    const oldSession = await owner("GET", "/api/auth/me");
    record("the deleted account cannot sign in, and its open session is gone",
      signIn.status === 401 && oldSession.status === 401,
      `sign-in ${signIn.status}, old session ${oldSession.status}`);

    const left = await kept("GET", "/api/auth/wallets");
    const ids = (left.json || []).map((w) => w.id);
    const lost = await kept("GET", "/api/accounts");
    const members = await kept("GET", `/api/auth/wallets/${k.wallet.id}/members`);
    record("its wallet is gone for its members too, who land on the picker; their own stays",
      !ids.includes(o.wallet.id) && ids.includes(k.wallet.id) &&
        lost.status === 409 && /NO_WALLET_SELECTED/.test(lost.text),
      `wallets ${JSON.stringify(ids)}, data ${lost.status}`);
    record("and it is no longer a member of the wallets others shared with it",
      members.status === 200 && !(members.json || []).some((m) => m.username === ownerName),
      JSON.stringify((members.json || []).map((m) => m.username)));

    const twice = await admin("DELETE", `/api/auth/users/${ownerName}`, { confirm: ownerName });
    record("deleting it again finds nobody", twice.status === 404 && /USER_NOT_FOUND/.test(twice.text),
      `status ${twice.status}`);

    // The administrator can also delete a single wallet, even an account's
    // first -- the owner cannot delete that one themselves.
    const byOwner = await kept("DELETE", `/api/auth/wallets/${k.wallet.id}`, { confirm: k.wallet.name });
    const byAdmin = await admin("DELETE", `/api/auth/wallets/${k.wallet.id}`, { confirm: k.wallet.name });
    const none = await kept("GET", "/api/auth/wallets");
    record("the administrator deletes any wallet, even the first one an account created",
      byOwner.status === 409 && /FIRST_WALLET/.test(byOwner.text) &&
        byAdmin.status === 200 && Array.isArray(none.json) && none.json.length === 0,
      `owner ${byOwner.status}, admin ${byAdmin.status}, left ${JSON.stringify(none.json)}`);

    // Nor through the door every other account has: the administrator the
    // instance was installed with lives as long as the instance.
    const adminSelf = await admin("DELETE", "/api/auth/me", {
      password: process.env.ADMIN_PASS,
      confirm: process.env.ADMIN_USER,
    });
    const adminStill = await admin("GET", "/api/auth/me");
    record("an administrator cannot delete its own account from the profile either",
      adminSelf.status === 409 && /CANNOT_DELETE_SELF/.test(adminSelf.text) && adminStill.status === 200,
      `delete ${adminSelf.status}: ${adminSelf.text.slice(0, 120)}; me after ${adminStill.status}`);
  } else {
    note("ADMIN_USER/ADMIN_PASS not set: deleting accounts and wallets was not checked.");
  }

  // --- 8d. an account deletes itself, with the wallets it created -----------
  {
    const goneName = `sec-self-${RUN}`;
    const friendName = `sec-friend-${RUN}`;
    const self = createClient();
    const friend = createClient();
    const s = await signup(self, goneName, "self-password");
    const f = await signup(friend, friendName, "friend-password");
    // A second wallet, shared with the friend, who is looking at it; the
    // friend shares theirs back.
    const second = await self("POST", "/api/auth/wallets", { name: `${goneName} second` });
    await self("POST", `/api/auth/wallets/${second.json.id}/members`, { username: friendName, role: "rw" });
    await friend("POST", `/api/auth/wallets/${f.wallet.id}/members`, { username: goneName, role: "rw" });
    const looking = await friend("POST", "/api/auth/wallet", { walletId: second.json.id });

    const mistyped = await self("DELETE", "/api/auth/me", { password: "self-password", confirm: "somebody-else" });
    const wrongPassword = await self("DELETE", "/api/auth/me", { password: "not-it", confirm: goneName });
    const stillThere = await self("GET", "/api/auth/me");
    record("deleting one's own account needs the username typed back and the password",
      looking.status === 200 &&
        mistyped.status === 400 && /USERNAME_MISMATCH/.test(mistyped.text) &&
        wrongPassword.status === 401 && /WRONG_CURRENT_PASSWORD/.test(wrongPassword.text) &&
        stillThere.status === 200,
      `mistyped ${mistyped.status}, wrong password ${wrongPassword.status}, me after ${stillThere.status}`);

    const deleted = await self("DELETE", "/api/auth/me", { password: "self-password", confirm: goneName });
    record("an account deletes itself, with both wallets it created, the first one included",
      deleted.status === 200 && deleted.json && deleted.json.walletsDeleted === 2,
      `status ${deleted.status}: ${deleted.text.slice(0, 140)}`);

    const signIn = await login(createClient(), goneName, "self-password");
    const oldSession = await self("GET", "/api/auth/me");
    record("the deleted account cannot sign in, and the session it deleted from is gone",
      signIn.status === 401 && oldSession.status === 401,
      `sign-in ${signIn.status}, old session ${oldSession.status}`);

    const left = await friend("GET", "/api/auth/wallets");
    const ids = (left.json || []).map((w) => w.id);
    const lost = await friend("GET", "/api/accounts");
    const members = await friend("GET", `/api/auth/wallets/${f.wallet.id}/members`);
    record("its shared wallet is gone for the friend too, who lands on the picker; the friend's own stays",
      !ids.includes(second.json.id) && !ids.includes(s.wallet.id) && ids.includes(f.wallet.id) &&
        lost.status === 409 && /NO_WALLET_SELECTED/.test(lost.text) &&
        members.status === 200 && !(members.json || []).some((m) => m.username === goneName),
      `wallets ${JSON.stringify(ids)}, data ${lost.status}, members ${JSON.stringify((members.json || []).map((m) => m.username))}`);
  }

  // --- 8e. personal API tokens ------------------------------------------------
  // The credential an iPhone Shortcut or an Android app posts bank
  // notifications with. Minting one needs the password again, so a stolen
  // cookie cannot turn itself into something permanent; a token is shown once
  // and never listed back; and a token that opens nothing says nothing about
  // why. This section runs last among the ones that sign in: its throttle
  // check leaves this address unable to use any token for a quarter of an hour
  // (DELETE FROM throttle_hits on the test instance starts it over).
  {
    const bearer = (token) => (token === null ? {} : { Authorization: `Bearer ${token}` });
    const post = (client, token) =>
      client("POST", "/api/inbox", { source: "security", text: "Pagamento di 1,00 € presso Security shop", draft: { amount: 1, description: "Security shop" } }, bearer(token));

    // The password again, throttled per account like the other re-auths.
    const thrower = createClient();
    await signup(thrower, `sec-tokpw-${RUN}`, "token-password-1");
    const wrong = await thrower("POST", "/api/auth/tokens", { label: "phone", password: "not-it" });
    record("making a token with a wrong password is refused",
      wrong.status === 401 && /WRONG_CURRENT_PASSWORD/.test(wrong.text) && !/bpt_/.test(wrong.text),
      `status ${wrong.status}: ${wrong.text.slice(0, 120)}`);
    const noPassword = await thrower("POST", "/api/auth/tokens", { label: "phone" });
    record("and so is one with no password at all",
      noPassword.status === 401 && !/bpt_/.test(noPassword.text), `status ${noPassword.status}`);
    for (let i = 0; i < 4; i++) await thrower("POST", "/api/auth/tokens", { label: "phone", password: `nope-${i}` });
    const throttledMint = await thrower("POST", "/api/auth/tokens", { label: "phone", password: "token-password-1" });
    record("after five wrong passwords even the right one waits (throttled per account)",
      throttledMint.status === 429 && /TOO_MANY_ATTEMPTS/.test(throttledMint.text) && !/bpt_/.test(throttledMint.text),
      `status ${throttledMint.status}: ${throttledMint.text.slice(0, 120)}`);

    // A token made properly: shown once, never listed back.
    const owner = createClient();
    await signup(owner, `sec-token-${RUN}`, "token-password-2");
    const minted = await owner("POST", "/api/auth/tokens", { label: "phone", password: "token-password-2" });
    const secret = minted.json && minted.json.token;
    record("with the password a token is made, and shown",
      minted.status === 201 && typeof secret === "string" && /^bpt_[A-Za-z0-9_-]{43}$/.test(secret),
      `status ${minted.status}: ${minted.text.slice(0, 60)}`);
    const listed = await owner("GET", "/api/auth/tokens");
    record("GET /api/auth/tokens never returns a token or its hash",
      listed.status === 200 && Array.isArray(listed.json) && listed.json.length === 1
        && !listed.text.includes(String(secret)) && !/bpt_|token_hash|"token"/.test(listed.text),
      listed.text.slice(0, 160));

    const works = await post(createClient(), secret);
    record("the token posts to the inbox", works.status === 201, `status ${works.status}: ${works.text.slice(0, 120)}`);

    // The test instance has no reading model: a notification that is only
    // text is refused, and nothing is kept.
    const textOnly = await createClient()(
      "POST", "/api/inbox", { source: "security", text: "Offerta: 3 mesi gratis" }, bearer(secret),
    );
    record("with no reading model, a notification that is only text is refused (409 AI_DISABLED)",
      textOnly.status === 409 && /AI_DISABLED/.test(textOnly.text), `status ${textOnly.status}: ${textOnly.text.slice(0, 120)}`);

    // The notification as plain text, with the characters that break a JSON
    // body pasted by hand: it reaches the reader's gate (no model here: 409),
    // not the JSON parser (400).
    const plain = await fetch(`${BASE}/api/inbox?source=${encodeURIComponent("Poste Italiane")}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8", ...bearer(secret) },
      body: 'Pagamento "Carta"\ndi 5,00 € presso BAR "CENTRALE"',
    });
    const plainBody = await plain.text();
    record("a notification can be sent as plain text, quotes and line breaks included (no JSON to break)",
      plain.status === 409 && /AI_DISABLED/.test(plainBody), `status ${plain.status}: ${plainBody.slice(0, 120)}`);

    const revoked = await owner("DELETE", `/api/auth/tokens/${minted.json && minted.json.id}`);
    const afterRevoke = await post(createClient(), secret);
    record("a revoked token is refused (401 TOKEN_INVALID)",
      revoked.status === 200 && afterRevoke.status === 401 && /TOKEN_INVALID/.test(afterRevoke.text),
      `revoke ${revoked.status}; then ${afterRevoke.status}: ${afterRevoke.text.slice(0, 120)}`);

    // Revoked, unknown, malformed, missing: one answer for all of them.
    const answers = {
      revoked: afterRevoke,
      unknown: await post(createClient(), `bpt_${crypto.randomBytes(32).toString("base64url")}`),
      malformed: await post(createClient(), "bpt_short"),
      "not a bpt token": await post(createClient(), crypto.randomBytes(32).toString("base64url")),
      "no header": await post(createClient(), null),
    };
    const reference = JSON.stringify({ status: afterRevoke.status, body: afterRevoke.json });
    const differing = Object.entries(answers).filter(
      ([, r]) => JSON.stringify({ status: r.status, body: r.json }) !== reference,
    );
    record("revoked, unknown, malformed and missing tokens all get the same 401 and the same body",
      afterRevoke.status === 401 && differing.length === 0,
      differing.map(([k, r]) => `${k}: ${r.status} ${r.text.slice(0, 80)}`).join(" | ") || reference);

    // Failed attempts are counted per address, whatever X-Forwarded-For says.
    let throttled = null;
    for (let i = 1; i <= 40 && !throttled; i++) {
      const r = await createClient()(
        "POST", "/api/inbox", { source: "security", text: "x" },
        { Authorization: `Bearer bpt_${crypto.randomBytes(32).toString("base64url")}`, "X-Forwarded-For": randomIp() },
      );
      if (r.status === 429) throttled = { at: i, r };
    }
    record("failed token attempts are throttled per address",
      Boolean(throttled) && /TOO_MANY_ATTEMPTS/.test(throttled.r.text),
      throttled ? `429 after ${throttled.at} more attempts` :
        "40 bad tokens and no 429" + (frontDoor ? "" : " (against the bare API this needs BUSSOLA_TRUSTED_PROXIES=0)"));

    const minted2 = await owner("POST", "/api/auth/tokens", { label: "phone 2", password: "token-password-2" });
    const blockedGood = await post(createClient(), minted2.json && minted2.json.token);
    record("and while the address is throttled even a good token waits",
      minted2.status === 201 && blockedGood.status === 429, `mint ${minted2.status}, post ${blockedGood.status}`);
  }

  // --- 8f. Web Push ------------------------------------------------------------
  // The server will POST to a URL the client hands it, so the subscribe
  // endpoint is an SSRF gate: only https endpoints on a real push service's
  // host. And the test button is throttled per account. A user with no device
  // subscribed is used for the throttle, so nothing is sent anywhere.
  {
    const pushOn = status.json.push === true;
    const sub = (endpoint) => ({ subscription: { endpoint, keys: { p256dh: `BP${"x".repeat(85)}`, auth: "a".repeat(22) } } });
    const nobody = createClient();
    const answers = [
      await nobody("POST", "/api/auth/push/subscribe", sub("https://fcm.googleapis.com/fcm/send/abcdefghijklmnop")),
      await nobody("DELETE", "/api/auth/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/abcdefghijklmnop" }),
      await nobody("POST", "/api/auth/push/test", {}),
    ];
    record("every push endpoint needs a session", answers.every((r) => r.status === 401), answers.map((r) => r.status).join(","));

    const pusher = createClient();
    await signup(pusher, `sec-push-${RUN}`, "push-password-1");
    if (pushOn) {
      record("status carries the public key and no private one",
        typeof status.json.pushPublicKey === "string" && /^[A-Za-z0-9_-]{80,100}$/.test(status.json.pushPublicKey)
          && !/private/i.test(JSON.stringify(status.json)), JSON.stringify(status.json).slice(0, 200));
      const targets = {
        "an IPv4 literal": "https://127.0.0.1/push/abcdefghijklmnopqrstu",
        "the cloud metadata address": "https://169.254.169.254/latest/abcdefghijklmnop",
        "an IPv6 literal": "https://[::1]/push/abcdefghijklmnopqrstuv",
        "localhost": "https://localhost:3001/api/health/abcdefghijk",
        "the api container": "https://api/api/health/abcdefghijklmnopq",
        "plain http": "http://fcm.googleapis.com/fcm/send/abcdefghijklmnop",
        "another host": "https://example.com/push/abcdefghijklmnopqrstu",
        "a look-alike host": "https://fcm.googleapis.com.evil.example/fcm/send/abcdefg",
        "user info that hides the host": "https://fcm.googleapis.com@evil.example/fcm/send/abcdefg",
      };
      const refused = [];
      for (const [what, endpoint] of Object.entries(targets)) {
        const r = await pusher("POST", "/api/auth/push/subscribe", sub(endpoint));
        if (!(r.status === 400 && /PUSH_ENDPOINT_NOT_ALLOWED/.test(r.text))) refused.push(`${what}: ${r.status} ${r.text.slice(0, 80)}`);
      }
      record("subscribe refuses every endpoint that is not a push service over https", refused.length === 0, refused.join(" | "));

      const good = await pusher("POST", "/api/auth/push/subscribe", sub(`https://fcm.googleapis.com/fcm/send/sec-${RUN}-abcdef`));
      const goodAgain = await pusher("POST", "/api/auth/push/subscribe", sub(`https://fcm.googleapis.com/fcm/send/sec-${RUN}-abcdef`));
      record("a push service's endpoint is accepted, and subscribing again is harmless",
        good.status === 201 && goodAgain.status === 201, `${good.status} ${goodAgain.status}`);
      const gone = await pusher("DELETE", "/api/auth/push/subscribe", { endpoint: `https://fcm.googleapis.com/fcm/send/sec-${RUN}-abcdef` });
      record("and removed again", gone.status === 200, `status ${gone.status}`);

      // A fresh account with no device: the test call answers 409 and counts;
      // the sixth within the window is throttled.
      const quiet = createClient();
      await signup(quiet, `sec-pushtest-${RUN}`, "push-password-2");
      const codes = [];
      for (let i = 0; i < 6; i++) codes.push((await quiet("POST", "/api/auth/push/test", {})).status);
      record("the test notification is throttled per account (409 five times, then 429)",
        codes.slice(0, 5).every((c) => c === 409) && codes[5] === 429, codes.join(","));
    } else {
      const off = await pusher("POST", "/api/auth/push/subscribe", sub("https://fcm.googleapis.com/fcm/send/abcdefghijklmnop"));
      record("with push off, subscribing is refused (404 PUSH_DISABLED)",
        off.status === 404 && /PUSH_DISABLED/.test(off.text) && status.json.pushPublicKey === null, `status ${off.status}`);
      note("Notifications are off on this instance (no BUSSOLA_PUBLIC_URL): the subscribe and throttle checks were skipped.");
    }
  }

  // --- 8g. a password change keeps the caller's wallet and device ------------
  // Every session goes down with a password change, and the caller gets a new
  // one. The new one must still be looking at the wallet the old one was (not
  // the picker, not the account's other wallet), and this device's push
  // subscription, bound to the session (migration 006), moves with it.
  // Signing out then removes the subscription server-side: whoever signs in
  // next in the same browser does not inherit it.
  {
    const pushOn = status.json.push === true;
    const who = `sec-pwkeep-${RUN}`;
    const c = createClient();
    const first = await signup(c, who, "keep-password-1");
    await c("POST", "/api/auth/wallets", { name: `${who}'s second wallet` });
    const chosen = await c("POST", "/api/auth/wallet", { walletId: first.wallet.id });
    const endpoint = `https://fcm.googleapis.com/fcm/send/sec-keep-${RUN}-abcdef`;
    const subscription = { subscription: { endpoint, keys: { p256dh: `BP${"x".repeat(85)}`, auth: "a".repeat(22) } } };
    if (pushOn) await c("POST", "/api/auth/push/subscribe", subscription);

    const changed = await c("POST", "/api/auth/password", { current: "keep-password-1", next: "keep-password-2" });
    const me = await c("GET", "/api/auth/me");
    const data = await c("GET", "/api/accounts");
    record("after a password change the same wallet is still selected and data answers",
      chosen.status === 200 && changed.status === 200 && me.json && me.json.wallet &&
        me.json.wallet.id === first.wallet.id && data.status === 200,
      `select ${chosen.status}, change ${changed.status}, wallet ${JSON.stringify(me.json && me.json.wallet)}, accounts ${data.status}`);

    if (pushOn) {
      const kept = await c("POST", "/api/auth/push/status", { endpoint });
      record("and this device's push subscription moved to the new session",
        kept.status === 200 && kept.json.subscribed === true, `status ${kept.status}: ${kept.text.slice(0, 120)}`);

      await c("POST", "/api/auth/logout", {});
      await login(c, who, "keep-password-2");
      const afterLogout = await c("POST", "/api/auth/push/status", { endpoint });
      const testSend = await c("POST", "/api/auth/push/test", {});
      record("signing out removes the device's push subscription on the server",
        afterLogout.status === 200 && afterLogout.json.subscribed === false &&
          testSend.status === 409 && /NO_PUSH_SUBSCRIPTION/.test(testSend.text),
        `status ${afterLogout.status} ${afterLogout.text.slice(0, 80)}, test ${testSend.status}`);

      const stranger = createClient();
      await signup(stranger, `sec-pwkeep-other-${RUN}`, "keep-password-3");
      const notTheirs = await stranger("POST", "/api/auth/push/status", { endpoint });
      const again = await c("POST", "/api/auth/push/subscribe", subscription);
      const onAgain = await c("POST", "/api/auth/push/status", { endpoint });
      record("another account does not see it, and subscribing again binds it to the new session",
        notTheirs.status === 200 && notTheirs.json.subscribed === false &&
          again.status === 201 && onAgain.json && onAgain.json.subscribed === true,
        `other ${notTheirs.text.slice(0, 60)}, again ${again.status}, now ${onAgain.text.slice(0, 60)}`);
      await c("DELETE", "/api/auth/push/subscribe", { endpoint });
    }
  }

  // --- 8c. the public health check -------------------------------------------
  // Reachable without a session (a dashboard or an uptime monitor calls it),
  // so it must say how the service is and nothing more.
  {
    const health = await createClient()("GET", "/api/health");
    record("GET /api/health answers without a session, with nothing but a status",
      health.status === 200 && health.json && health.json.status === "ok" &&
        Object.keys(health.json).length === 1,
      `status ${health.status}: ${health.text.slice(0, 120)}`);
  }

  // --- 9. chart labels (unit level) ------------------------------------------
  // The frontend has no test framework, but the helper every chart goes
  // through is plain JavaScript with no imports, so it can be loaded here.
  // What this cannot check is ApexCharts itself calling the formatters; that
  // is apexcharts 4.7's Legend.js and tooltip/Labels.js, read at the time.
  {
    const file = path.resolve(__dirname, "../../frontend/src/utils/chartText.js");
    if (fs.existsSync(file)) {
      const { escapeHtml, safeChartOptions } = await import(pathToFileURL(file).href);
      const payload = `<img src=x onerror="alert(1)">&'`;
      record("escapeHtml leaves no markup", !/[<>"']/.test(escapeHtml(payload)) && escapeHtml("a&b") === "a&amp;b",
        escapeHtml(payload));

      const opts = safeChartOptions({
        legend: { position: "bottom" },
        tooltip: { x: { format: "MMM yyyy" }, y: { formatter: (v) => `${v} €` } },
      });
      record("the legend is escaped", opts.legend.formatter(payload) === escapeHtml(payload) &&
        opts.legend.position === "bottom", opts.legend.formatter(payload));
      record("the tooltip's series name is escaped, keeping Apex's 'Name: '",
        opts.tooltip.y.title.formatter(payload) === `${escapeHtml(payload)}: `, opts.tooltip.y.title.formatter(payload));
      record("the tooltip's value goes through the caller's formatter, escaped",
        opts.tooltip.y.formatter("<b>") === "&lt;b&gt; €", opts.tooltip.y.formatter("<b>"));
      record("an x format without a formatter is left alone",
        opts.tooltip.x.format === "MMM yyyy" && opts.tooltip.x.formatter === undefined, JSON.stringify(opts.tooltip.x));
    } else {
      note("frontend/src/utils/chartText.js not found next to the API: chart escaping not checked.");
    }
  }

  // --- outcome ----------------------------------------------------------------
  console.log("");
  for (const e of results) {
    console.log(`${e.ok ? "  ok  " : "  FAIL"}  ${e.name}${e.ok ? "" : "\n        " + e.detail}`);
  }
  for (const n of notes) console.log(`\n  note  ${n}`);
  console.log(`\n${results.length - failures}/${results.length} checks passed.`);
  if (failures > 0) {
    console.error(`\n${failures} checks failed.`);
    process.exit(1);
  }
  console.log("Security checks passed.");
};

main().catch((error) => {
  console.error("The test did not run to completion:", error.message);
  process.exit(2);
});
