// ----------------------------------------------------------------------------
// CoinGecko -- crypto, through its public, documented API
// (https://docs.coingecko.com/reference/simple-price).
//
// No key is needed. COINGECKO_API_KEY, when set, is a Demo-plan key and is
// sent as the x-cg-demo-api-key header, which buys a steadier rate limit.
// CoinGecko's terms ask for the attribution "Powered by CoinGecko", which the
// Bussola interface shows next to the refresh buttons.
//
// Expected input: a symbol like "BTC-EUR" (base-currency).
// ----------------------------------------------------------------------------
const { empty, fetchJson, baseFrom } = require("./shared");

const DEFAULT_BASE = "https://api.coingecko.com/api/v3/";

// Symbol -> CoinGecko id for the most common coins (extensible).
const COINGECKO_IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDC: "usd-coin",
  USDT: "tether",
  BNB: "binancecoin",
  SOL: "solana",
  XRP: "ripple",
  ADA: "cardano",
  DOGE: "dogecoin",
  DOT: "polkadot",
  MATIC: "matic-network",
  LTC: "litecoin",
  AVAX: "avalanche-2",
  LINK: "chainlink",
  TRX: "tron",
  BCH: "bitcoin-cash",
  XLM: "stellar",
  ATOM: "cosmos",
  UNI: "uniswap",
  DAI: "dai",
};

// `currency` is the unit the price is wanted in -- the wallet's. When it is
// given it wins over the symbol's suffix: "BTC-USD" in a euro wallet is still
// bitcoin, and its value has to be added up with euros.
const lookupCoinGecko = async (input, currency) => {
  const out = empty();
  if (!input) return out;

  const [basePart, vsPart] = String(input).toUpperCase().split("-");
  const id = COINGECKO_IDS[basePart];
  const vs = (currency || vsPart || "EUR").toLowerCase();
  if (!id) return out; // not a coin we know: no quote (and no log naming it)

  const url = new URL("simple/price", baseFrom("COINGECKO_BASE_URL", DEFAULT_BASE));
  url.searchParams.set("ids", id);
  url.searchParams.set("vs_currencies", vs);
  url.searchParams.set("include_24hr_change", "true");

  const key = String(process.env.COINGECKO_API_KEY || "").trim();
  const answer = await fetchJson(url.toString(), {
    label: "CoinGecko",
    headers: key ? { "x-cg-demo-api-key": key } : {},
  });
  if (!answer) return out;
  if (answer.status !== 200) {
    console.log(`[quotes] CoinGecko: HTTP ${answer.status}`);
    return out;
  }
  const row = answer.body && typeof answer.body === "object" ? answer.body[id] : null;
  const price = row ? Number(row[vs]) : NaN;
  if (!Number.isFinite(price) || price <= 0) return out;

  const change = row[`${vs}_24h_change`];
  return {
    ...out,
    price,
    change: change != null && Number.isFinite(Number(change)) ? Number(Number(change).toFixed(2)) : null,
    quoteCurrency: vs.toUpperCase(),
    symbol: `${basePart}-${vs.toUpperCase()}`,
    source: "coingecko",
  };
};

module.exports = { lookupCoinGecko, COINGECKO_IDS };
