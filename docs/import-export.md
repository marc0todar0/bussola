# Import and export

[← Using Bussola](using.md)

**Settings → Import / export.**

## Export (any member)

- **Transactions (.csv):** `date`, `type`, `amount`, `from`, `to`, `note`, optionally for a date range only. The file is UTF-8 with a BOM, and formulas are escaped. If Excel puts everything in one column, use *Data → From Text/CSV*.
- **Whole wallet (.zip):** accounts, categories, transactions, holdings and snapshots, all referred to by name. You can import it into any wallet on any instance. It moves a wallet; it is **not a backup** ([backups](operations.md#backup)).

## Import (read-write members)

Choose a file and you get a preview. **Nothing is saved until you confirm.**

- **Bussola files** (CSV or ZIP) are recognised automatically.
  - New accounts start at their opening balance.
  - Existing accounts keep their own balance, except an unused one (balance zero, no transactions), which takes the archive's.
  - Holdings and snapshots already in the wallet are skipped.
- **Bank CSV:** Bussola guesses the separator, encoding, decimal mark and date format. You pick the columns (date, amount or out/in, description), the account, and a default category for money out and for money in. Each row's category can be changed in the preview.
- **Preview:** shows rows with errors, the accounts and categories the import will create, and probable duplicates. Duplicates start unticked.
- **Confirm:** writes everything or nothing, and moves balances exactly as typing the transactions by hand would.
- **Limits:** 5 MB, 20,000 rows. Currencies are never converted.

Two accounts, or two categories of the same kind, can't share a name in one wallet, because the archive refers to them by name.
