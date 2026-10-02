# Using Bussola

What Bussola does and how to find your way around it once it is running. Back to the [README](../README.md).

- [Features](#features)
- [Screenshots](#screenshots)
- [First steps in the app](#first-steps-in-the-app)
- [Adding people](#adding-people)
- [Import and export](#import-and-export)
- [Transactions from bank notifications](notifications.md)
- [Keyboard shortcuts](#keyboard-shortcuts)

## Features

- **Accounts and categories.** Where money is kept, and what it is spent on or earned from.
- **Transactions.** Expenses, income and transfers between accounts, entered on a keypad that does arithmetic, with search and month-by-month browsing.
- **Summaries.** A yearly chart of income and expenses by month, a per-category breakdown and a monthly detail view.
- **Portfolio.** Holdings per account (ETFs, stocks, bonds, funds, crypto, deposit accounts…), allocation across four pillars (*cash*, *emergency fund*, *planned expenses*, *long term*), diversification by type, issuer, country and currency, and a monthly snapshot kept as history. ETF and crypto prices can update automatically through a quote service (see [Price updates](configuration.md#price-updates)); without one, you enter values by hand.
- **Several people, shared wallets.** Everyone creates the wallets they need, and whoever created one can share it with other people as *read and write* or *read only*. Isolation between wallets is enforced by the database itself, not by application code.
- **Six interface languages:** English, Italian, French, German, Spanish and Chinese (Simplified). Each person picks their own.
- **A currency per wallet** (EUR, USD, GBP, CHF, JPY, AUD, CAD, CNY, HKD, SEK). Amounts are formatted the way your language writes them.
- **Bank mode.** One toggle (or `H`) blurs every amount on screen, for when someone is looking over your shoulder.
- **Passkeys.** Sign in with your fingerprint, face or phone screen lock (WebAuthn), with the password kept as a fallback. Available when Bussola is served over HTTPS (see [Behind HTTPS](install.md#behind-https--a-reverse-proxy)).
- **Transactions from bank notifications.** An iPhone automation or an Android app sends your bank's notifications to Bussola with a personal token; they wait as drafts on the Transactions page until you accept them in one tap or review them in the form. A reading model (any OpenAI-compatible endpoint you point Bussola at, yours or hosted) drops offers and codes and fills in the rest. See [Transactions from bank notifications](notifications.md).
- **Notifications on the phone.** Install Bussola as an app (Android: Install app; iPhone: Add to Home Screen) and turn notifications on in your profile: a message appears when a draft waits in the inbox, from Bussola itself, with no other app. Needs HTTPS. See [Getting a notification on your phone](notifications.md#getting-a-notification-on-your-phone).
- **Keyboard shortcuts** for nearly everything, and a layout that works on a phone.
- **Self-contained.** Three Docker containers, one published port, no telemetry, no external account needed.

## Screenshots

All taken from the fictional [demo dataset](install.md#demo-data-optional).

| | |
|:---:|:---:|
| ![A new expense on the keypad: from Cartesio Bank to Groceries, 42.50](screenshots/transaction-form.png) | ![The yearly summary: income, expenses and net, and a chart by month](screenshots/summary.png) |
| **Adding a transaction.** A keypad that does arithmetic, driven entirely from the keyboard. | **Summary.** A year at a time, then month by month and category by category. |
| ![The portfolio split across the four pillars, and its history](screenshots/portfolio.png) | ![The accounts list with every amount blurred](screenshots/bank-mode.png) |
| **Portfolio.** Wealth across the four pillars, with a monthly history. | **Bank mode.** One key (`H`) hides every amount on screen. |
| ![The yearly summary in the dark theme](screenshots/summary-dark.png) | ![The sign-in card with a "Sign in with a passkey" button](screenshots/passkey.png) |
| **Dark theme**, or follow the system. | **Passkeys.** Sign in with a fingerprint or face instead of typing the password. |

<p align="center">
  <img src="screenshots/mobile-transactions.png" alt="The transaction list on a phone" width="200">
  <img src="screenshots/mobile-keypad.png" alt="A new expense on the keypad, on a phone" width="200">
  <img src="screenshots/mobile-summary.png" alt="The yearly summary on a phone" width="200">
  <img src="screenshots/mobile-portfolio.png" alt="The portfolio's four pillars on a phone" width="200">
</p>
<p align="center"><b>On a phone</b>, the same app.</p>

## First steps in the app

**The tab bar.** There are four tabs (*Accounts*, *Categories*, *Transactions*,
*Summary*) and a fifth cell, **Settings**, which holds everything that is not a
page: the wallet you are looking at, language, bank mode, theme, keyboard
shortcuts, your profile and sign-out.

**Wallet.** Everything you enter belongs to a wallet. A new account has none:
at the first sign-in Bussola shows the wallets somebody has already shared with
you, and if there are none it asks you to name your first. With exactly one,
nothing asks you about it; with more, Bussola asks which to open when you sign
in, and you can switch from Settings by clicking the wallet name. You can create
more wallets from the same picker ("Create a new wallet"). A new wallet starts
in the currency of the one you were looking at.

**Accounts and categories.** *Accounts* are where money is kept: a current
account, cash, a card, a broker. *Categories* are what money is spent on or comes
from: groceries, rent, salary. Every transaction moves money between the two:

- **Expense.** From an account to an expense category.
- **Income.** From an income category to an account.
- **Transfer.** From one account to another. For example, moving savings to a broker.

**Adding a transaction.** On the *Transactions* tab press `N` (or the `+`
button). The form opens on a keypad: type the amount, arithmetic included
(`12.50+7.30`). Pick expense, income or transfer and choose *From* and *To*, then
optionally set a date and a note. `Enter` confirms. The whole form can be driven
from the keyboard (see [Keyboard shortcuts](#keyboard-shortcuts)).

**Summary.** The *Summary* tab shows a year at a time: income, expenses and net,
a chart by month, and the breakdown per category. Click a category to jump to its
transactions, or open the monthly detail.

**Portfolio.** From the *Accounts* tab, the chart button opens the portfolio: how
your wealth splits across the four pillars, and how the invested part is
diversified. Holdings are added to investment accounts. When a quote service is
configured (see [Price updates](configuration.md#price-updates)), crypto and ETFs
with an ISIN can update their price, and a refresh button fetches the quotes on
demand; without one, the refresh buttons are disabled and you enter values by
hand. Prices are fetched in the wallet's currency, so they add up with
everything else in it; a price the service cannot give in that currency is not
applied, and the holding keeps the value you entered. On the 1st of each month
Bussola records a snapshot, so the portfolio builds a history you can browse
later. A snapshot is the portfolio as it is when it is taken, labelled with the
month it is taken in: the one recorded on 1 June is filed under June and shows
the values at the opening of June (which are also those at the close of May).
Taking one by hand during the month replaces that month's snapshot with the
values of that moment; past values are never reconstructed.

**Inviting someone to a wallet.** Whoever created a wallet decides who else can
open it. Go to **Settings → Members and accounts**, type the person's username
and pick a role:

- **Read and write:** they can do everything you can with the data.
- **Read only:** every figure, chart and detail, and no button that changes anything.

There is no invitation to accept, because you have already agreed between
yourselves. Removing a member takes effect immediately. The person needs an
account on the instance first (see [Adding people](#adding-people)).

**Currency and language.** Each wallet has a single currency, set by its owner
under **Settings → Profile → Your wallets**. Changing it changes the unit shown
and **converts nothing**: the numbers stay as they are. The language is
personal: pick it from the flag in Settings or on the login screen. It follows
your account to any browser you sign in from. Only the interface is translated.
Your own account names, categories and notes stay exactly as you typed them.

**Profile.** Change your username or password, and rename or delete wallets you
own. Deleting a wallet deletes everything in it, for everyone it was shared with,
and asks you to type its name to confirm. The first wallet an account was given
cannot be deleted.

**Appearance.** Settings has a light / dark / system theme selector.

## Adding people

Sign-up is **closed** by default, so an instance reachable from the internet
cannot be filled by strangers. There are two ways to add someone:

- **The administrator creates the account.** Go to **Settings → Members and accounts → Create the account**, enter a username and password, and hand them over. The new account has no wallet: add it to one of yours from the members list, or let them create their own at the first sign-in.
- **Let them sign up themselves**, for a short while:
  1. set `BUSSOLA_SIGNUP=open` in `.env`
  2. `docker compose up -d api`
  3. they create their account from the login screen
  4. set `BUSSOLA_SIGNUP=closed` again and run `docker compose up -d api`

The administrator (the account created from `BUSSOLA_AUTH_*`) manages accounts
and wallets. It does **not** get to see anybody's data: to look inside a wallet
it has to be added as a member, and that shows in the members list like anyone
else.

The administrator can also **delete** an account or a wallet from the same page,
typing its name back to confirm. Deleting an account deletes every wallet it
created, with everything in them, for everyone they were shared with; wallets
other people shared with it are not touched. Switching an account off instead
keeps all of it and only stops the sign-in.

## Import and export

**Settings → Import / export** moves a wallet's data in and out of files.

**Export** is open to every member, read-only ones included:

- **Transactions (.csv)**: one row per transaction with `date` (YYYY-MM-DD), `type` (`EXPENSE`, `INCOME` or `TRANSFER`), `amount` (a dot as decimal mark), `from`, `to` and `note`, optionally limited to a date range. The file is UTF-8 with a byte-order mark, so Excel shows accented names correctly. A note that starts with `=`, `+`, `-` or `@` is written with a leading apostrophe, so no spreadsheet runs it as a formula. Excel in a comma-decimal language (Italian, German…) may open a comma-separated file in a single column. If it does, use *Data → From Text/CSV* and choose the comma.
- **Whole wallet (.zip)**: accounts, categories, transactions, holdings and monthly portfolio snapshots, plus a `manifest.json` stating the format version and the wallet's currency. Everything is identified by name, so the archive can be imported into another wallet, on this instance or another one — which is why two accounts, or two categories of the same kind, cannot share a name in one wallet (capitals and spaces aside). An archive exported before that rule, from a wallet that had such twins, still folds them into one on import. It is a way to move a wallet, not a replacement for [backups](operations.md#backups-and-restore).

**Import** needs read-and-write access. Choose a file and Bussola shows a preview. Nothing is saved until you confirm it.

- **Bussola's own files** (the transactions CSV or the wallet archive) are recognised automatically. An account created from an archive starts at its opening balance, and its transactions bring it back to the balance it had when exported. An account the wallet already has keeps its own balance, with one exception: one that has never been used (balance zero, no transactions, no holdings), such as the starter account of a new wallet, takes the archive's opening balance, and the preview says so. Restoring an archive into a fresh wallet therefore ends on the same balances. Holdings and snapshots the wallet already has are skipped.
- **A bank's CSV** goes through a short wizard. Bussola guesses the separator, character set, decimal mark, date format and header row, and you check them against the first rows of the file. Then pick the columns for the date, the amount (or separate *money out* / *money in* columns) and the description, which becomes the note. Choose the account the money moved in and a default category for money going out and for money coming in. The sign of each amount decides whether it is an expense or an income, and each row's category can be changed in the preview.
- **The preview** lists rows with errors, every account and category the import would create, and probable duplicates: rows with the same day, amount, accounts and note as a transaction already in the wallet, or as an earlier row in the file. Duplicates start unticked.
- **Confirming** writes everything in a single database transaction: either the whole import is saved or none of it is. Balances move exactly as if each transaction had been typed in by hand.
- Limits: 5 MB and 20,000 transactions per file. Amounts are never converted: a file from a wallet in another currency is imported as it is, with a warning.

## Keyboard shortcuts

Press `?` anywhere to see the full list in the app. Shortcuts are ignored while
you are typing in a text field.

| Where | Keys |
|---|---|
| Anywhere | `1` `2` `3` `4` switch tabs (Accounts, Categories, Transactions, Summary) · `5` opens the Settings menu · `H` toggles bank mode (hide amounts) · `?` shows or hides all shortcuts |
| Accounts | `N` new account |
| Categories | `N` new category · `←` `→` previous / next month |
| Transactions | `N` new transaction · `/` search · `←` `→` previous / next month |
| Summary | `←` `→` previous / next year |
| Keypad (form open) | `0`–`9` `+` `-` `*` `/` `.` type · `Enter` compute / confirm · `Backspace` delete last · `Delete` clear · `Esc` close |
| Transaction form | `S` `E` `T` expense / income / transfer · `D` pick *From* · `A` pick *To* · `X` swap From ↔ To · `B` use the From account's balance · `N` note · `G` calendar · `←` `→` previous / next day · `O` today |
