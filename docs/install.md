# Installation

How to run Bussola beyond the [quick start](../README.md#getting-started): on a network, behind HTTPS, and what to do when something goes wrong. Back to the [README](../README.md).

- [First boot](#first-boot)
- [On a small home server](#on-a-small-home-server)
- [From the source code](#from-the-source-code)
- [Running it on a network](#running-it-on-a-network)
- [Security notes](#security-notes)
- [Connecting a database client](#connecting-a-database-client)
- [Troubleshooting](#troubleshooting)
- [Demo data (optional)](#demo-data-optional)

## First boot

`PGUSER` and `PGDATABASE` in `.env` can stay as they are. Choose them before the
first start if you want different values: they are fixed the first time the
database starts (see [Troubleshooting](#troubleshooting)).

On first boot Bussola creates the database schema and your account (which is
also the instance administrator). The first time you sign in it asks you to
name a wallet, and gives it one account and a handful of categories, so you can
enter a transaction straight away.
`BUSSOLA_AUTH_USER`/`BUSSOLA_AUTH_PASS` are used only for that first boot. After
that, change your password from **Settings → Profile**.

Every setting is described in [Configuration](configuration.md).

## On a small home server

Bussola is made to live on a Raspberry Pi, a NAS or a mini PC at home. The
images are published for amd64 and arm64, so `docker compose up -d` downloads
the right ones and builds nothing.

- **Memory.** Bussola itself (frontend, API, Postgres) uses a few hundred MB.
  A model that reads bank notifications is not part of Bussola: if you run one
  yourself it needs room, 4 to 5 GB free for `qwen3.5:4b`, less for
  `qwen3.5:2b` (see [Reading bank
  notifications](configuration.md#reading-bank-notifications)). Run it on
  another machine, or use a [hosted
  one](notifications.md#choosing-where-the-model-runs) (the text of your
  notifications then leaves your network).
- **Storage.** Put Docker's data on an SSD rather than an SD card: Postgres
  writes often, and a local model is a few GB.
- **A NAS** (Synology, QNAP, Unraid, TrueNAS…): create a project or stack
  from the downloaded `docker-compose.yml`, with the `.env` next to it.
- **From other devices:** see [Running it on a network](#running-it-on-a-network);
  for your phone outside home, a VPN such as Tailscale or WireGuard is the
  simplest safe way.

## From the source code

To change the code, or to build the images yourself instead of downloading
them:

```bash
git clone https://github.com/marc0todar0/bussola.git
cd bussola
cp example.env .env           # set the three values, as in the README
docker compose up -d --build
```

The repository's compose file has both an `image:` and a `build:` for each of
Bussola's containers: `--build` builds them from the code, and without it the
released `:latest` images are pulled. Working on the code with hot reload is
described in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Running it on a network

### How it is exposed

Only the frontend container publishes a port (`BUSSOLA_PORT`, default 3000). Its
nginx serves the app and forwards `/api` to the API container. The API and
Postgres are reachable only on Docker's internal network. The browser always
talks to a single origin, so there is no CORS to configure.

| Service | Stack | Exposure |
|---|---|---|
| `frontend` | React 19 + Vite, served by nginx (which also proxies `/api`) | `BUSSOLA_PORT` (3000) |
| `api` | Express (CommonJS), mounted at `/api` | internal network only |
| `postgres` | PostgreSQL 16 | internal network only |

The port is published on all of the host's interfaces, so other devices on your
LAN can already reach Bussola at `http://<server-ip>:3000`. If you don't want
that, block the port in the host's firewall and put a reverse proxy in front.

### Behind HTTPS / a reverse proxy

To reach Bussola from outside your home, put it behind a reverse proxy that
terminates TLS (Caddy, Traefik, nginx, a Cloudflare tunnel…) and point the proxy
at `http://127.0.0.1:<BUSSOLA_PORT>`. With Caddy, for example:

```
bussola.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Then set `BUSSOLA_COOKIE_SECURE=true` and `BUSSOLA_TRUSTED_PROXIES=2` in `.env` and
run `docker compose up -d`. The first makes the browser send the session cookie
only over HTTPS. Do **not** set it while you are still using plain `http://`, or
signing in will silently fail because the browser drops the cookie. The second
tells the API that there are now two proxies in front of it (yours and Bussola's
nginx), so the rate limits see each visitor's real address rather than your
proxy's. Set it only when a proxy really is in front: with nothing there, a
client could make up its own address.

To sign in with a **passkey** — the phone's fingerprint, face or screen lock —
also set the public address:

```
BUSSOLA_PUBLIC_URL=https://bussola.example.com
```

Each person then adds a passkey from their profile (it asks for the password
once more), and the login screen offers "Sign in with a passkey" with no
username to type. The password keeps working; a passkey is an extra way in,
never a replacement. Passkeys are bound to that exact domain: they only appear
when the page is opened at that address over HTTPS (browsers refuse them over
plain `http://`, except on `localhost`), and changing the domain later makes the
existing ones useless. Without `BUSSOLA_PUBLIC_URL` passkeys are off — the API
does not guess the address from request headers, which the client controls.

The same variable turns on **notifications on the phone** (Web Push): install
Bussola as an app on the phone, turn notifications on in the profile, and a
message appears when something waits in the inbox. Nothing else to configure;
see [Getting a notification on your phone](notifications.md#getting-a-notification-on-your-phone).

If `3000` is taken on the host, change `BUSSOLA_PORT` and point the proxy at the
new port.

## Security notes

- **Sign-up is closed by default.** Open it only while you are adding someone (see [Adding people](using.md#adding-people)).
- **Passwords** are hashed with scrypt. Sessions are `httpOnly`, `SameSite=Lax` cookies whose tokens are stored hashed. Credentials never reach the page's JavaScript.
- **Five wrong passwords in a row lock an account for 15 minutes**, and each further lock in a row lasts twice as long, up to a day. The lock lifts by itself, and it only stops new sign-ins: devices already signed in stay signed in, so someone guessing cannot throw you out. The lock is only mentioned after the right password, so it does not reveal which usernames exist. An administrator can lift it sooner from **Settings → Members and accounts**, or from the server:

  ```bash
  docker exec bussola-api node scripts/unlock.js            # list accounts and their state
  docker exec bussola-api node scripts/unlock.js <username> # unlock (and re-enable) one
  ```

  Sign-in, sign-up, passkey sign-in and re-typing your current password are also rate-limited per address or per account.
- **Security headers.** nginx sends a strict Content-Security-Policy (no inline scripts except the theme snippet in `index.html`, allowed by a hash computed when the image is built), plus `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`/`frame-ancestors` and `Permissions-Policy`.
- **Requests that change something must come from Bussola's own pages.** The API refuses a POST whose `Origin` is another site, another port on the same machine or another subdomain, so another app on the same host cannot act with your session. If you serve the frontend from a different origin than the API, list it in `CORS_ORIGINS`.
- **Behind another reverse proxy,** set `BUSSOLA_TRUSTED_PROXIES=2` (see [Behind HTTPS](#behind-https--a-reverse-proxy)); otherwise every visitor looks like the proxy to the rate limits.
- **The administrator cannot read other people's data** without joining their wallet as a visible member.
- **Isolation between wallets** is enforced by PostgreSQL Row Level Security. The API connects as an unprivileged role (`bussola_app`) and checks at every boot that a connection with no wallet context sees nothing; if it does, the API refuses to start. `PGUSER`, the owner of the tables, bypasses these rules and is used only for migrations and maintenance.

## Connecting a database client

For looking at the data by hand with DBeaver, pgAdmin or `psql` from your own
computer. Postgres is not published by default; in the server's `.env`:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.db.yml
```

then `docker compose up -d`. Postgres now listens on the server's
`127.0.0.1:5432` (`BUSSOLA_DB_PORT` changes the port) and nowhere else, so the
client reaches it through SSH. In DBeaver: host `localhost`, port `5432`,
database `PGDATABASE`, user `PGUSER`, password `PGPASSWORD`; on the **SSH** tab,
tick *Use SSH Tunnel* and give the server's address and your SSH login.

> **Warning.** `PGUSER` owns the tables and is a superuser: **it bypasses Row
> Level Security** and sees, and can change, **every wallet on the instance**.
> Marking the connection read-only in the client (DBeaver: *General → Security*)
> avoids mistakes.

## Troubleshooting

**I changed `PGUSER`, `PGPASSWORD` or `PGDATABASE` and now the API won't start.**
These values are used to *create* the database the first time the Postgres
container starts on an empty volume. After that they are fixed inside the volume:
changing them in `.env` doesn't rename anything, it only points the API at a user
or database that doesn't exist. Put the old values back. To really change them,
take a dump, start on a new volume and restore (see [Backups](operations.md#backups-and-restore)).
If you are only trying things out and want to start from scratch,
`docker compose down -v` deletes the volume **and all data in it**.

**The Postgres container won't start on a fresh install.** Check that
`PGPASSWORD` is set in `.env`. The Postgres image refuses to initialise a
database without a password.

**I'm locked out after too many wrong passwords.** Wait: the lock lifts by
itself, after 15 minutes the first time (the message on the login screen says
how long). An administrator can lift it sooner from **Settings → Members and
accounts**, or run `docker exec bussola-api node scripts/unlock.js <username>` on
the server.

**I forgot my password.** Bussola sends no email, so there is no "forgot
password" link, and `unlock.js` re-enables an account without changing its
password. There is currently no built-in reset, so keep the password in a
password manager. Changing `BUSSOLA_AUTH_PASS` in `.env` does nothing after the
first boot.

**Port 3000 is already in use.** Set `BUSSOLA_PORT=8080` (or any free port) in
`.env` and run `docker compose up -d`.

**Signing in does nothing / I'm immediately signed out.** If you are on plain
`http://`, make sure `BUSSOLA_COOKIE_SECURE` is not set to `true`.

**The price refresh buttons are disabled.** The optional quotes service is off:
turn it on as described in [Price updates](price-updates.md), or keep entering
holdings' values by hand.

**"No wallet exists yet" when loading the demo data.** Start the stack once
(`docker compose up -d`) so the first account and its wallet are created, then
load `seed-demo.sql`.

**Where are the logs?** `docker compose logs -f api` (or `frontend`, `postgres`).

## Demo data (optional)

To look around with realistic data first, load the fictional demo dataset:

```bash
docker exec -i bussola-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < seed-demo.sql
```

What it does:

- It goes into the **first wallet on the instance** (the lowest id), which on a fresh install is the one you created at your first sign-in.
- It **deletes everything that wallet already holds** and replaces it: 6 current accounts, 2 investment accounts with 9 holdings, 21 categories, about 86 transactions over the last four months, and 5 monthly portfolio snapshots. Loading it twice gives the same result. Other wallets are not touched.
- It refuses to run until a wallet exists: sign in once and create one first.
- Institutions, issuers and ISINs are made up (the ISINs use the unassigned `XX` prefix), so no quote service has a price for them.

Only load it on an instance you are trying out, not onto a wallet with real data.
