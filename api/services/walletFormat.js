// ---------------------------------------------------------------------------
// The shape of an exported wallet
// ---------------------------------------------------------------------------
// One definition read by both directions: the export writes these columns in
// this order, the import looks them up by name. Were the two lists kept in two
// controllers, the first column renamed on one side only would produce an
// archive its own application cannot read back.
//
// Everything is keyed by name and by code, never by id. Ids are this
// instance's sequence numbers, and they mean nothing -- or worse, something
// else -- in the wallet an archive is imported into.

// The archive says what it is, so that a ZIP of holiday photos is told apart
// from a wallet, and a wallet written by a later version with a different
// layout is refused instead of misread. Raise FORMAT_VERSION when a change
// would make an older importer misunderstand a newer archive; adding a column
// an older importer can ignore is not such a change.
const FORMAT = "bussola-wallet";
const FORMAT_VERSION = 1;

const FILES = {
  manifest: "manifest.json",
  accounts: "accounts.csv",
  categories: "categories.csv",
  transactions: "transactions.csv",
  holdings: "holdings.csv",
  snapshots: "snapshots.csv",
  snapshotDetails: "snapshot_details.json",
};

// from and to are what the transactions table calls from_id and to_id, by
// name. For an expense and for an income, `from` is the bank account and `to`
// the category -- which is also how the transaction form lays them out; for a
// transfer both are accounts.
const TRANSACTION_COLUMNS = ["date", "type", "amount", "from", "to", "note"];

// `balance` is the account as it stands, for whoever reads the file.
// `opening_balance` is what the import uses: the balance minus everything the
// wallet's transactions did to it. A new account is created with it, the
// imported transactions then move it exactly as if they had been typed in one
// by one, and the account ends on `balance` again. Creating it at `balance`
// instead would count every transaction twice.
const ACCOUNT_COLUMNS = [
  "name",
  "balance",
  "opening_balance",
  "investment",
  "current",
  "archived",
  "color",
  "icon",
  "icon_family",
  "description",
];

// `kind` is the account type's code: EXPENSE or INCOME.
const CATEGORY_COLUMNS = ["name", "kind", "archived", "color", "icon", "icon_family", "description"];

// The pillar is its code. The type is its code when it has one (the seeded
// taxonomy) and its name when it does not (a type somebody invented, which
// has no code by construction) -- hence two columns rather than one that
// would have to guess which of the two it holds.
const HOLDING_COLUMNS = [
  "account",
  "name",
  "pillar",
  "type_code",
  "type_name",
  "amount",
  "quantity",
  "purchase_price",
  "purchase_date",
  "current_price",
  "currency",
  "isin",
  "issuer",
  "country",
  "auto_update",
  "description",
];

// Followed by one column per pillar, headed by the pillar's code: the table
// stores value_p1..value_p4 by pillar id, and the id is exactly what must not
// travel between instances.
const SNAPSHOT_COLUMNS = ["year", "month", "total"];

module.exports = {
  FORMAT,
  FORMAT_VERSION,
  FILES,
  TRANSACTION_COLUMNS,
  ACCOUNT_COLUMNS,
  CATEGORY_COLUMNS,
  HOLDING_COLUMNS,
  SNAPSHOT_COLUMNS,
};
