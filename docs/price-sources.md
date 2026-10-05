# Price sources

[← Price updates](price-updates.md)

The `quotes` container uses only official APIs. It publishes no port and asks providers only when you press refresh. Prices are cached for 15 minutes.

| Source | For | Key | Notes |
|---|---|---|---|
| [CoinGecko](https://www.coingecko.com/en/api) | crypto | optional Demo key | The keyless API is sometimes refused (403). The "Powered by CoinGecko" credit is required. |
| [Eulerpool](https://eulerpool.com/developers) | ETFs, stocks | `EULERPOOL_API_KEY` | Asked 1st. ETFs at the last daily close (a day or two behind). Shows "Data by Eulerpool". |
| [Twelve Data](https://twelvedata.com) | ETFs, stocks | `TWELVEDATA_API_KEY` | Asked 2nd. 800 credits/day, few markets. Finds tickers via [OpenFIGI](https://www.openfigi.com/api) (optional `OPENFIGI_API_KEY`). |
| [EODHD](https://eodhd.com/financial-apis) | ETFs, ETCs, stocks | `EODHD_API_KEY` | Asked last. 20 calls/day, listings cached 24 h. Private, non-commercial use only. |

- `QUOTES_STOCK_ORDER=twelvedata,eulerpool` changes the order (EODHD stays last unless you list it).
- Bussola uses the listing in the wallet's currency, Xetra first. A price in another currency, an error or a timeout (15 s) is ignored.
- **Settings → About and credits** lists the sources active on your instance.
- If you offer your instance to other people, check each provider's terms again.

## Your own price service

Leave `quotes` out of `COMPOSE_PROFILES` and set `BUSSOLA_QUOTES_URL` to your service. Bussola calls `<url>/v1/quote` with the ISIN or symbol, the holding type and the currency. The contract is documented at the top of [`api/services/quotes/http.js`](../api/services/quotes/http.js).
