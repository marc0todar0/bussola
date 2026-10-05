# Changelog

All notable changes to Bussola are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Database changes are migrations in `api/migrations/`, applied in order when the
API starts; an entry that touches the schema names its migration.

## [Unreleased]

### Added

- **A notification the model could not read is tried again.** A quota used up
  (`429`), a server error, a timeout or a model server that is down no longer
  leaves the item for the hand at once: it is read again after 1 min, 5 min,
  30 min and 2 h (five readings in all; a longer `Retry-After` is obeyed, up to
  two hours), and only the last failure is announced on your phone. A refused
  key, a missing model or a nonsense answer still fail at once. The schedule is
  kept in the database (migration `007_inbox_retry`), so a restart loses
  nothing; `GET /api/inbox` gives each item's `attempts` and `next_attempt_at`.
- **A phone can send the same notification twice safely.** `POST /api/inbox`
  takes an optional `notification_id` (JSON body, `?notification_id=` or an
  `X-Bussola-Notification-Id` header; 1 to 100 characters): a second POST with an id
  the wallet has already seen stores nothing and answers `200` with the first
  item's receipt and `"duplicate": true`. An invalid id is `400
  INVALID_NOTIFICATION_ID`.

### Changed

- **A session is extended as you use it.** `BUSSOLA_SESSION_DAYS` (30) now
  counts from your last visit rather than from the sign-in, so somebody who
  opens Bussola at least once a month stays signed in, and so do their phone
  notifications.
- **Phone notifications come back by themselves** when the person who turned
  them on signs in again on that browser; nobody else signing in there gets
  them.

## [0.2.1] - 2026-10-02

### Changed

- **The quotes container is optional again, and off by default.** Release 0.2.0
  started it always; a fresh install has no price-provider key, so it did nothing
  useful. Now `COMPOSE_PROFILES=quotes` in `.env` is the one line that turns price
  updates on: the API looks at `http://quotes:8080` itself and the refresh buttons
  come on within half a minute, with no `BUSSOLA_QUOTES_URL`. **Upgrading from
  0.2.0 with price updates in use:** add `COMPOSE_PROFILES=quotes` to `.env`.
  New guide: `docs/price-updates.md`.
- **Notifications belong to the session that turned them on** (migration
  `006_push_session`). Signing out, a session expiring or a password change now
  stops them on that browser. **Upgrading:** existing subscriptions are removed;
  turn notifications on again from the Profile.
- Changing a category between expense and income is refused once it has
  transactions (`CATEGORY_IN_USE`).
- One-click **Accept** in the inbox is refused for a draft in another currency
  than the wallet's (`INBOX_CURRENCY_MISMATCH`); Review it instead.
- A snapshot's year and month are validated (`INVALID_SNAPSHOT_PERIOD`); a year
  or month of 0 no longer means "current".

### Fixed

- Choosing Transfer in a wallet with a single account broke the form; Transfer
  is now unavailable until there are two accounts. Default accounts no longer
  fall back to fixed ids.
- A double tap on GO or Enter could save a transaction twice.
- Changing the password sent the user to the wallet picker.
- Restoring an archive into a new wallet ignored the opening balance of an
  account whose name matched the starter account; an unused account now takes
  the archive's opening balance, and the preview says so.
- Account and category endpoints answer 404 for a row of the other kind
  instead of changing it, and ids that do not exist answer 404/400 instead of
  500.
- A crash in a page, or a missing bundle after an upgrade, showed a blank
  screen; there is now an error screen with Reload, and `index.html` is served
  with `Cache-Control: no-cache`. An unreachable server at start shows a retry
  screen instead of an endless spinner.
- Error messages without a translation showed their raw key.
- Cancelling the delete confirmation closed the transaction form; a partial
  holdings save closed the account form and lost the unsaved rows.
- Prices: an Eulerpool quote with a zero bid or ask was halved; Twelve Data
  listings priced in pence (GBp, GBX…) are skipped.

## [0.2.0] - 2026-10-01

### Changed

- **No model and no profiles inside Bussola any more.** The optional `ai`
  container (Ollama), its `ai-models` volume, the model download at start, the
  native Ollama client and `BUSSOLA_AI_PROVIDER` are gone. Bank notifications
  are read through any OpenAI-compatible endpoint: set `BUSSOLA_AI_URL` and
  `BUSSOLA_AI_MODEL` (and `BUSSOLA_AI_API_KEY` if it wants one). An Ollama you
  run yourself works at `http://host:11434/v1`. The About page now says whether
  the endpoint is on your own network (the text stays there) or not. **Upgrading
  from `COMPOSE_PROFILES=ai`:** run Ollama yourself, point `BUSSOLA_AI_URL` at
  its `/v1` address, set `BUSSOLA_AI_MODEL`, and remove the profile and the
  old `bussola-ai` container and volume.
