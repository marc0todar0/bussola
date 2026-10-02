// ============================================================================
// What the quote client needs besides the contract: the answer's shape, and a
// GET that never throws and never waits for ever.
// ============================================================================

const HEADERS = {
  "User-Agent": "Bussola",
  Accept: "application/json",
};

// The common return shape (every field null = no quote available).
const empty = () => ({
  price: null,
  change: null,
  quoteCurrency: null,
  symbol: null,
  typeHint: null,
  issuerHint: null,
  domicileHint: null,
  source: null,
});

// How long the service gets to answer. fetch has no timeout of its own
// (undici's defaults are minutes), and a stalled provider used to hold the
// request -- and before the refresh was split into phases, a database
// connection with it -- until nginx gave up at 120 s while Node carried on
// waiting. 15 s because the quotes container may ask up to two ETF providers
// in a row (plus OpenFIGI) for one ISIN, within a 12 s budget of its own.
const TIMEOUT_MS = 15000;

// Best-effort GET JSON: never throws. Returns { status, body } for any
// answer, an error status included, because an error's body may say why
// (CURRENCY_UNSUPPORTED); body is the parsed JSON, or null when it was not
// JSON. Returns null when there was no answer at all, a timeout included.
// Only the URL is logged, never the headers.
const fetchJson = async (url, extraHeaders = {}) => {
  try {
    const res = await fetch(url, {
      headers: { ...HEADERS, ...extraHeaders },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) console.log(`[quotes] HTTP ${res.status} from ${url}`);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (e) {
    console.log(`[quotes] fetch failed for ${url}:`, e.message);
    return null;
  }
};

module.exports = { empty, fetchJson, TIMEOUT_MS };
