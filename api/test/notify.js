// ---------------------------------------------------------------------------
// Web Push notifications, without a stack
// ---------------------------------------------------------------------------
//   node api/test/notify.js
//
// A local HTTPS server (a self-signed certificate made with openssl) plays a
// push service; the database, the model and the other controllers are
// replaced by stubs, so the real inbox controller, the real notifier, the real
// sender (web-push, real encryption) and the real subscription storage SQL
// run. Each message is decrypted with the subscription's own key, so what is
// checked is what a phone would receive.
//
// Subscription validation: https only, the real push services' hosts only, no
// IP literal, userinfo, odd port, lookalike host or oversize field; the
// environment can add a host (never an IP) and nothing else.
// Sending: a draft, a good reading and a failed one are announced (worded
// differently), a dropped one and one resolved meanwhile are not; only the
// wallet's active read-write members' devices are asked for; the payload is
// exactly { title, body, url, tag } with no raw text, amount or merchant
// unless BUSSOLA_NOTIFY_DETAILS=on; each person hears it in their own
// language; a burst becomes one message plus one summary, per wallet; 404 and
// 410 delete the subscription, a 500, a timeout and a dead port are logged by
// code and host only and break nothing; no endpoint path, key or VAPID private
// key is in any log; nothing happens with BUSSOLA_PUBLIC_URL unset; the VAPID
// key pair is created once and its private half is never logged.

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

let logged = "";
for (const level of ["log", "error", "warn"]) {
  console[level] = (...args) => {
    logged += `${args.map(String).join(" ")}\n`;
  };
}

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}\n`);
};

// --- stubs ------------------------------------------------------------------
const stub = (file, exports) => {
  const resolved = require.resolve(path.join("..", file));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
let updateCount = 1;
let authQueries = [];
let walletRows = []; // what "the active rw members' subscriptions" returns
let secrets = new Map();
const fakeDb = {
  withTenant: async (_t, fn) => fn(),
  query: async (text) => {
    if (/select raw_text/.test(text)) return { rows: [{ raw_text: "SECRET TEXT 4242", source: "t", today: "2026-10-01" }] };
    if (/^\s*select id, name/.test(text)) return { rows: [] };
    if (/insert into inbox_items/.test(text)) return { rows: [{ id: 1 }], rowCount: 1 };
    return { rows: [], rowCount: updateCount };
  },
  queryAuth: async (text, params = []) => {
    authQueries.push({ text, params });
    if (/FROM wallet_members/.test(text)) return { rows: walletRows.filter((r) => r.wallet === params[0]) };
    if (/FROM push_subscriptions s JOIN users/.test(text)) return { rows: walletRows.filter((r) => r.user_id === params[0]) };
    if (/SELECT value FROM server_secrets/.test(text)) return { rows: secrets.has(params[0]) ? [{ value: secrets.get(params[0]) }] : [] };
    if (/INSERT INTO server_secrets/.test(text)) {
      if (!secrets.has(params[0])) secrets.set(params[0], params[1]);
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO push_subscriptions/.test(text)) return { rows: [{ id: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  },
};
const GOOD = { ok: true, draft: { amount: 12.4, currency: "EUR", date: null, merchant: "Bar Roma", typeId: 1, fromId: null, toId: null } };
let reading = GOOD;
stub("dbConn.js", fakeDb);
stub("services/inbox/extract.js", {
  aiEnabled: () => true,
  readNotification: async () => reading,
});
stub("services/inbox/history.js", { similarPast: async () => [] });
stub("auth/bankNames.js", { readerContext: async () => ({ bankNames: [], currency: "EUR" }) });
stub("auth/wallets.js", { writersByWallet: async () => [] });
stub("controllers/transactions_controller.js", {});

const controller = require("../controllers/inbox_controller");
const notify = require("../services/notify");
const push = require("../services/push");
const webpush = require("web-push");
const ece = require("http_ece");

// --- a fake push service, over https ------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bussola-push-"));
execFileSync("openssl", [
  "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2",
  "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
  "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
], { stdio: "ignore" });

let received = [];
let behaviour = "ok";
const server = https.createServer(
  { key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) },
  (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      if (behaviour === "hang") return;
      res.statusCode = { ok: 201, "404": 404, "410": 410, "500": 500 }[behaviour] || 201;
      res.end("{}");
    });
  },
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A device: the keys a browser would have made, and the endpoint's secret path.
const device = (id, userId, locale, wallet = 1, extraPath = "") => {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = crypto.randomBytes(16);
  return {
    id,
    user_id: userId,
    wallet,
    locale,
    endpoint: `https://127.0.0.1:${server.address().port}/push/SECRETPATH${id}${extraPath}`,
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: authSecret.toString("base64url"),
    ecdh,
    authSecret,
  };
};

