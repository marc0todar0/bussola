import { getConfig } from "./runtimeConfig";
import { reportSessionExpired, reportWalletLost } from "./session";

// There are no credentials left to attach: identity travels in the session
// cookie, which the browser sends by itself thanks to credentials: "include".
// Credentials no longer reach the browser in any form.
//
// The signature has not changed: the thirty places in the app that call
// fetchAuth are exactly as they were.
const fetchAuth = async (api, options) => {
  const { apiUrl } = getConfig();
  const url = `${apiUrl}${api}`;

  const httpOpt = { ...(options || {}) };
  httpOpt.headers = { ...(httpOpt.headers || {}) };
  httpOpt.credentials = "include";

  // The demo build answers from an in-browser copy of the API (src/demo/);
  // __DEMO__ is a build-time constant, so in the real build this branch and
  // the demo code behind it are not in the bundle at all.
  const response = __DEMO__
    ? await (await import("../demo/browser.js")).handle(api, httpOpt)
    : await fetch(url, httpOpt);

  // The session fell while the app was open: tell whoever needs to know and
  // let the caller handle the response exactly as it always has.
  if (response.status === 401) reportSessionExpired();

  // The wallet went away instead -- deleted, or the membership withdrawn. The
  // session is still good, so this sends the app back to the picker rather
  // than to the login screen. Read from a clone: the caller still has to be
  // able to read the body itself.
  if (response.status === 409) {
    try {
      const body = await response.clone().json();
      if (body && body.code === "NO_WALLET_SELECTED") reportWalletLost();
    } catch {
      /* not the JSON we were looking for: leave it to the caller */
    }
  }

  return response;
};

export default fetchAuth;
