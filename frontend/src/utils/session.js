// Session authentication client.
//
// The cookie is httpOnly: JavaScript cannot see it and cannot read it. No
// token is handled here -- the server is asked the three things that matter:
// who am I, let me in, let me out.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { getConfig } from "./runtimeConfig";

const call = async (path, options = {}) => {
  const { apiUrl } = getConfig();
  const init = {
    ...options,
    credentials: "include", // without this the session cookie is not sent
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  };
  // The demo build answers from an in-browser copy of the API (src/demo/);
  // __DEMO__ is a build-time constant, so in the real build this branch and
  // the demo code behind it are not in the bundle at all.
  //
  // A request that never got an answer (offline, the server down, DNS) is
  // turned into the same { ok, status, body } shape as a refusal, with status
  // 0 and the code NETWORK_ERROR: every caller already handles a refusal, and
  // a rejected promise nobody catches would leave a button spinning forever.
  let response;
  try {
    response = __DEMO__
      ? await (await import("../demo/browser.js")).handle(`/auth${path}`, init)
      : await fetch(`${apiUrl}/auth${path}`, init);
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { code: "NETWORK_ERROR", error: (error && error.message) || "Network error" },
    };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    /* 204 and the like */
  }
  return { ok: response.ok, status: response.status, body };
};

// Thrown by currentUser() when the server could not be asked at all: not the
// same as "nobody is signed in", which would put up the login screen in front
// of a server that is simply down.
export class ServerUnreachableError extends Error {
  constructor(status) {
    super(status ? `The server answered ${status}` : "The server could not be reached");
    this.name = "ServerUnreachableError";
    this.status = status;
  }
}

// The account signed in here, or null when there is none. No answer, or a
// gateway error from nginx with the API down behind it, throws
// ServerUnreachableError instead.
export const currentUser = async () => {
  const { ok, status, body } = await call("/me");
  if (ok) return body;
  if (status === 0 || status >= 500) throw new ServerUnreachableError(status);
  return null;
};

export const instanceStatus = async () => {
  const { ok, body } = await call("/status");
  return ok ? body : { signupOpen: false, passkeys: false, passkeyOrigin: null, push: false, pushPublicKey: null };
};

// ---------------------------------------------------------------------------
// Passkeys
// ---------------------------------------------------------------------------
// Whether a passkey button would work here, which takes three yeses: the
// browser has WebAuthn at all; the page is a secure context (https, or
// localhost) -- browsers refuse passkeys anywhere else; and the page is open
// at the one origin the server's passkeys belong to. The same instance opened
// on its LAN address would draw a button whose only outcome is an error.
export const passkeysUsable = (status) =>
  Boolean(
    status &&
      status.passkeys &&
      typeof window !== "undefined" &&
      window.isSecureContext &&
      window.PublicKeyCredential &&
      status.passkeyOrigin === window.location.origin,
  );

// The browser's own refusals, turned into the { ok, status, body } shape the
// server's answers have, so a caller handles one kind of failure rather than
// two. Cancelling the prompt is NotAllowedError, and is reported as such so
// the interface can stay quiet about it -- the person knows they cancelled.
const deviceFailure = (error) => {
  const name = (error && error.name) || "";
  const code =
    name === "NotAllowedError" || name === "AbortError"
      ? "PASSKEY_CANCELLED"
      : name === "InvalidStateError"
        ? "PASSKEY_ALREADY_REGISTERED"
        : "PASSKEY_DEVICE_ERROR";
  return { ok: false, status: 0, body: { code, error: (error && error.message) || code } };
};

// Usernameless: the device offers whichever passkeys it holds for this site,
// and the one chosen says whose account it is. The answer is a /login answer,
// cookie and all.
export const signInWithPasskey = async () => {
  const options = await call("/passkeys/login/options", { method: "POST" });
  if (!options.ok) return options;

  let response;
  try {
    response = await startAuthentication({ optionsJSON: options.body });
  } catch (error) {
    return deviceFailure(error);
  }
  return call("/passkeys/login/verify", { method: "POST", body: JSON.stringify({ response }) });
};

