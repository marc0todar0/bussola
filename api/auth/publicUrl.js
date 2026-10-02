// ---------------------------------------------------------------------------
// BUSSOLA_PUBLIC_URL: the one address the instance is reached at
// ---------------------------------------------------------------------------
// Both passkeys (the WebAuthn relying party) and Web Push (whether it is on at
// all, and the VAPID subject) are enabled by this variable and by nothing
// derived from a request: Host and X-Forwarded-* are client-controlled.
// Unset means off. passkeys.js explains why it is never worked out from the
// request.
//
// Accepted: an https URL with a real hostname, or http://localhost[:port] --
// the one plain-http origin browsers treat as secure, which is what makes
// passkeys and push testable on a development machine. An IP address is
// refused: the WebAuthn rpID has to be a domain.
const LOCAL_HOSTS = new Set(["localhost"]);

const parseRelyingParty = (raw) => {
  const value = String(raw || "").trim();
  if (!value) return { rp: null, reason: null };

  let url;
  try {
    url = new URL(value);
  } catch {
    return { rp: null, reason: `BUSSOLA_PUBLIC_URL "${value}" is not a URL` };
  }

  const host = url.hostname;
  const isIp = /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[");
  if (isIp) {
    return { rp: null, reason: `BUSSOLA_PUBLIC_URL must name a domain, not an IP address ("${host}")` };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(host))) {
    return {
      rp: null,
      reason: `BUSSOLA_PUBLIC_URL must be https (only http://localhost is allowed over plain http)`,
    };
  }

  return { rp: { origin: url.origin, rpID: host, rpName: "Bussola" }, reason: null };
};

module.exports = { parseRelyingParty };
