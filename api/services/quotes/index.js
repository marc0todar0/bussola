// ============================================================================
// Quotes -- best-effort, from one HTTP service
// ============================================================================
// Every price comes from the service described in http.js, whose header is
// the whole contract: the optional `quotes` container (quotes/ in this
// repository) or any service of your own, at BUSSOLA_QUOTES_URL. Unset,
// or with nothing answering there, quotesEnabled() is false, the refresh endpoints refuse with
// QUOTES_DISABLED, and every holding's value is the one typed by hand.
//
// NOTHING here throws: on an error or an unavailable service the answer has
// null fields and the caller keeps the manual data (soft degradation).
//
// fetch is global (Node 18+). No extra dependency.
// ============================================================================
const { empty } = require("./shared");
const { lookupHttp, quotesEnabled, quoteSources, probeQuotes } = require("./http");

// ----------------------------------------------------------------------------
//   args: { isin, typeCode, currency }
//   - isin: an ISIN (ETF) or a crypto symbol such as "BTC-EUR"
//   - typeCode: the holding type's stable code (CRYPTO, ETF, ...), passed on
//     for the service to route on. It is the code and not the name because
//     the name is display text and follows the interface language.
//   - currency: the unit the price must be in. The holdings controller passes
//     the WALLET's currency, not the holding's: a holding's amount is added
//     up with the wallet's balances, so it has to be counted in the same unit
//     (the holding's own currency field describes the instrument, and stays
//     the user's). The service is asked in that unit and the result says
//     which one it came back in (quoteCurrency), so the caller can refuse a
//     mismatch instead of trusting it.
// ----------------------------------------------------------------------------
const lookupQuote = async ({ isin, typeCode, currency } = {}) => {
  if (!isin || !quotesEnabled()) return empty();
  return lookupHttp({ isin, typeCode, currency });
};

module.exports = { lookupQuote, quotesEnabled, quoteSources, probeQuotes };