// The password goes first, to the server: it hands out the challenge only
// after checking it, so a session cookie on its own cannot add a passkey.
export const addPasskey = async (password, name) => {
  const options = await call("/passkeys/register/options", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  if (!options.ok) return options;

  let response;
  try {
    response = await startRegistration({ optionsJSON: options.body });
  } catch (error) {
    return deviceFailure(error);
  }
  return call("/passkeys/register/verify", {
    method: "POST",
    body: JSON.stringify({ response, name }),
  });
};

export const listPasskeys = async () => {
  const { ok, body } = await call("/passkeys");
  return ok && Array.isArray(body) ? body : [];
};

export const renamePasskey = (id, name) =>
  call(`/passkeys/${id}/name`, { method: "POST", body: JSON.stringify({ name }) });

export const deletePasskey = (id) => call(`/passkeys/${id}`, { method: "DELETE" });

// Personal API tokens, for the apps and automations that post bank
// notifications to the inbox (docs/notifications.md). Creating one asks for
// the password again; the answer carries the token itself, the only time it
// is ever shown.
export const listTokens = async () => {
  const { ok, body } = await call("/tokens");
  return ok && Array.isArray(body) ? body : [];
};

export const createToken = (label, password) =>
  call("/tokens", { method: "POST", body: JSON.stringify({ label, password }) });

export const revokeToken = (id) => call(`/tokens/${id}`, { method: "DELETE" });

// Web Push: this device's subscription (utils/push.js makes it with the
// browser). The server only accepts endpoints on the real push services.
export const pushSubscribe = (subscription) =>
  call("/push/subscribe", { method: "POST", body: JSON.stringify({ subscription }) });

export const pushUnsubscribe = (endpoint) =>
  call("/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint }) });

export const pushTest = () => call("/push/test", { method: "POST" });

// Whether the server holds this endpoint for this session. A POST, so the
// endpoint stays out of access logs.
export const pushStatus = (endpoint) =>
  call("/push/status", { method: "POST", body: JSON.stringify({ endpoint }) });

// How this person's banks write their name: told to the model that reads the
// notifications, so that a movement between two of their own accounts reads
// as a transfer. At most five names.
export const saveBankNames = (names) =>
  call("/bank-names", { method: "POST", body: JSON.stringify({ names }) });

// What to call a new passkey before the person says otherwise: the browser and
// the system it runs on, which is what tells two entries apart in the list a
// month later ("Safari on iPhone", "Chrome on Windows"). Only a suggestion --
// the field is theirs to change.
export const suggestedPasskeyName = () => {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /Firefox\//.test(ua) ? "Firefox"
    : /SamsungBrowser\//.test(ua) ? "Samsung Internet"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : null;
  const system =
    /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : null;
  if (browser && system) return `${browser} · ${system}`;
  return browser || system || "Passkey";
};

export const login = (username, password) =>
  call("/login", { method: "POST", body: JSON.stringify({ username, password }) });

export const signup = (username, password, locale) =>
  call("/signup", { method: "POST", body: JSON.stringify({ username, password, locale }) });

export const logout = () => call("/logout", { method: "POST" });

export const changePassword = (current, next) =>
  call("/password", { method: "POST", body: JSON.stringify({ current, next }) });

// The username is the credential, so changing it is a credential operation and
// the current password is asked for exactly as it is for the password itself.
// The session survives: only the label on it changes.
export const changeUsername = (username, password) =>
  call("/username", { method: "POST", body: JSON.stringify({ username, password }) });

// One's own account, for good, with every wallet it created. Both proofs are
// the server's rules: the password, and the username typed back.
export const deleteAccount = (password, confirm) =>
  call("/me", { method: "DELETE", body: JSON.stringify({ password, confirm }) });

// Best effort: the language already applies locally, this only makes the
// choice follow the account to other browsers.
export const saveLocale = (locale) =>
  call("/locale", { method: "POST", body: JSON.stringify({ locale }) }).catch(() => {});

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------
// The data belongs to a wallet, and a person can reach more than one -- their
// own, and any somebody else shared with them. Which one this session is
// looking at is a server-side fact, kept on the session row: it survives a
// reload and it is per device.
export const myWallets = async () => {
  const { ok, body } = await call("/wallets");
  return ok && Array.isArray(body) ? body : [];
};

export const selectWallet = (walletId) =>
  call("/wallet", { method: "POST", body: JSON.stringify({ walletId }) });

export const createWallet = (name) =>
  call("/wallets", { method: "POST", body: JSON.stringify({ name }) });

export const renameWallet = (walletId, name) =>
  call(`/wallets/${walletId}/name`, { method: "POST", body: JSON.stringify({ name }) });

// The unit the wallet's amounts are counted in, which every member reads them
// in. It converts nothing: the stored numbers do not move, only the symbol
// printed beside them changes.
export const setWalletCurrency = (walletId, currency) =>
  call(`/wallets/${walletId}/currency`, { method: "POST", body: JSON.stringify({ currency }) });

// The confirmation is the wallet's own name, typed by hand, and the server is
// the one that insists on it: a wallet takes its accounts, categories,
// transactions and holdings with it, and there is no undo to fall back on.
export const deleteWallet = (walletId, confirm) =>
  call(`/wallets/${walletId}`, { method: "DELETE", body: JSON.stringify({ confirm }) });

export const walletMembers = async (walletId) => {
  const { ok, body } = await call(`/wallets/${walletId}/members`);
  return ok && Array.isArray(body) ? body : [];
};

export const addWalletMember = (walletId, username, role) =>
  call(`/wallets/${walletId}/members`, {
    method: "POST",
    body: JSON.stringify({ username, role }),
  });

export const setMemberRole = (walletId, userId, role) =>
  call(`/wallets/${walletId}/members/${userId}`, {
    method: "POST",
    body: JSON.stringify({ role }),
  });

export const removeWalletMember = (walletId, userId) =>
  call(`/wallets/${walletId}/members/${userId}`, { method: "DELETE" });

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------
// Only an administrator gets an answer from these. Administering the instance
// is not a key to anyone's data: these list accounts and wallets, never what
// is inside them.
export const listUsers = async () => {
  const { ok, body } = await call("/users");
  return ok && Array.isArray(body) ? body : [];
};

export const createUser = (payload) =>
  call("/users", { method: "POST", body: JSON.stringify(payload) });

export const setUserActive = (username, active) =>
  call(`/users/${encodeURIComponent(username)}/active`, {
    method: "POST",
    body: JSON.stringify({ active }),
  });

export const unlockUser = (username) =>
  call(`/users/${encodeURIComponent(username)}/unlock`, { method: "POST" });

// For good, with the wallets the account created. The username is typed back
// as confirmation, and the server checks it too.
export const deleteUser = (username, confirm) =>
  call(`/users/${encodeURIComponent(username)}`, { method: "DELETE", body: JSON.stringify({ confirm }) });

export const listAllWallets = async () => {
  const { ok, body } = await call("/admin/wallets");
  return ok && Array.isArray(body) ? body : [];
};

// ---------------------------------------------------------------------------
// Expired session
// ---------------------------------------------------------------------------
// A session can fall while the app is open (expiry, a logout from another
// device, a restart). fetchAuth reports the 401 here, and App puts the login
// screen back without every single call having to handle it.
const listeners = new Set();

export const onSessionExpired = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const reportSessionExpired = () => {
  for (const fn of listeners) fn();
};

// ---------------------------------------------------------------------------
// Wallet no longer available
// ---------------------------------------------------------------------------
// The other way the ground can move while the app is open: the wallet was
// deleted, or somebody withdrew the membership. The session is still perfectly
// valid, so this is not a sign-out -- the answer is the picker, not the login
// screen.
const walletListeners = new Set();

export const onWalletLost = (fn) => {
  walletListeners.add(fn);
  return () => walletListeners.delete(fn);
};

export const reportWalletLost = () => {
  for (const fn of walletListeners) fn();
};
