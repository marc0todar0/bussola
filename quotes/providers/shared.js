// ============================================================================
// What every provider shares: the answer's shape, the ISIN test, a request
// that never throws and never waits for ever, and the log helpers.
// ============================================================================

const HEADERS = {
  "User-Agent": "bussola-quotes",
  Accept: "application/json",
};

// The common return shape (every field null = no quote available).
// `unsupportedCurrency` is set instead when the source is fine but cannot
// price the instrument in the unit asked.
const empty = () => ({
  price: null,
  change: null,
  quoteCurrency: null,
  symbol: null,
  source: null,
});

// Something that "looks like an ISIN" (2 letters + 9 alphanumerics + 1 digit).
const isIsin = (s) => /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(String(s || "").toUpperCase());

// How long one upstream request may take. fetch has no timeout of its own
// (undici's defaults are minutes). An ETF may cost up to six requests in a
// row (OpenFIGI, Twelve Data's search and quote, Eulerpool's two endpoints),
// so a lookup also has an overall budget, CHAIN_BUDGET_MS, which every
// request's timeout is cut down to: Bussola gives up on this service at 15 s.
const TIMEOUT_MS = 5000;
const CHAIN_BUDGET_MS = 12000;

// A base address from the environment, with a trailing slash so that
// new URL(path, base) appends to its path instead of replacing the last
// segment. The *_BASE_URL variables exist for the tests only.
const baseFrom = (name, fallback) => {
  const base = String(process.env[name] || "").trim() || fallback;
  return base.endsWith("/") ? base : `${base}/`;
};

// Best-effort JSON request: never throws. { status, body } for any answer
// (body null when it was not JSON), null when there was no answer at all, a
// timeout included.
//
// Nothing about the request is logged: its URL names the instrument (which
// ETFs somebody holds is their business) and may carry a key. `label` says
// which source it was. `deadline` (a Date.now() value) cuts the timeout down
// to what is left of the lookup's budget; with nothing left there is no
// request, and the answer is null as for a timeout. `method` and `body` are
// for OpenFIGI's POST; a body is sent as JSON.
const fetchJson = async (url, { label = "upstream", headers = {}, deadline = null, method = "GET", body } = {}) => {
  const left = deadline == null ? TIMEOUT_MS : Math.min(TIMEOUT_MS, deadline - Date.now());
  if (left < 200) {
    console.log(`[quotes] ${label}: skipped, the lookup's time budget is spent`);
    return null;
  }
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...HEADERS,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(left),
    });
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  } catch (e) {
    console.log(`[quotes] ${label}: no answer (${e.name === "TimeoutError" ? "timeout" : "network error"})`);
    return null;
  }
};

// Logged once per key and process, not per request: a refused key would
// otherwise fill the log with the same line.
const said = new Set();
const sayOnce = (key, line) => {
  if (said.has(key)) return;
  said.add(key);
  console.log(line);
};
const forgetSaid = () => said.clear();

// DEBUG_QUOTES=1: the shape of an upstream answer, to check the parsing
// against a real key -- the top-level key names, and each array's length and
// its first element's key names. Never a value: an answer names the
// instrument and its price. A key that is itself an ISIN (an answer keyed by
// the instrument) is written as <ISIN>.
const keyName = (k) => (isIsin(k) ? "<ISIN>" : String(k).slice(0, 40));
const describe = (v) => {
  if (Array.isArray(v)) {
    const first = v[0] && typeof v[0] === "object" && !Array.isArray(v[0]) ? ` of {${Object.keys(v[0]).map(keyName).join(",")}}` : "";
    return `array(${v.length})${first}`;
  }
  if (v && typeof v === "object") return `{${Object.keys(v).map(keyName).join(",")}}`;
  return v === null ? "null" : typeof v;
};
const debugShape = (label, answer) => {
  if (process.env.DEBUG_QUOTES !== "1" || !answer) return;
  const body = answer.body;
  const shape =
    body && typeof body === "object" && !Array.isArray(body)
      ? `{ ${Object.entries(body).map(([k, v]) => `${keyName(k)}: ${describe(v)}`).join("; ")} }`
      : describe(body);
  console.log(`[quotes] DEBUG ${label}: HTTP ${answer.status} ${shape}`);
};

module.exports = { empty, isIsin, fetchJson, baseFrom, sayOnce, forgetSaid, debugShape, TIMEOUT_MS, CHAIN_BUDGET_MS };
