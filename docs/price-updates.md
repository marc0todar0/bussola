# Price updates

Bussola can fetch today's price of your crypto, ETFs and stocks, so the
portfolio's values follow the market. It is **optional and off by default**:
without it everything works, with the value of each holding typed by hand, and
the refresh buttons are disabled.

It comes from a small extra container, `quotes`, that ships with Bussola. It
sits on the internal network (no published port), needs no account of ours, and
asks the price providers **only when you press refresh**.

## Turn it on

1. In `.env` (the file next to your `docker-compose.yml`), add:

   ```bash
   COMPOSE_PROFILES=quotes
   ```

2. For **ETFs and stocks**, add a free key of your own from at least one of
   the first three providers below. Crypto comes from CoinGecko and needs no
   key, though one is worth having:

   | Provider | Variable | Where to get the key | Free plan |
   |---|---|---|---|
   | [Eulerpool](https://eulerpool.com/developers) | `EULERPOOL_API_KEY` | free account | ETFs at their last daily close, stocks live; asked first |
   | [Twelve Data](https://twelvedata.com) | `TWELVEDATA_API_KEY` | free account | 800 credits a day, a few markets; asked second |
   | [EODHD](https://eodhd.com/financial-apis) | `EODHD_API_KEY` | free account | 20 calls a day; asked last, finds ETCs on Xetra |
   | [CoinGecko](https://www.coingecko.com/en/api) | `COINGECKO_API_KEY` | free Demo key, **optional** | crypto; works without a key, but the keyless API is sometimes refused (HTTP 403) from some networks and rate-limits more: a Demo key fixes both |

3. Apply it:

   ```bash
   docker compose up -d
   ```

   The `quotes` container starts and, within half a minute, the refresh buttons
   on the accounts and the portfolio come on. Nothing to restart, nothing else to
   set.

## Use it

Open an investment account and press the refresh button (or **Update prices** in
the portfolio). Each holding with an ISIN or a crypto symbol gets today's price,
asked **in your wallet's currency**; a price in any other currency is never
applied, and a holding with no quote keeps the value it had.

## Check it

- `docker compose logs quotes` says at startup which price sources are on.
- A holding that does not update: the log line says why (no key, the provider
  does not list the ISIN in your currency, a quota used up).
- The buttons stay disabled: the container is not running (`docker compose ps`),
  or `BUSSOLA_QUOTES_URL` in `.env` is set to an empty value, which switches it
  off for good.

## Turn it off

Remove `COMPOSE_PROFILES=quotes` (keep the other profiles you use, if any) and
run `docker compose up -d --remove-orphans`.

The sources, their terms and credits, caching, and pointing Bussola at a price
service of your own are in [Configuration](configuration.md#price-updates).
