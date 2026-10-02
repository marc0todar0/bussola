// ---------------------------------------------------------------------------
// Web Push endpoints: a device's subscription
// ---------------------------------------------------------------------------
// Mounted by routes.js at /api/auth/push. All of them need a session; none
// needs a wallet (a subscription belongs to the person's device, see
// migration 005, and to the session that saved it, migration 006: signing
// out removes it), and none can touch another person's subscription: every
// statement in pushStore.js names the session's user id.
//
//   POST   /subscribe  { subscription: PushSubscription.toJSON() }  -> 201 { ok }
//   POST   /status     { endpoint }                                 -> { subscribed }
//   DELETE /subscribe  { endpoint }                                 -> { ok }
//   POST   /test                                                    -> { sent }
//
// /status is a POST so that the endpoint, a secret of sorts, travels in the
// body and not in a URL that an access log would keep.
//
// What the interface learns about push (on or off, and the public VAPID key,
// which is public by design) travels with GET /api/auth/status, next to the
// passkeys' flag.
//
// The subscribe endpoint is the SSRF gate: the server will later POST to the
// URL it is given, so services/push.js only lets through https endpoints on
// the real push services' hosts.
const router = require("express").Router;
const { requireAuth } = require("./middleware");
const sessions = require("./sessions");
const { limits, tooMany } = require("./throttle");
const store = require("./pushStore");
const push = require("../services/push");
const notifier = require("../services/notify");

// The caller's own session, as push_subscriptions refers to it. requireAuth
// has already found the cookie valid.
const sessionHash = (req) => sessions.fingerprint(req.cookies[sessions.COOKIE_NAME]);

const validEndpoint = (endpoint) =>
  typeof endpoint === "string" && endpoint.length >= 20 && endpoint.length <= 1024;

const pushRoutes = ({ fail }) => {
  const r = router();

  const requireEnabled = (req, res, next) => {
    if (push.enabled()) return next();
    fail(
      res,
      404,
      "PUSH_DISABLED",
      "Notifications on the phone are not enabled on this instance. Whoever administers it can enable " +
        "them by setting BUSSOLA_PUBLIC_URL to the address Bussola is served from over HTTPS.",
    );
  };

  r.post("/subscribe", requireAuth, requireEnabled, async (req, res) => {
    const checked = push.validateSubscription(req.body);
    if (!checked.ok) {
      return fail(
        res,
        400,
        checked.code,
        checked.code === "PUSH_ENDPOINT_NOT_ALLOWED"
          ? "This push service is not accepted"
          : "The subscription is not valid",
      );
    }
    try {
      const userAgent = String(req.get("user-agent") || "").slice(0, 200);
      await store.saveSubscription(req.user.id, sessionHash(req), { ...checked.subscription, userAgent });
      res.status(201).json({ ok: true });
    } catch (error) {
      console.error("Could not save the push subscription:", error.code || "FAILED");
      fail(res, 500, "PUSH_SAVE_FAILED", "Could not save the subscription");
    }
  });

  // Whether the browser's own subscription is the one this session saved. The
  // browser keeps its subscription across sign-outs, but the server dropped
  // it with the session that saved it: without asking, the Profile would
  // show notifications as on for whoever signs in next. Answers false, never
  // an error, with push off, for an unknown endpoint, and for somebody
  // else's.
  r.post("/status", requireAuth, async (req, res) => {
    const endpoint = req.body && req.body.endpoint;
    if (!validEndpoint(endpoint)) {
      return fail(res, 400, "INVALID_PUSH_SUBSCRIPTION", "The subscription is not valid");
    }
    try {
      const subscribed = push.enabled() && (await store.isSubscribed(req.user.id, sessionHash(req), endpoint));
      res.json({ subscribed });
    } catch (error) {
      console.error("Could not check the push subscription:", error.code || "FAILED");
      fail(res, 500, "PUSH_STATUS_FAILED", "Could not check the subscription");
    }
  });

  // Only the caller's own subscription: somebody else's endpoint is "not
  // found", exactly like one that never existed.
  r.delete("/subscribe", requireAuth, async (req, res) => {
    const endpoint = req.body && req.body.endpoint;
    if (!validEndpoint(endpoint)) {
      return fail(res, 400, "INVALID_PUSH_SUBSCRIPTION", "The subscription is not valid");
    }
    try {
      if (!(await store.removeSubscription(req.user.id, endpoint))) {
        return fail(res, 404, "PUSH_SUBSCRIPTION_NOT_FOUND", "No such subscription");
      }
      res.json({ ok: true });
    } catch (error) {
      console.error("Could not remove the push subscription:", error.code || "FAILED");
      fail(res, 500, "PUSH_REMOVE_FAILED", "Could not remove the subscription");
    }
  });

  // Every call counts, whatever it finds: it makes the push service do work.
  r.post("/test", requireAuth, requireEnabled, async (req, res) => {
    const key = String(req.user.id);
    const wait = await limits.pushTestPerUser.blocked(key);
    if (wait) return tooMany(res, wait);
    await limits.pushTestPerUser.hit(key);
    try {
      const devices = await store.subscriptionsForUser(req.user.id);
      if (!devices.length) {
        return fail(res, 409, "NO_PUSH_SUBSCRIPTION", "This account has no device subscribed to notifications");
      }
      const sent = await notifier.sendTest(req.user.id);
      if (!sent) return fail(res, 502, "PUSH_TEST_FAILED", "No device accepted the test notification");
      res.json({ sent });
    } catch (error) {
      console.error("Could not send the test notification:", error.code || "FAILED");
      fail(res, 500, "PUSH_TEST_FAILED", "Could not send the test notification");
    }
  });

  return r;
};

module.exports = { pushRoutes };
