# Security notes

[← Installation](install.md)

- **Sign-up is closed** by default (`BUSSOLA_SIGNUP=closed`).
- **Passwords** are hashed with scrypt. Sessions use `httpOnly`, `SameSite=Lax` cookies, and their tokens are stored hashed.
- **Lockout:** after 5 wrong passwords, sign-in is blocked for 15 minutes. Each further lock in a row doubles that, up to a day. Devices already signed in stay signed in. The lock is shown only after the correct password, so it does not reveal which usernames exist. To lift it:
  ```bash
  docker exec bussola-api node scripts/unlock.js            # list accounts
  docker exec bussola-api node scripts/unlock.js <username> # unlock one
  ```
  or use **Settings → Members and accounts**.
- **Rate limits** apply to sign-in, sign-up, passkey sign-in and re-typed passwords, per address or per account.
- **Headers:** a strict CSP (one inline script, allowed by hash), plus `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors` and `Permissions-Policy`.
- **Same origin only:** a POST from another site, port or subdomain is refused. To serve the frontend from another origin, list it in `CORS_ORIGINS`.
- **Behind a reverse proxy**, set `BUSSOLA_TRUSTED_PROXIES=2`. Otherwise every visitor looks like the proxy to the rate limits.
- **The administrator can't read other people's data** without joining their wallet, and then shows up in its members list.
- **Wallet isolation** is enforced by PostgreSQL Row Level Security. The API connects as the unprivileged `bussola_app` role, and it refuses to start if a connection without a wallet can see any data.
