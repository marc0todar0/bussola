# Installation

[← README](../README.md) · Basic setup: [Getting started](../README.md#getting-started)

## First boot

- On the first start, Bussola creates the database and your account, which is also the administrator.
- `BUSSOLA_AUTH_USER`/`BUSSOLA_AUTH_PASS` are read **only on the first boot**. After that, change your password in **Settings → Profile**.
- `PGUSER`, `PGPASSWORD` and `PGDATABASE` are **fixed once the database exists**. Choose them before the first start.

## On a home server

- Images exist for amd64 and arm64 (Raspberry Pi, NAS).
- Bussola uses a few hundred MB of RAM. A local reading model needs 4–5 GB more ([details](reading-model.md)).
- Keep Docker's data on an SSD.
- On a NAS (Synology, QNAP, Unraid, TrueNAS), create a stack from `docker-compose.yml` and put `.env` next to it.
- To reach it from your phone away from home, a VPN (Tailscale, WireGuard) is the simplest safe option.

## Network

- Only the frontend publishes a port (`BUSSOLA_PORT`, default 3000). The API and Postgres stay internal.
- Other devices on your LAN can open `http://<server-ip>:3000`.
- Port taken? Set `BUSSOLA_PORT=8080`.

## HTTPS and passkeys

Put a reverse proxy in front of Bussola. For example, with Caddy:

```
bussola.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Then in `.env`:

```bash
BUSSOLA_COOKIE_SECURE=true                        # only over HTTPS, or sign-in breaks
BUSSOLA_TRUSTED_PROXIES=2                         # your proxy + Bussola's nginx
BUSSOLA_PUBLIC_URL=https://bussola.example.com    # turns on passkeys and phone notifications
```

and run `docker compose up -d`.

- **Passkeys:** add one under **Settings → Profile**. Passkeys work only at that exact domain, and changing the domain makes existing ones useless. The password keeps working.
- **Phone notifications:** see [Phone notifications](push-notifications.md).

## From the source code

```bash
git clone https://github.com/marc0todar0/bussola.git && cd bussola
cp example.env .env           # set the three values
docker compose up -d --build
```

For development with hot reload, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Troubleshooting

| Problem | Fix |
|---|---|
| API won't start after changing `PG*` values | Put the old values back. They are fixed in the volume ([details](database-client.md#changing-pguser-pgpassword-or-pgdatabase)). |
| Postgres won't start on a fresh install | Set `PGPASSWORD` in `.env`. |
| Sign-in does nothing | You are on plain `http://` with `BUSSOLA_COOKIE_SECURE=true`. Remove that setting. |
| Locked out after 5 wrong passwords | Wait 15 min, or run `docker exec bussola-api node scripts/unlock.js <username>`. |
| Forgot password | There is no reset (Bussola sends no email). Keep it in a password manager. |
| Price buttons disabled | Price updates are off: see [Price updates](price-updates.md). |
| Logs | `docker compose logs -f api` (or `frontend`, `postgres`). |

## Demo data

Want to look around first? Load the fictional dataset:

```bash
docker exec -i bussola-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < seed-demo.sql
```

⚠️ It **replaces everything** in the instance's first wallet. Sign in once and create that wallet before you load it. Use it only on a test instance.

## More

- [Security notes](security.md): how passwords, sessions, lockouts and wallet isolation work
- [Connecting a database client](database-client.md): DBeaver, psql over SSH
