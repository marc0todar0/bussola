<p align="center">
  <img src="frontend/public/icon.svg" width="112" height="112" alt="Bussola logo: a white four-point compass rose on a blue disc">
</p>

<h1 align="center">Bussola</h1>

<p align="center">
  <strong>All your money, in one place, adding up.</strong><br>
  Every bank, card, wallet, broker and pocket of cash: your spending <em>and</em> your net worth.<br>
  Self-hosted, free and open source, no telemetry.<br>
  <a href="https://demo-bussola.marcotodaro.dev"><strong>Try the demo</strong></a> - 
    <a href="https://bussola.marcotodaro.dev"><strong>Website</strong></a>
</p>

<p align="center">
  <a href="docs/using.md">Docs</a> -
  <a href="https://github.com/marc0todar0/bussola/releases/latest">Latest release</a> -
  <a href="https://github.com/marc0todar0/bussola/issues/new?template=bug.md">Report a bug</a> -
  <a href="https://github.com/marc0todar0/bussola/discussions">Ask a question</a> -
  <a href="#support-the-development">🙏 Donate</a>
</p>

<p align="center">
  <a href="https://bussola.marcotodaro.dev/bussola-promo.mp4"><img src="tools/promo/poster-play.jpg" width="820" alt="Watch the 30-second video: a bank notification becomes a transaction in one tap, every account adds up to one total, and the portfolio grows"></a>
</p>

## Getting started

**You need** a computer or server with [Docker](https://docs.docker.com/get-docker/). Nothing else.

**1. Download two files** into a new folder:

```bash
mkdir bussola && cd bussola
curl -LO https://github.com/marc0todar0/bussola/releases/latest/download/docker-compose.yml
curl -L -o .env https://github.com/marc0todar0/bussola/releases/latest/download/example.env
```

**2. Open `.env`** and fill in these three lines:

```bash
BUSSOLA_AUTH_USER=yourname          # the username you will sign in with
BUSSOLA_AUTH_PASS=your-password     # at least 6 characters
PGPASSWORD=long-random-string       # database password; you'll never type it again
```

> To generate a random string, run `openssl rand -hex 24`.

**3. Start Bussola:**

```bash
docker compose up -d
```

The first time, this downloads the images, which takes a minute or two.

**4. Open <http://localhost:3000>** (from another device: `http://<server-ip>:3000`). Sign in with the username and password from step 2, then name your first wallet. You're ready: go to *Transactions* and press `N`.

To stop it, run `docker compose down`. Your data is kept.

### Optional extras

| Extra | Guide |
|---|---|
| Automatic prices for ETFs, stocks and crypto | [Price updates](docs/price-updates.md) |
| Transactions from bank notifications | [Bank notifications](docs/notifications.md) |
| HTTPS, passkeys, phone notifications | [Installation](docs/install.md#https-and-passkeys) |

## Screenshots

<p align="center">
  <img src="docs/screenshots/summary.png" width="820" alt="The yearly summary: income, expenses and net, and a chart by month">
</p>

| | |
|:---:|:---:|
| ![A new expense on the keypad](docs/screenshots/transaction-form.png) | ![The portfolio across the four pillars](docs/screenshots/portfolio.png) |
| **Keypad** that does arithmetic | **Portfolio** across four pillars |
| ![Every amount blurred](docs/screenshots/bank-mode.png) | ![Sign in with a passkey](docs/screenshots/passkey.png) |
| **Bank mode** (`H`) | **Passkeys** |

<p align="center">
  <img src="docs/screenshots/mobile-transactions.png" alt="Transactions on a phone" width="180">
  <img src="docs/screenshots/mobile-keypad.png" alt="The keypad on a phone" width="180">
  <img src="docs/screenshots/mobile-summary.png" alt="The summary on a phone" width="180">
  <img src="docs/screenshots/mobile-portfolio.png" alt="The portfolio on a phone" width="180">
</p>

## Features

- **Every account, one total.** Banks, cards, payment apps, brokers, exchanges, cash. You can archive old ones and their history stays.
- **Spending and net worth together.** Expenses and income month by month, next to ETFs, stocks, bonds, crypto and deposits, with automatic prices if you want them.
- **No bank passwords.** Your phone forwards bank notifications and a language model turns them into drafts you accept in one tap. You can also import any bank's CSV.
- **Shared on your terms.** Many users, many wallets, each shared **read** or **read-write**. PostgreSQL row-level security keeps the wallets apart.
- Also: a keypad that does arithmetic, bank mode (`H` hides every amount), passkeys, six languages, a currency per wallet, keyboard shortcuts, dark theme, installable on a phone.

How it compares with Firefly III, Actual, Ghostfolio and Sure, and who it is *not* for: [Comparison](docs/comparison.md).

## Documentation

- [Installation](docs/install.md): HTTPS, home servers, troubleshooting
- [Using Bussola](docs/using.md): wallets, transactions, sharing, shortcuts
- [Bank notifications](docs/notifications.md): phone setup and the reading model
- [Price updates](docs/price-updates.md)
- [Configuration](docs/configuration.md): every `.env` setting
- [Backups and upgrades](docs/operations.md)
- [Contributing](CONTRIBUTING.md)

<p align="center">
  <img src="docs/architecture.svg" width="760" alt="Bussola's containers: frontend (nginx, the only published port) proxies /api to the api (Express), which stores everything in postgres. An optional quotes container fetches prices; an optional OpenAI-compatible model reads bank notifications.">
</p>

## Support the development

Bussola is free and stays free: no paid plans, no premium features. If it helps you, you can donate.

<p>
  <a href="https://ko-fi.com/marc0todar0"><img src="https://ko-fi.com/img/githubbutton_sm.svg" height="36" alt="Support Bussola on Ko-fi"></a>
  &nbsp;
  <a href="https://buymeacoffee.com/marc0todar0"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" height="30" alt="Buy me a coffee"></a>
</p>

## License

MIT. See [LICENSE](LICENSE).
