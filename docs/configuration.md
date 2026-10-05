# Configuration

[← README](../README.md)

Everything is set in `.env`. Apply changes with `docker compose up -d`.

## Basics

| Variable | Default | What it does |
|---|---|---|
| `BUSSOLA_AUTH_USER` | `bussola` | First account's username (first boot only) |
| `BUSSOLA_AUTH_PASS` | **required** | First account's password, 6+ characters (first boot only) |
| `PGPASSWORD` | **required** | Database password. **Fixed after first boot** |
| `PGUSER` / `PGDATABASE` | `bussola` | Database user / name. **Fixed after first boot** |
| `BUSSOLA_DEFAULT_LOCALE` | `en` | First account's language: `en` `it` `fr` `de` `es` `zh` |
| `BUSSOLA_PORT` | `3000` | Host port |
| `BUSSOLA_VERSION` | release's | Pin the images, e.g. `0.2.0` |
| `BUSSOLA_SIGNUP` | `closed` | `open` lets anyone create an account |
| `SNAPSHOT_CRON` | `0 3 1 * *` | Monthly portfolio snapshot (cron), `off` to disable |
| `BUSSOLA_SESSION_DAYS` | `30` | Days you stay signed in without using Bussola |

## HTTPS

| Variable | Default | What it does |
|---|---|---|
| `BUSSOLA_PUBLIC_URL` | — | Public HTTPS address. Turns on passkeys and phone notifications |
| `BUSSOLA_COOKIE_SECURE` | off | `true` only over HTTPS |
| `BUSSOLA_TRUSTED_PROXIES` | `1` | `2` behind your own reverse proxy, `0` with no nginx in front |
| `CORS_ORIGINS` | — | Extra allowed origins (not needed normally) |

## Price updates — [guide](price-updates.md)

| Variable | Default | What it does |
|---|---|---|
| `COMPOSE_PROFILES` | — | `quotes` starts the price container |
| `EULERPOOL_API_KEY` | — | ETFs and stocks, asked 1st |
| `TWELVEDATA_API_KEY` | — | ETFs and stocks, asked 2nd |
| `EODHD_API_KEY` | — | ETFs, ETCs and stocks, asked last |
| `COINGECKO_API_KEY` | — | Optional, crypto |
| `OPENFIGI_API_KEY` | — | Optional, raises Twelve Data's ISIN lookup limit |
| `QUOTES_STOCK_ORDER` | `eulerpool,twelvedata,eodhd` | Order of the stock sources |
| `BUSSOLA_QUOTES_URL` | `http://quotes:8080` | Your own price service. Set it empty to turn prices off |

## Bank notifications — [guide](notifications.md)

| Variable | Default | What it does |
|---|---|---|
| `BUSSOLA_AI_URL` | — | OpenAI-compatible base URL, e.g. `http://192.168.1.20:11434/v1`. A host outside your network receives each notification's text: [read first](reading-model.md#hosted-model-what-leaves-your-machine) |
| `BUSSOLA_AI_MODEL` | — | Model name, e.g. `qwen3.5:4b` |
| `BUSSOLA_AI_API_KEY` | — | Only if the endpoint needs one |
| `BUSSOLA_NOTIFY_DETAILS` | off | `on` puts the amount and merchant in phone notifications |
| `BUSSOLA_PUSH_ALLOWED_HOSTS` | — | Extra push-service hosts (rarely needed) |

## Rarely needed

| Variable | Default | What it does |
|---|---|---|
| `BUSSOLA_LOCKOUT_SECONDS` | `900` | First lock after 5 wrong passwords (it doubles, up to a day) |
| `DB_LOG` | off | `on` logs every SQL statement. Otherwise only slow ones (`DB_SLOW_MS`, 500) |
| `BUSSOLA_DB_APP_PASSWORD` | generated | Set it only with several API replicas |

Development only: `PGHOST`, `PGPORT`, `PORT`, `VITE_API_PROXY_TARGET` (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
