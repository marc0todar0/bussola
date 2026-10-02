// ---------------------------------------------------------------------------
// Web Push: the transport
// ---------------------------------------------------------------------------
// What puts a notification on a phone with no third-party app: the browser
// hands its push service (Google's, Mozilla's, Apple's, Microsoft's) a
// subscription; this server POSTs an encrypted message to the subscription's
// URL, signed with its own VAPID key; the push service delivers it to the
// installed web app's service worker (frontend/public/sw.js).
//
// ON only when BUSSOLA_PUBLIC_URL is valid -- the same rule as passkeys
// (auth/publicUrl.js) -- and the VAPID key pair has been loaded. The key pair
// is generated at the first start and kept in server_secrets; the private key
// is only ever held in this module and handed to the web-push library: never
// logged, never in an error, never in an answer.
//
// SSRF. The server POSTs to a URL the *client* supplied. So a subscription is
// accepted only if its endpoint is https, on the default port, with a host
// that is not an IP literal and is on an allow-list of the real push services
// (validateSubscription). The sender checks the host again before every send,
// since rows outlive the version that wrote them, and web-push does not
// follow redirects. BUSSOLA_PUSH_ALLOWED_HOSTS adds hosts (never IP literals)
// for a push service not in the list.
//
// Sending never throws, never blocks the caller, times out after 5 s, does not
// retry. A subscription the push service answers 404 or 410 for is deleted.
// A failure is logged as a code and the push service's host -- never the
// endpoint (its path is a secret), the keys or the payload.
const webpush = require("web-push");
const { parseRelyingParty } = require("../auth/publicUrl");
const store = require("../auth/pushStore");

const VAPID_SECRET = "vapid";

// The real push services. "*." matches one or more labels.
const DEFAULT_HOSTS = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "*.push.services.mozilla.com",
  "*.push.apple.com",
  "*.notify.windows.com",
];

const LIMITS = { endpoint: 1024, key: 256, auth: 128 };
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const settings = { timeoutMs: 5_000, ttlSeconds: 4 * 60 * 60, agent: undefined, anyHost: false };
// Tests only (nothing in the application calls it): a short timeout, an
// https.Agent that trusts a local fake push service, and a host check that
// lets that service's 127.0.0.1 through the sender.
const configure = (options = {}) => Object.assign(settings, options);

const isIpLiteral = (host) => /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[");

const hostList = () => {
  const extra = String(process.env.BUSSOLA_PUSH_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h && !isIpLiteral(h) && h !== "*" && h !== "*.");
  return [...DEFAULT_HOSTS, ...extra];
};

const hostAllowed = (host) => {
  const h = String(host || "").toLowerCase();
  if (!h || isIpLiteral(h) || h.endsWith(".")) return false;
  return hostList().some((pattern) =>
    pattern.startsWith("*.") ? h.length > pattern.length - 1 && h.endsWith(pattern.slice(1)) : h === pattern,
  );
};

// ---------------------------------------------------------------------------
// Validation of what a browser sends to POST /api/auth/push/subscribe
// ---------------------------------------------------------------------------
// -> { ok: true, subscription: { endpoint, p256dh, auth } } or { ok: false, code }.
const validateSubscription = (body) => {
  const bad = (code) => ({ ok: false, code });
  const sub = body && typeof body === "object" ? body.subscription || body : null;
  if (!sub || typeof sub.endpoint !== "string") return bad("INVALID_PUSH_SUBSCRIPTION");

  const raw = sub.endpoint;
  if (raw.length < 20 || raw.length > LIMITS.endpoint || /[^\x21-\x7e]/.test(raw)) {
    return bad("INVALID_PUSH_SUBSCRIPTION");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return bad("INVALID_PUSH_SUBSCRIPTION");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    return bad("PUSH_ENDPOINT_NOT_ALLOWED");
  }
  if (isIpLiteral(url.hostname) || !hostAllowed(url.hostname)) return bad("PUSH_ENDPOINT_NOT_ALLOWED");

  const keys = sub.keys;
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
    return bad("INVALID_PUSH_SUBSCRIPTION");
  }
  if (
    keys.p256dh.length < 20 || keys.p256dh.length > LIMITS.key || !BASE64URL.test(keys.p256dh) ||
    keys.auth.length < 8 || keys.auth.length > LIMITS.auth || !BASE64URL.test(keys.auth)
  ) {
    return bad("INVALID_PUSH_SUBSCRIPTION");
  }
  return { ok: true, subscription: { endpoint: url.href, p256dh: keys.p256dh, auth: keys.auth } };
};