- **The quotes container always runs.** `COMPOSE_PROFILES=quotes` and
  `BUSSOLA_QUOTES_URL=http://quotes:8080` are no longer needed: the compose file
  starts it and sets the address. It contacts the price providers only when you
  press refresh. `BUSSOLA_QUOTES_URL=` (empty) turns price updates off.

### Added

- **Notifications on the phone, with no other app.** Bussola is now an
  installable web app (PWA), and when a draft reaches the inbox it sends a Web
  Push notification to the devices of everyone who can confirm it in that
  wallet, in each person's language. Install Bussola on the phone (Android:
  Install app; iPhone: Add to Home Screen, iOS 16.4+), turn notifications on in
  Profile, and a message appears; tapping it opens Transactions. Needs
  `BUSSOLA_PUBLIC_URL` (HTTPS), nothing else. The message only says something is
  waiting (amount and merchant only with `BUSSOLA_NOTIFY_DETAILS=on`); a burst
  becomes one summary per minute; dropped notifications send nothing.
  Subscriptions are accepted only for the real push services' hosts
  (`BUSSOLA_PUSH_ALLOWED_HOSTS` adds one). The service worker caches nothing.
  Migration `005_push.sql` adds `push_subscriptions` and `server_secrets`.
- **An "About and credits" entry in the settings menu.** It credits every data
  source and service Bussola uses (CoinGecko, Eulerpool, Twelve Data, EODHD,
  OpenFIGI), shows which are active on this installation, says whether bank
  notifications are read by a local or a cloud model, and gives the license and
  links to the source and the docs. `/api/auth/me` now returns `aiCloud`, and
  the quotes service's `/v1/sources` lists `openfigi` when Twelve Data is on.
- **Accept in the inbox.** A new "Accept" button next to "Review" records a
  complete draft straight away, without opening the form. It is disabled, with
  a tooltip, while the draft lacks an amount, type, account, category or date.