// What the phone would read: the push message, decrypted.
const decrypt = (message, d) =>
  JSON.parse(ece.decrypt(message.body, { version: "aes128gcm", privateKey: d.ecdh, authSecret: d.authSecret }).toString("utf8"));
const forDevice = (d) => received.filter((m) => m.path.includes(`SECRETPATH${d.id}`));

const VAPID = webpush.generateVAPIDKeys();

const reset = (extra = {}) => {
  received = [];
  logged = "";
  behaviour = "ok";
  updateCount = 1;
  reading = GOOD;
  authQueries = [];
  walletRows = [];
  notify.reset();
  for (const k of ["BUSSOLA_NOTIFY_DETAILS", "BUSSOLA_PUBLIC_URL", "BUSSOLA_PUSH_ALLOWED_HOSTS"]) delete process.env[k];
  process.env.BUSSOLA_PUBLIC_URL = "https://b.example.com";
  Object.assign(process.env, extra);
  push.setKeysForTest(VAPID);
};

// A ready-made draft, through createItem and a response that finishes.
const sendDraft = async () => {
  const listeners = [];
  const res = {
    statusCode: 0,
    once: (e, f) => listeners.push([e, f]),
    status(c) {
      this.statusCode = c;
    },
  };
  await controller.createItem(
    { body: { source: "t", draft: { amount: 7.5, description: "Cafe Luna" } }, token: { walletId: 1, userId: 1 } },
    res,
  );
  for (const [e, f] of listeners) if (e === "finish") f();
  await wait(150);
};
const read = async (walletId = 1) => {
  await controller._readItem({ id: 1, walletId, userId: 1 });
  await wait(150);
};

