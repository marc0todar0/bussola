// Web Push on this device: what the browser can do, and the three actions.
//
// The server (api/services/push.js) is on only with BUSSOLA_PUBLIC_URL, and
// says so in GET /api/auth/status as `push` with its public key. The service
// worker (public/sw.js) is registered only from here, only when push is on
// and the person turned it on (or already had) on this device -- never for
// anyone else, and it caches nothing.
import { pushStatus, pushSubscribe, pushUnsubscribe } from "./session";

const SW_URL = "/sw.js";

const isIos = () => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPadOS 13+ says "Macintosh" but has a touch screen.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
};

const isStandalone = () =>
  typeof window !== "undefined" &&
  (window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches));

const hasApis = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

// Why a device can or cannot turn notifications on, before asking it to:
//   "insecure"  not https (or localhost): browsers offer no service workers
//   "ios-install" iPhone/iPad in a Safari tab: Web Push only works once Bussola
//               is added to the Home Screen (iOS 16.4 or later)
//   "unsupported" this browser has no Web Push
//   "blocked"   the person said no in the browser's settings
//   "ready"     it can be asked
export const pushCapability = () => {
  if (typeof window === "undefined" || !window.isSecureContext) return "insecure";
  if (!hasApis()) return isIos() && !isStandalone() ? "ios-install" : "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return "ready";
};

// The VAPID key as the bytes pushManager.subscribe() wants.
const keyBytes = (base64url) => {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const registration = async () => {
  await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  return navigator.serviceWorker.ready;
};

// The subscription this browser already holds, or null. Never registers a
// worker: only looks at one that is already there.
export const currentSubscription = async () => {
  if (pushCapability() === "insecure" || !hasApis()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_URL);
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch {
    return null;
  }
};

// Who turned notifications on in this browser. The server binds a
// subscription to the session that saved it (migration 006), so signing out,
// or a session ending, stops it; when the same person signs in here again it
// is bound to the new session without a trip to the Profile. Somebody else
// signing in on this browser gets nothing until they turn it on themselves.
const OWNER_KEY = "bussola.pushOwner";
export const rememberPushOwner = (userId) => {
  try {
    if (userId == null) localStorage.removeItem(OWNER_KEY);
    else localStorage.setItem(OWNER_KEY, String(userId));
  } catch {
    /* no storage: it is asked for again from the Profile */
  }
};
const pushOwner = () => {
  try {
    return localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
};

// After a sign-in. A subscription the server holds for this session marks
// this browser as that person's; one it no longer holds (signed out, the
// session ended) is posted again, but only for the person who turned it on
// here, with permission still granted. Quiet: it never asks for permission.
export const rebindForOwner = async (status, userId) => {
  if (!status || !status.push || userId == null) return;
  if (pushCapability() !== "ready" || Notification.permission !== "granted") return;
  try {
    const subscription = await currentSubscription();
    if (!subscription) return;
    const held = await pushStatus(subscription.endpoint);
    if (!held.ok) return; // unreachable or refused: try at the next start
    if (held.body && held.body.subscribed) return rememberPushOwner(userId);
    if (String(userId) !== pushOwner()) return;
    await pushSubscribe(subscription.toJSON());
  } catch {
    /* it can still be turned on from the Profile */
  }
};

// At startup: if push is on and this device is already subscribed, register
// the worker again so a tap on a notification works after a reload. Anyone
// else gets no worker at all.
export const registerIfSubscribed = async (status) => {
  if (!status || !status.push || pushCapability() === "insecure" || !hasApis()) return;
  try {
    if (await currentSubscription()) await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  } catch {
    /* a worker that will not register changes nothing for the app itself */
  }
};

// Every failure is { ok: false, body: { code } } -- the shape a server answer
// has, so the page translates one kind of failure.
const failure = (code, error) => ({ ok: false, status: 0, body: { code, error: (error && error.message) || code } });

// Must be called from a click: the permission prompt needs a user gesture.
export const enablePush = async (publicKey) => {
  if (pushCapability() === "blocked") return failure("PUSH_PERMISSION_DENIED");
  if (pushCapability() !== "ready" || !publicKey) return failure("PUSH_UNSUPPORTED");
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return failure("PUSH_PERMISSION_DENIED");
    const reg = await registration();
    const existing = await reg.pushManager.getSubscription();
    const subscription =
      existing ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
    const result = await pushSubscribe(subscription.toJSON());
    // The server refused it: do not leave a subscription it does not know.
    if (!result.ok && !existing) await subscription.unsubscribe().catch(() => {});
    return result;
  } catch (error) {
    return failure("PUSH_DEVICE_ERROR", error);
  }
};

export const disablePush = async () => {
  try {
    const subscription = await currentSubscription();
    if (!subscription) return { ok: true, status: 200, body: { ok: true } };
    const result = await pushUnsubscribe(subscription.endpoint);
    // 404: the server had already forgotten it; either way it ends here.
    if (!result.ok && result.status !== 404) return result;
    await subscription.unsubscribe();
    rememberPushOwner(null);
    return { ok: true, status: 200, body: { ok: true } };
  } catch (error) {
    return failure("PUSH_DEVICE_ERROR", error);
  }
};
