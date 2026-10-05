# Using Bussola

[← README](../README.md)

## The basics

- **Tabs:** *Accounts*, *Categories*, *Transactions*, *Summary*, plus **Settings**, which holds the wallet switch, language, theme, bank mode, profile and sign-out.
- **Wallet:** everything you enter belongs to a wallet. At the first sign-in you name one, or open one somebody shared with you. To switch wallets, click the wallet name in Settings.
- **Accounts** hold money (bank, card, cash, broker). **Categories** say what it was for (groceries, salary).
- **Transactions:**
  - *Expense*: from an account to a category
  - *Income*: from a category to an account
  - *Transfer*: from one account to another

## Adding a transaction

On *Transactions*, press `N` (or **+**), type the amount (arithmetic works: `12.50+7.30`), pick the type, *From* and *To*, then press `Enter`.

## Summary and portfolio

- **Summary:** a year at a time, by month and by category. Click a category to see its transactions.
- **Portfolio** (chart button on *Accounts*): your holdings across four pillars (*cash*, *emergency fund*, *planned expenses*, *long term*). Your bank balances count as cash, so the total is your net worth.
- **Prices** update automatically only with [price updates](price-updates.md) on. Otherwise you type the values in.
- **Snapshots:** on the 1st of each month Bussola saves the portfolio. A snapshot you take by hand replaces that month's.

## Sharing a wallet

**Settings → Members and accounts**: type a username and pick **Read and write** or **Read only**. There is nothing to accept, and removing someone takes effect at once. Only the person who created a wallet can share it.

## Adding people

Sign-up is closed by default. Either:

- **The administrator creates the account** in **Settings → Members and accounts**, or
- **Open sign-up for a moment:** set `BUSSOLA_SIGNUP=open`, run `docker compose up -d api`, let them sign up, then set it back to `closed`.

The administrator manages accounts but **cannot see anyone's data** without joining their wallet.

## Profile

- Change your username, password and language, and add passkeys.
- **Currency** belongs to the wallet. Changing it only changes the symbol shown: **nothing is converted**.
- **Deleting a wallet** deletes its data for everyone it was shared with. You can't delete your first wallet.

## Import and export

**Settings → Import / export.** Export a CSV of transactions or the whole wallet as a ZIP, or import a bank's CSV through a wizard with a preview. [Details](import-export.md).

## Keyboard shortcuts

Press `?` in the app for the full list.

| Where | Keys |
|---|---|
| Anywhere | `1`–`4` tabs · `5` Settings · `H` bank mode · `?` help |
| Lists | `N` new · `←` `→` previous/next month (year on Summary) · `/` search (Transactions) |
| Keypad | `0`–`9` `+` `-` `*` `/` `.` · `Enter` compute/confirm · `Backspace` · `Delete` clear · `Esc` close |
| Transaction form | `S` `E` `T` expense/income/transfer · `D` From · `A` To · `X` swap · `B` use balance · `N` note · `G` calendar · `←` `→` day · `O` today |
