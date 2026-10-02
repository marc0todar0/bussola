// Configuration read at runtime, not compiled into the bundle.
//
// In production the nginx entrypoint generates /config.json from the
// container's environment variables: the same image works on any installation
// with no frontend rebuild. In development config.json does not exist and the
// default applies.
//
// Since phase 1 there are no credentials here: authentication is a session on
// an httpOnly cookie, and the only thing the frontend needs to know is where
// the API lives.

let config = null;

const fallback = () => ({
  apiUrl: "/api",
});

// envsubst leaves the placeholder untouched when the variable is not set, so
// "${BUSSOLA_API_URL}" has to be treated as an absent value.
const resolved = (value, def) => (!value || /^\$\{.*\}$/.test(value) ? def : value);

export const loadConfig = async () => {
  if (config) return config;
  const def = fallback();
  // The demo has no API and no nginx to write config.json: nothing to ask.
  if (__DEMO__) {
    config = def;
    return config;
  }
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}config.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    config = { apiUrl: resolved(raw.apiUrl, def.apiUrl) };
  } catch {
    config = def;
  }
  return config;
};

export const getConfig = () => config || fallback();
