# Price updates

[← README](../README.md)

Optional and **off by default**. When it is off, you type holding values in by hand and the refresh buttons are disabled.

## Turn it on

1. In `.env`:
   ```bash
   COMPOSE_PROFILES=quotes
   EULERPOOL_API_KEY=...      # ETFs and stocks: free key at eulerpool.com
   #TWELVEDATA_API_KEY=...    # optional 2nd source (twelvedata.com)
   #EODHD_API_KEY=...         # optional last source, finds ETCs (eodhd.com, 20 calls/day)
   #COINGECKO_API_KEY=...     # optional: crypto works without it, a free Demo key is steadier
   ```
   ETFs and stocks need at least one of the first three keys.
2. Run `docker compose up -d`. Within about 30 seconds, the refresh buttons come on.

## Use it

Press refresh on an investment account, or **Update prices** in the portfolio. Holdings with an ISIN or a crypto symbol get today's price **in the wallet's currency**. A holding with no price in that currency keeps its value.

## If it doesn't work

- `docker compose logs quotes` shows which sources are on and why a holding wasn't priced.
- Buttons still disabled? Check `docker compose ps`, and make sure `BUSSOLA_QUOTES_URL` is not set to an empty value.

## Turn it off

Remove `quotes` from `COMPOSE_PROFILES`, then run `docker compose up -d --remove-orphans`.

## More

[Sources, credits and your own price service](price-sources.md)