- **A notification can be sent as plain text** (`Content-Type: text/plain`, the
  app's name in `?source=`): automation apps that paste the text into a JSON
  string broke on quotation marks and line breaks in a bank's message, and the
  notification was lost with a 400. The Android guide now uses it.
- **Notifications that are not movements are dropped.** The reading model first
  decides whether a notification is a transaction; offers, features, tips,
  codes, statements and price alerts are dismissed as soon as they are read,
  with their text cleared, and never become a draft. Doubtful ones stay
  drafts. **Without a reading model, a notification that is only text is no
  longer kept**: `POST /api/inbox` answers `409 AI_DISABLED`; a sender that
  posts a ready draft is unaffected, and text waiting for a model that was
  turned off is dropped at the next start.
- **Inbox: optional cloud model.** For machines too small for the local model,
  `BUSSOLA_AI_PROVIDER=openai` with `BUSSOLA_AI_URL`, `BUSSOLA_AI_API_KEY` and
  `BUSSOLA_AI_MODEL` reads notifications through any OpenAI-compatible endpoint
  (JSON-schema output, same prompt and validation). Off by default; the local
  model stays the default; the `ai` container is not needed. The notification's
  text and your account and category names are sent to the provider, so the
  guide spells out what leaves your machine and the data terms of the free
  tiers.
- **Credits for the price sources that ask for one.** The quotes container
  reports which sources are on (`GET /v1/sources`, `quoteSources` on `/me`);
  "Data by Eulerpool" is shown next to "Powered by CoinGecko" when an Eulerpool
  key is set, as its free plan requires.
- **ETC is a holding type** (exchange traded commodities, such as a physical
  gold fund). Prices of an ETC update on their own like an ETF's, which a type
  typed by hand never did. Holdings that carry a type somebody typed as "ETC"
  move to it. Migration `004_etc_holding_type.sql`.
- **Transactions from bank notifications.** A personal API token (Profile →
  Tokens for apps and automations; made with the password again, shown once)
  lets an iPhone Shortcuts automation or an Android automation app post a
  bank notification to `POST /api/inbox`. It becomes a draft; a "N to
  confirm" button on the Transactions page opens them, and nothing is
  recorded until the person
  reviews and saves one in the ordinary form. A token opens only the two inbox
  endpoints, and stops working as soon as its owner can no longer write to the
  wallet. See [docs/notifications.md](docs/notifications.md). Migration
  `002_inbox.sql` adds the `api_tokens` and `inbox_items` tables.
- **A local model reads the notifications** (optional container `ai`, Ollama,
  profile `ai`): one model with structured output fills the whole draft --
  amount, currency, day, merchant, type, account, category and, for a
  transfer, the other account -- choosing only among the wallet's own names,
  with the wallet's history for similar payments as context. No rules per bank
  or language. It reads in the background (the phone gets its answer at once;
  the inbox says "Reading…"), the API downloads the model on first start, and
  nothing leaves the machine. On with `COMPOSE_PROFILES=ai` and
  `BUSSOLA_AI_URL=http://ai:11434`; `BUSSOLA_AI_MODEL` picks the model
  (`qwen3.5:4b` by default). Profile → "Your name as your banks write it"
  tells the model which movements are transfers to oneself. Measured in
  `tools/ai-eval/`. Migration `003_inbox_ai.sql` adds the items' reading state
  and currency, and `users.bank_names`.
- **A link that opens the transaction form filled in**:
  `/transactions/new?amount=&description=&date=&type=&from=&to=`, for an
  iPhone Shortcut's "Open URL" and the like.

- **Install without cloning the repository.** Each release carries
  `docker-compose.yml`, with the images pinned to that version, and
  `example.env`: two `curl` commands and `docker compose up -d`, on amd64 or
  arm64 (a Raspberry Pi 5, a NAS). Upgrading is downloading the new release's
  compose file, then `pull` and `up -d`. See the README and
  [docs/operations.md](docs/operations.md#upgrading).

### Changed

- **Phone notifications are sent with high urgency**, so that a phone at rest
  shows them at once instead of when the app is opened. A single notification
  held back by the one-minute window now keeps its amount and merchant when
  details are on (only a summary of two or more has none). If a notification
  still arrives only when you open the app, set the browser's battery use to
  unrestricted (see the guide).
- **Price updates are an optional container in Bussola's own compose file**
  (`quotes/`, profile `quotes`), open source like the rest: crypto from
  CoinGecko's public API, ETFs and stocks by ISIN from Eulerpool and then
  Twelve Data, with free keys of your own (`EULERPOOL_API_KEY`,
  `TWELVEDATA_API_KEY`, and `EODHD_API_KEY` as a last resort for what the two
  miss, such as ETCs on Xetra; each is asked when the one before cannot price
  the instrument in the wallet's currency or has used up its quota). It talks to the API over the internal network, with no keys. Turn it
  on with `COMPOSE_PROFILES=quotes` and `BUSSOLA_QUOTES_URL=http://quotes:8080`;
  `BUSSOLA_QUOTE_KEY` and `BUSSOLA_QUOTE_URL` are gone.
- `example.env` keeps only what an installation sets (about 40 lines); every
  variable is in [docs/configuration.md](docs/configuration.md).
  `VITE_REST_API_URL` is gone.
- Toasts raised from inside a modal (a quote refresh) show above it.

### Removed

- `docker-compose.gpu.yml`: Bussola targets small home servers, where the
  model runs on the CPU.

## [0.1.0]

The first public release.

### Added

- **Spending and wealth in one place.** Bank accounts, expense and income
  categories, and transactions entered on a keypad that does arithmetic; a
  portfolio of holdings split across four pillars (cash, emergency fund,
  planned expenses, long term), with a monthly snapshot kept as history.
- **Summaries**: a year at a time, month by month and category by category.
- **Several people, several wallets.** Sign-in by username, wallets shared with
  read-write or read-only members, and an instance administrator. Isolation
  between wallets is enforced by PostgreSQL Row Level Security, not by
  application code.
- **Six interface languages** (English, Italian, French, German, Spanish,
  Chinese) and a currency per wallet, formatted the way each language writes
  it.
- **Import and export**: Bussola's own CSV, a full-wallet archive that imports
  into any installation, and any bank's CSV through a mapping wizard, with a
  preview before anything is written.
- **Price updates** for ETFs and crypto through a quote service: an official
  one with a key (`BUSSOLA_QUOTE_KEY`) is planned, or a service of your own
  implementing the contract in `api/services/quotes/http.js`. Without one,
  values are entered by hand and the refresh buttons are disabled.
- **Passkeys** as a second way to sign in, when the instance has a public HTTPS
  address.
- **Bank mode** (`H` hides every amount), a light and a dark theme, and keyboard
  shortcuts for nearly everything (`?` lists them).
- **Security**: a Content-Security-Policy and the usual headers, cross-origin
  writes refused, a temporary lock after five wrong passwords, throttles on
  sign-in, sign-up and password changes, generic error responses.
- **Installable by anyone**: one Docker Compose stack (nginx, API, PostgreSQL),
  the database created and migrated at first boot, configuration read at
  runtime so one image serves any installation.
- A demo that runs entirely in the browser on invented data
  (https://demo-bussola.marcotodaro.dev).
