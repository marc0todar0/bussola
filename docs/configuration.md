# Configuration

Every setting Bussola reads from `.env`, with its default. Back to the [README](../README.md).

Everything is configured in `.env`; [`example.env`](../example.env) holds the
variables most installations touch, and this page lists them all. After changing
a value, run `docker compose up -d` to apply it.

The frontend image contains no URL and no credentials. It reads `/config.json`,
which is generated from the container's environment each time it starts, so the
same image works for any installation without a rebuild.

## All variables

| Variable | Default | What it does |
|---|---|---|
| `BUSSOLA_AUTH_USER` | `bussola` | Username of the first account. Used only on the first boot |
| `BUSSOLA_AUTH_PASS` | *(empty, required)* | Password of the first account, at least 6 characters. Used only on the first boot |
| `BUSSOLA_DEFAULT_LOCALE` | `en` | Interface language of the first account: `en`, `it`, `fr`, `de`, `es`, `zh`. Its starter accounts and categories are written in this language |
| `BUSSOLA_SIGNUP` | `closed` | `open` lets anyone who can reach the login screen create an account (see [Adding people](using.md#adding-people)) |
| `PGUSER` | `bussola` | Database user. **Fixed when the database is first created** |
| `PGPASSWORD` | *(empty, required)* | Database password. **Fixed when the database is first created** |
| `PGDATABASE` | `bussola` | Database name. **Fixed when the database is first created** |
| `BUSSOLA_PORT` | `3000` | Host port the app is published on |
| `BUSSOLA_VERSION` | `latest` | Which released images `docker compose pull` fetches, e.g. `0.2.0`. See [Upgrading](operations.md#upgrading) |
| `SNAPSHOT_CRON` | `0 3 1 * *` | When the monthly portfolio snapshot runs (5-field cron format). `off` disables it |
| `COMPOSE_PROFILES` | *(unset)* | `quotes` starts the optional quotes container, which updates crypto, ETF and stock prices; the refresh buttons come on by themselves. See [Price updates](price-updates.md) |
| `BUSSOLA_QUOTES_URL` | `http://quotes:8080` | Base address of the quotes service the API asks: the bundled container, or a service of your own implementing the same contract. Almost nobody sets it. If nothing answers there, price updates are off; an empty value switches them off for good |
| `TWELVEDATA_API_KEY` | *(none)* | Your free key for [Twelve Data](https://twelvedata.com)'s API, the second source of ETF and stock prices (its free plan covers only a few markets). Read by the quotes container |
| `EULERPOOL_API_KEY` | *(none)* | Your free key for [Eulerpool](https://eulerpool.com/developers)'s API, the first source of ETF and stock prices. With none of the three keys, ETF and stock prices are off. Read by the quotes container |
| `EODHD_API_KEY` | *(none)* | Your free key for [EODHD](https://eodhd.com/financial-apis)'s API, the last source of ETF, ETC and stock prices (its free plan allows 20 calls a day). Read by the quotes container |
| `OPENFIGI_API_KEY` | *(none)* | Optional [OpenFIGI](https://www.openfigi.com/api) key: Twelve Data finds an ISIN's tickers through OpenFIGI, which allows 25 requests a minute without one. Read by the quotes container |
| `COINGECKO_API_KEY` | *(none)* | Optional CoinGecko Demo key, for a steadier rate limit on crypto prices. Read by the quotes container |
| `BUSSOLA_AI_URL` | *(none: no reading model)* | Base address of an OpenAI-compatible API that reads the bank notifications: `http://192.168.1.20:11434/v1` for an Ollama of yours, `https://api.groq.com/openai/v1` for a hosted one. Needs `BUSSOLA_AI_MODEL` too. If the host is not on your own network, **the text of each notification leaves it**: read [Choosing where the model runs](notifications.md#choosing-where-the-model-runs) first |
| `BUSSOLA_AI_MODEL` | *(none)* | The model's name at that endpoint, e.g. `qwen3.5:4b` for Ollama. No default: without it notifications are not read |
| `BUSSOLA_AI_API_KEY` | *(none)* | The endpoint's key, sent as a Bearer token; never logged or returned. Leave it out for a server that needs none |
| `BUSSOLA_NOTIFY_DETAILS` | *(off)* | `on` adds the draft's amount and merchant to the notification on the phone. Off, it only says something is waiting. See [Getting a notification on your phone](notifications.md#getting-a-notification-on-your-phone) |
| `BUSSOLA_PUSH_ALLOWED_HOSTS` | *(none)* | Extra push-service hostnames, comma-separated (`push.example.org`, `*.push.example.net`), added to the built-in list of Google's, Mozilla's, Apple's and Microsoft's. Almost nobody needs it; IP addresses are never accepted |
| `BUSSOLA_SESSION_DAYS` | `30` | How long you stay signed in, in days |
| `BUSSOLA_COOKIE_SECURE` | *(off)* | `true` marks the session cookie `secure`. Set it **only** when serving over HTTPS |
| `BUSSOLA_PUBLIC_URL` | *(none: passkeys and phone notifications off)* | The HTTPS address Bussola is served from, e.g. `https://bussola.example.com`. Setting it enables passkeys (sign-in with fingerprint, face or screen lock) and Web Push notifications on the phone, and nothing else is needed for either. See [Behind HTTPS](install.md#behind-https--a-reverse-proxy) |
| `CORS_ORIGINS` | *(none)* | Extra origins allowed to call the API, comma-separated. Not needed in the standard setup |
| `BUSSOLA_TRUSTED_PROXIES` | `1` | How many proxies sit in front of the API and are trusted to report the client's address: `1` is Bussola's own nginx, `2` when another reverse proxy (Caddy, Traefik…) is in front of it, `0` if the API is reached directly |
| `BUSSOLA_LOCKOUT_SECONDS` | `900` | Length of the first lock after five wrong passwords; each further lock in a row doubles it, up to a day |
| `DB_LOG` | *(off)* | `on` writes every SQL statement to the API log, for development. Off, only statements slower than half a second are logged (`DB_SLOW_MS` changes the threshold) |
| `BUSSOLA_DB_APP_PASSWORD` | *(generated)* | Password of the internal `bussola_app` database role. Normally generated at every boot and kept in memory. Set it only if you run several API replicas |
| `COMPOSE_FILE` | *(unset)* | `docker-compose.yml:docker-compose.db.yml` publishes Postgres on the server's `127.0.0.1`, for a database client (see [Connecting a database client](install.md#connecting-a-database-client)) |
| `BUSSOLA_DB_PORT` | `5432` | Loopback port Postgres is published on when the line above is set |
| `QUOTES_STOCK_ORDER` | `eulerpool,twelvedata,eodhd` | The order the quotes container asks the ETF and stock sources in |

Development only, with `yarn dev` ([CONTRIBUTING.md](../CONTRIBUTING.md)):
`PGHOST`/`PGPORT` (the Postgres the local API connects to), `PORT` (the local
API's port, `3001`) and `VITE_API_PROXY_TARGET` (where Vite forwards `/api`,
`http://localhost:3001`).

## Price updates

Prices come from an **optional quotes container** that ships with Bussola
(`quotes/` in the repository, image `bussola-quotes`). It is off until you add
`COMPOSE_PROFILES=quotes` to `.env`; then it runs next to the API on the
internal Docker network, publishes no port, needs no account or key of ours and
asks the price providers only when you press refresh. The API notices by itself
that it is there and the refresh buttons come on, so there is nothing else to
set. Crypto works as it is; for ETFs and stocks add your own free keys (below).
Without it every value is entered by hand and everything else in Bussola works
the same. The step-by-step version is [Price updates](price-updates.md).

It uses only official, documented APIs:

- **Crypto** from [CoinGecko](https://www.coingecko.com)'s public API. Nothing
  to configure; an optional free Demo key in `COINGECKO_API_KEY` gives a
  steadier rate limit. The interface shows "Powered by CoinGecko", as its
  terms ask (section 4.3, on every plan), and **Settings → About and credits**
  lists every source Bussola uses, with the ones active on your installation.
- **ETFs and stocks, by ISIN** from three sources, each with a free key of your
  own; set any of them:
  1. [Eulerpool](https://eulerpool.com/developers) (`EULERPOOL_API_KEY`, a
     free account). Stocks: the live price on an exchange that trades in the
     wallet's currency. ETFs: the last daily close on such an exchange (Xetra
     first for euros), so a day or two behind.
  2. [Twelve Data](https://twelvedata.com) (`TWELVEDATA_API_KEY`; the free
     Basic plan gives 800 credits a day, 8 a minute, on only a few markets),
     asked whenever the first has no key, does not find the instrument, has no
     price in the wallet's currency, has used up its quota or fails. Its free
     plan cannot look an ISIN up, so the ISIN's tickers come from
     [OpenFIGI](https://www.openfigi.com/api) first (no key needed; an
     optional free one in `OPENFIGI_API_KEY` raises its limit of 25 requests
     a minute).
  3. [EODHD](https://eodhd.com/financial-apis) (`EODHD_API_KEY`; the free
     plan allows 20 calls a day), asked last, when the two before have no
     price in the wallet's currency. It finds an ISIN's listings itself and
     prices the one on Xetra (else Frankfurt, else any in the wallet's
     currency) with a delayed quote. The listing found, or that there is none,
     is remembered for 24 hours so the small quota goes on prices, not on
     searches. It covers products the others miss, such as ETCs on Xetra.

  **Credits.** Eulerpool's free plan asks for attribution ("Data by Eulerpool")
  in any public-facing product, so when `EULERPOOL_API_KEY` is set the
  interface adds that line, linked to eulerpool.com, beside CoinGecko's.
  Twelve Data, EODHD and OpenFIGI ask for none on these plans (Twelve Data's
  only attribution wording is for its paid redistribution add-on). EODHD's
  terms limit its data to private, non-commercial use by you, which is how
  Bussola uses it: your own key, your own portfolio. Check each provider's
  terms again if you offer your instance to other people.

  `QUOTES_STOCK_ORDER=twelvedata,eulerpool` asks the first two the other way
  round (EODHD stays last unless you name it).

  With no key, ETFs and stocks keep the value typed by hand (the
  container says which sources are on in its log at startup). The listing used
  is the one traded in the wallet's currency, preferably on Xetra.

Prices are cached for 15 minutes, shared by every wallet on the instance.

`BUSSOLA_QUOTES_URL` can also point at a service of your own (leave `COMPOSE_PROFILES` without `quotes`, so the bundled container is not started). Bussola asks
`<address>/v1/quote` with the holding's ISIN or symbol, its type and the
wallet's currency, and the service answers with a price in that currency. The
contract is documented at the top of
[`api/services/quotes/http.js`](../api/services/quotes/http.js).

Prices are asked in the **wallet's** currency, so they add up with everything
else in it. A price in any other currency, an error or a timeout (15 seconds)
counts as "no quote": the holding keeps the value it had.

## Reading bank notifications

Notifications your phone sends to the inbox ([Transactions from bank
notifications](notifications.md)) are read by a **language model that Bussola
asks over the OpenAI-compatible API**. Bussola ships no model and downloads
none: you name an endpoint. In `.env`:

```bash
BUSSOLA_AI_URL=http://192.168.1.20:11434/v1
BUSSOLA_AI_MODEL=qwen3.5:4b
#BUSSOLA_AI_API_KEY=
```

then `docker compose up -d`. The API log says, at start, which model and which
host read the notifications, and whether that host is outside your own network.
Both URL and model are needed; with either missing nothing is read.

- **Your own model.** Ollama, llama.cpp's `llama-server`, LM Studio, vLLM… on
  this machine or another one of your network: use its `/v1` address. With
  Ollama, pull the model yourself first (`ollama pull qwen3.5:4b`). From inside
  the compose network, a service on the host is reached at
  `http://host.docker.internal:11434/v1`, or at its LAN address. The text then
  never leaves your network.
- **Memory and speed** (a local model). `qwen3.5:4b` is about 3.4 GB and needs
  4 to 5 GB of free RAM; `qwen3.5:2b` is lighter and a little less accurate. On
  the CPU it reads a notification in 10 to 15 seconds on a desktop processor,
  several times that on a Raspberry Pi or a NAS. Your phone does not wait:
  Bussola answers at once and reads in the background. A model that "thinks"
  before answering is slower still; a non-thinking one is best.
- **A hosted model.** Any provider with an OpenAI-compatible API. It sends each
  notification's text and your account and category names to the provider, so
  the privacy trade-off is spelled out in [Choosing where the model
  runs](notifications.md#choosing-where-the-model-runs).
- **Privacy in the logs.** The notification's text never appears in them.
- **What it does with a notification.** It first decides whether it is a
  movement of money: offers, tips, codes, statements and alerts are dropped and
  never become drafts; a doubtful one stays a draft. **With no reading model
  configured, a notification that is only text is refused** (`409
  AI_DISABLED`) and nothing is kept; a sender that posts a ready-made draft is
  taken as it is. A reading that fails (the model is down, a quota is spent)
  leaves the item in the inbox, as it came, for you to fill in.

How well each model reads, measured on 40 real-world notifications, and how to
measure it again: [`tools/ai-eval/`](../tools/ai-eval/).