// ---------------------------------------------------------------------------
// The VAPID key pair
// ---------------------------------------------------------------------------
let vapid = null; // { publicKey, privateKey } once loaded

const publicUrlState = () => parseRelyingParty(process.env.BUSSOLA_PUBLIC_URL);

// At startup, after the migrations. Does nothing when BUSSOLA_PUBLIC_URL does
// not enable the feature. Never throws: push stays off and the API starts.
const init = async () => {
  vapid = null;
  const { rp } = publicUrlState();
  if (!rp) return;
  try {
    let stored = await store.readSecret(VAPID_SECRET);
    if (!stored) {
      const keys = webpush.generateVAPIDKeys();
      stored = await store.createSecretOnce(VAPID_SECRET, JSON.stringify(keys));
    }
    const parsed = JSON.parse(stored);
    if (!parsed.publicKey || !parsed.privateKey) throw new Error("incomplete");
    vapid = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
    console.log(`[push] Web Push enabled for ${rp.origin}.`);
  } catch (error) {
    console.error(`[push] Web Push disabled: could not load the VAPID key (${error.code || "FAILED"}).`);
  }
};

const enabled = () => Boolean(vapid && publicUrlState().rp);
const publicKey = () => (enabled() ? vapid.publicKey : null);

// Tests only: set the key pair without a database.
const setKeysForTest = (keys) => {
  vapid = keys;
};

// The subject identifies the sender to the push service. https only (the
// library refuses anything else), so http://localhost is told as https.
const subject = () => {
  const { rp } = publicUrlState();
  return rp ? rp.origin.replace(/^http:/, "https:") : "";
};

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
const hostOf = (endpoint) => {
  try {
    return new URL(endpoint).host;
  } catch {
    return "invalid-url";
  }
};

const codeOf = (error) => {
  if (error && Number.isInteger(error.statusCode)) return `HTTP_${error.statusCode}`;
  if (error && (error.code === "TIMEOUT" || error.message === "Socket timeout")) return "TIMEOUT";
  return "NETWORK";
};

const withDeadline = (promise) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), settings.timeoutMs + 500);
    timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

// One message to one subscription row. Resolves to true when the push service
// accepted it; never rejects.
const sendOne = async (row, payload) => {
  const host = hostOf(row.endpoint);
  if (!settings.anyHost && !hostAllowed(host.replace(/:\d+$/, ""))) {
    console.error(`[push] refused a stored endpoint (NOT_ALLOWED) at ${host}`);
    store.dropSubscription(row.id, row.user_id).catch(() => {});
    return false;
  }
  try {
    await withDeadline(
      webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(payload),
        {
          TTL: settings.ttlSeconds,
          // High, not normal: a phone that sits still is in Doze, and a "normal"
          // message is held back until somebody opens the app -- the owner saw a
          // payment's notification only when he opened Bussola. A transaction
          // waiting to be confirmed is what a person wants to see at once, and
          // the message is shown to the person every time (userVisibleOnly).
          urgency: "high",
          // Collapses a message the phone has not received yet with the next.
          topic: "bussola-inbox",
          timeout: settings.timeoutMs,
          agent: settings.agent,
          vapidDetails: { subject: subject(), publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        },
      ),
    );
    store.touchSubscription(row.id, row.user_id).catch(() => {});
    return true;
  } catch (error) {
    const code = codeOf(error);
    if (code === "HTTP_404" || code === "HTTP_410") {
      store.dropSubscription(row.id, row.user_id).catch(() => {});
    }
    console.error(`[push] could not send (${code}) to ${host}`);
    return false;
  }
};

// rows: subscription rows (with the person's locale); makePayload(locale)
// builds the JSON for that person. Resolves to how many were accepted.
const deliver = async (rows, makePayload) => {
  if (!enabled() || !rows.length) return 0;
  const results = await Promise.all(rows.map((row) => sendOne(row, makePayload(row.locale))));
  return results.filter(Boolean).length;
};

const toWallet = async (walletId, makePayload) => {
  try {
    return await deliver(await store.subscriptionsForWallet(walletId), makePayload);
  } catch (error) {
    console.error(`[push] ${error.code || "FAILED"}`);
    return 0;
  }
};

const toUser = async (userId, makePayload) => {
  try {
    return await deliver(await store.subscriptionsForUser(userId), makePayload);
  } catch (error) {
    console.error(`[push] ${error.code || "FAILED"}`);
    return 0;
  }
};

module.exports = {
  init,
  enabled,
  publicKey,
  configure,
  setKeysForTest,
  validateSubscription,
  hostAllowed,
  toWallet,
  toUser,
  DEFAULT_HOSTS,
};