const sub = (endpoint, keys = {}) => ({
  subscription: { endpoint, keys: { p256dh: "B".repeat(87), auth: "a".repeat(22), ...keys } },
});
const verdict = (body) => push.validateSubscription(body);

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });
  push.configure({ agent, anyHost: true, timeoutMs: 400 });
  notify.configure({ windowMs: 1000 });

  // ---- validation ------------------------------------------------------------
  reset();
  const accepted = [
    "https://fcm.googleapis.com/fcm/send/abcdefghijklmnop",
    "https://android.googleapis.com/gcm/send/abcdefghijk",
    "https://updates.push.services.mozilla.com/wpush/v2/abcdefgh",
    "https://web.push.apple.com/QAbcdefghijklmnop",
    "https://wns2-par02p.notify.windows.com/w/?token=abcdefghijk",
  ];
  record("the real push services are accepted", accepted.every((e) => verdict(sub(e)).ok), JSON.stringify(accepted.map((e) => verdict(sub(e)))));
  record("the subscription may be the object itself", verdict({ endpoint: accepted[0], keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } }).ok);

  const refused = {
    "plain http": "http://fcm.googleapis.com/fcm/send/abcdefghijklmnop",
    "other scheme": "ftp://fcm.googleapis.com/fcm/send/abcdefghijklmnop",
    "IPv4 literal": "https://142.250.185.74/fcm/send/abcdefghijklmnop",
    "loopback": "https://127.0.0.1/push/abcdefghijklmnopqrstuv",
    "IPv6 literal": "https://[::1]/push/abcdefghijklmnopqrstuv",
    "localhost": "https://localhost/push/abcdefghijklmnopqrstuv",
    "internal name": "https://api:3001/api/auth/me/abcdefghijk",
    "some other host": "https://example.com/push/abcdefghijklmnopqrstuv",
    "suffix trick": "https://fcm.googleapis.com.evil.example/fcm/send/abcdefghijk",
    "prefix trick": "https://evilfcm.googleapis.com/fcm/send/abcdefghijk",
    "userinfo": "https://fcm.googleapis.com@evil.example/fcm/send/abcdefghijk",
    "credentials": "https://user:pw@fcm.googleapis.com/fcm/send/abcdefghijk",
    "other port": "https://fcm.googleapis.com:8443/fcm/send/abcdefghijk",
    "trailing dot": "https://fcm.googleapis.com./fcm/send/abcdefghijk",
    "bare wildcard parent": "https://push.apple.com/abcdefghijklmnopqrstuv",
    "whitespace": "https://fcm.googleapis.com/fcm/send/abc def ghijk",
    "too long": `https://fcm.googleapis.com/fcm/send/${"a".repeat(1100)}`,
    "not a URL": "not a url at all, really not",
  };
  for (const [name, endpoint] of Object.entries(refused)) {
    const v = verdict(sub(endpoint));
    record(`refused: ${name}`, !v.ok, JSON.stringify(v));
  }
  const ep = accepted[0];
  record("refused: no body, no endpoint, endpoint not a string", !verdict(null).ok && !verdict({}).ok && !verdict({ subscription: { endpoint: 5 } }).ok);
  record("refused: no keys, keys not strings", !verdict({ subscription: { endpoint: ep } }).ok && !verdict(sub(ep, { auth: 5 })).ok);
  record("refused: oversize or malformed keys", !verdict(sub(ep, { p256dh: "B".repeat(300) })).ok && !verdict(sub(ep, { auth: "a".repeat(200) })).ok && !verdict(sub(ep, { auth: "a b c d e f g h" })).ok && !verdict(sub(ep, { p256dh: "short" })).ok);
  record("a refused host says so, other faults say invalid", verdict(sub(refused["some other host"])).code === "PUSH_ENDPOINT_NOT_ALLOWED" && verdict(sub(ep, { auth: "x" })).code === "INVALID_PUSH_SUBSCRIPTION");

  process.env.BUSSOLA_PUSH_ALLOWED_HOSTS = "push.example.org, *.pushy.example.net, 10.0.0.5, [::1], *";
  record("BUSSOLA_PUSH_ALLOWED_HOSTS adds a host and a wildcard", verdict(sub("https://push.example.org/abcdefghijklmnopqrst")).ok && verdict(sub("https://eu.pushy.example.net/abcdefghijklmnopqrst")).ok);
  record("it never adds an IP literal, or everything", !verdict(sub("https://10.0.0.5/abcdefghijklmnopqrstuvw")).ok && !verdict(sub("https://example.com/abcdefghijklmnopqrstuvw")).ok);
  record("and the built-in list stays", verdict(sub(ep)).ok);
  delete process.env.BUSSOLA_PUSH_ALLOWED_HOSTS;

  // ---- VAPID key pair ---------------------------------------------------------
  reset();
  push.setKeysForTest(null);
  secrets = new Map();
  await push.init();
  const stored = JSON.parse(secrets.get("vapid") || "{}");
  record("init creates the key pair once, and push is on", push.enabled() && Boolean(stored.privateKey) && push.publicKey() === stored.publicKey);
  record("the private key is in no log", !logged.includes(stored.privateKey));
  const first = push.publicKey();
  await push.init();
  record("a second start keeps the same key pair", push.publicKey() === first);
  delete process.env.BUSSOLA_PUBLIC_URL;
  await push.init();
  record("with BUSSOLA_PUBLIC_URL unset push is off and exposes no key", !push.enabled() && push.publicKey() === null);
  process.env.BUSSOLA_PUBLIC_URL = "http://192.168.1.5:3000";
  await push.init();
  record("an http address on the LAN does not enable it either", !push.enabled());
  reset();

  // ---- the sender --------------------------------------------------------------
  const alice = device(1, 10, "en");
  const bruno = device(2, 11, "it");
  const aliceTwo = device(3, 10, "en");
  const otherWallet = device(4, 12, "en", 2);

  reset();
  walletRows = [alice, bruno, aliceTwo, otherWallet];
  await sendDraft();
  record("a ready-made draft reaches the devices of the wallet", forDevice(alice).length === 1 && forDevice(aliceTwo).length === 1 && forDevice(bruno).length === 1, String(received.length));
  record("not another wallet's", forDevice(otherWallet).length === 0);
  const m = forDevice(alice)[0];
  record("the query asks for active read-write members only", authQueries.some((q) => /m\.role = 'rw'/.test(q.text) && /u\.active/.test(q.text)));
  const data = m ? decrypt(m, alice) : {};
  record("payload is exactly { title, body, url, tag }", JSON.stringify(Object.keys(data).sort()) === JSON.stringify(["body", "tag", "title", "url"]), JSON.stringify(data));
  record("title, url (same-origin path), tag", data.title === "Bussola" && data.url === "/transactions" && data.tag === "bussola-inbox");
  record("default body says only that something waits", data.body === "A transaction is waiting for you to confirm", data.body);
  record("each person hears it in their own language", /aspetta la tua conferma/.test(forDevice(bruno)[0] ? decrypt(forDevice(bruno)[0], bruno).body : ""));
  record("TTL, urgency, topic, VAPID and encoding", m && m.headers.ttl === "14400" && m.headers.urgency === "high" && m.headers.topic === "bussola-inbox" && /^vapid /.test(m.headers.authorization) && m.headers["content-encoding"] === "aes128gcm", JSON.stringify(m && m.headers));
  record("the VAPID header carries the public key", m && m.headers.authorization.includes(VAPID.publicKey));

  // successful reading
  reset();
  walletRows = [alice];
  await read();
  record("a successful reading sends", forDevice(alice).length === 1 && /waiting for you to confirm/.test(decrypt(forDevice(alice)[0], alice).body));
  record("no raw text, amount or merchant in the payload", received.every((r) => !/SECRET TEXT|4242|12\.4|Roma/.test(JSON.stringify(decrypt(r, alice)))));

  // details on
  reset({ BUSSOLA_NOTIFY_DETAILS: "on" });
  walletRows = [alice];
  await read();
  const detailed = forDevice(alice)[0] ? decrypt(forDevice(alice)[0], alice) : {};
  record("details on: amount and merchant, still no raw text", /12\.40 EUR · Bar Roma/.test(detailed.body || "") && !/SECRET TEXT/.test(JSON.stringify(detailed)), detailed.body);

  // failed reading
  reset();
  walletRows = [alice];
  reading = { ok: false, reason: "AI_FAILED" };
  await read();
  record("a failed reading sends, saying it needs the hand", forDevice(alice).length === 1 && /could not be read/.test(decrypt(forDevice(alice)[0], alice).body));

  // dropped
  reset();
  walletRows = [alice];
  reading = { ok: true, skip: true };
  await read();
  record("a dropped (not a transaction) item pushes nothing", received.length === 0);

  // resolved meanwhile
  reset();
  walletRows = [alice];
  updateCount = 0;
  await read();
  record("an item resolved while the model thought pushes nothing", received.length === 0);

  // off
  reset();
  walletRows = [alice];
  delete process.env.BUSSOLA_PUBLIC_URL;
  await sendDraft();
  await read();
  record("nothing is sent with BUSSOLA_PUBLIC_URL unset", received.length === 0 && !authQueries.some((q) => /wallet_members/.test(q.text)));
  reset();

  // zh body
  walletRows = [device(5, 13, "zh")];
  const zh = walletRows[0];
  await read();
  record("UTF-8 body (zh)", forDevice(zh)[0] && decrypt(forDevice(zh)[0], zh).body.includes("确认"));

  // rate limit, per wallet
  reset();
  walletRows = [alice, otherWallet];
  for (let i = 0; i < 5; i += 1) await controller._readItem({ id: 1, walletId: 1, userId: 1 });
  await wait(250);
  record("a burst: only the first goes out at once", forDevice(alice).length === 1, String(forDevice(alice).length));
  await read(2);
  record("another wallet has its own window", forDevice(otherWallet).length === 1);
  await wait(900);
  record("then one summary for the other four", forDevice(alice).length === 2 && /^4 items are waiting/.test(decrypt(forDevice(alice)[1], alice).body), JSON.stringify(forDevice(alice).length));
  await wait(1000);
  record("and nothing more", forDevice(alice).length === 2);
  await read(1);
  record("a quiet window later, a new message goes out at once", forDevice(alice).length === 3);

  // A single item held back by the window keeps its details; two or more are a
  // count with none.
  reset({ BUSSOLA_NOTIFY_DETAILS: "on" });
  walletRows = [alice];
  await read();
  await read();
  await wait(1500);
  const heldOne = forDevice(alice).slice(-2).map((m) => decrypt(m, alice).body);
  record("details on: the first goes out at once, and the one held for the window keeps its details too",
    heldOne.length === 2 && /12\.40 EUR · Bar Roma/.test(heldOne[0]) && /12\.40 EUR · Bar Roma/.test(heldOne[1]), JSON.stringify(heldOne));
  reset({ BUSSOLA_NOTIFY_DETAILS: "on" });
  walletRows = [alice];
  const beforeMany = forDevice(alice).length;
  for (let i = 0; i < 3; i += 1) await read();
  await wait(1500);
  const manyBodies = forDevice(alice).slice(beforeMany).map((m) => decrypt(m, alice).body);
  record("details on: two or more held are one count, with no amount or merchant",
    manyBodies.length === 2 && /^2 items are waiting/.test(manyBodies[1]) && !/Bar Roma|EUR/.test(manyBodies[1]), JSON.stringify(manyBodies));

  // dead subscriptions
  await wait(1050);
  for (const code of ["404", "410"]) {
    reset();
    walletRows = [alice];
    behaviour = code;
    await read();
    record(`${code} deletes the subscription`, authQueries.some((q) => /DELETE FROM push_subscriptions WHERE id = \$1 AND user_id = \$2/.test(q.text) && q.params[0] === alice.id && q.params[1] === alice.user_id));
    record(`${code} is logged as a code and a host, nothing else`, new RegExp(`\\[push\\] could not send \\(HTTP_${code}\\) to 127\\.0\\.0\\.1:\\d+`).test(logged) && !logged.includes("SECRETPATH") && !logged.includes(alice.p256dh) && !logged.includes(alice.auth) && !logged.includes(VAPID.privateKey), logged);
    await wait(1050);
  }
  reset();
  walletRows = [alice];
  behaviour = "500";
  await read();
  record("a 500 is logged and keeps the subscription", /\(HTTP_500\)/.test(logged) && !authQueries.some((q) => /DELETE FROM push_subscriptions/.test(q.text)), logged);
  await wait(1050);

  // timeout
  reset();
  walletRows = [alice];
  behaviour = "hang";
  const t0 = Date.now();
  await controller._readItem({ id: 1, walletId: 1, userId: 1 });
  const returned = Date.now() - t0;
  await wait(1100);
  record("a timeout is logged and the reader is not held", /\(TIMEOUT\)/.test(logged) && returned < 300, `${returned} ms: ${logged}`);
  await wait(1050);

  // dead port
  reset();
  const dead = device(6, 14, "en");
  dead.endpoint = "https://127.0.0.1:1/push/SECRETPATH6";
  walletRows = [dead];
  await read();
  await wait(100);
  record("a dead port is logged as NETWORK, without the path", /\(NETWORK\)/.test(logged) && !logged.includes("SECRETPATH"), logged);
  await wait(1050);

  // the sender re-checks the host of what is stored (production setting)
  reset();
  push.configure({ anyHost: false });
  walletRows = [alice];
  await read();
  record("a stored endpoint on a host outside the list is refused and deleted, nothing is sent", received.length === 0 && authQueries.some((q) => /DELETE FROM push_subscriptions WHERE id/.test(q.text)) && /NOT_ALLOWED/.test(logged) && !logged.includes("SECRETPATH"), logged);
  push.configure({ anyHost: true });
  await wait(1050);

  // the test notification
  reset();
  walletRows = [alice, bruno];
  const sent = await notify.sendTest(10);
  record("the test notification goes to the person's own devices, in their language", sent === 1 && forDevice(alice).length === 1 && forDevice(bruno).length === 0 && decrypt(forDevice(alice)[0], alice).tag === "bussola-test" && /Notifications are working/.test(decrypt(forDevice(alice)[0], alice).body));

  // pushStore: the statements name the user
  reset();
  const pushStore = require("../auth/pushStore");
  await pushStore.saveSubscription(10, "SESSIONHASH", { endpoint: ep, p256dh: "B".repeat(87), auth: "a".repeat(22), userAgent: "UA" });
  await pushStore.isSubscribed(10, "SESSIONHASH", ep);
  await pushStore.removeSubscription(10, ep);
  record("saving trims to the newest 10 per user", authQueries.some((q) => /OFFSET \$2/.test(q.text) && q.params[0] === 10 && q.params[1] === 10));
  record("saving binds the subscription to the caller's session, also when the endpoint was already stored",
    authQueries.some((q) => /INSERT INTO push_subscriptions/.test(q.text) && q.params[1] === "SESSIONHASH" && /session_hash\s*= EXCLUDED\.session_hash/.test(q.text)));
  record("a session keeps one subscription: saving drops the session's other endpoints",
    authQueries.some((q) => /DELETE FROM push_subscriptions WHERE user_id = \$1 AND session_hash = \$2 AND id <> \$3/.test(q.text) && q.params[1] === "SESSIONHASH"));
  record("the status check is scoped to the caller's session",
    authQueries.some((q) => /SELECT 1 FROM push_subscriptions/.test(q.text) && /session_hash = \$2/.test(q.text) && q.params[1] === "SESSIONHASH"));
  {
    const src = fs.readFileSync(path.join(__dirname, "..", "auth", "pushStore.js"), "utf8");
    const joins = src.match(/JOIN sessions ss ON ss\.token_hash = s\.session_hash AND ss\.user_id = s\.user_id\s+AND ss\.expires_at > now\(\)/g) || [];
    record("both send lookups skip subscriptions whose session has expired", joins.length === 2, `${joins.length} joins`);
  }
  record("every statement of the person's own names the user", authQueries.every((q) => q.params.includes(10)));

  server.closeAllConnections();
  server.close();
  agent.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
  process.exit(failed ? 1 : 0);
})();
