const db = require("../dbConn");
const { hashPassword } = require("./password");
const wallets = require("./wallets");

// ---------------------------------------------------------------------------
// A new user's initial data
// ---------------------------------------------------------------------------
// One account and a handful of categories to get going: without them the first
// screen is a form that refuses to be filled in. The real wizard arrives in
// phase 2 -- all this has to do is make the app usable from minute one.
//
// Call it inside withTenant: wallet_id is filled in by the RLS default.
//
// These are user data, not interface text, so they are not translated at
// render time: they are seeded once in the language chosen at sign-up, and
// from then on they are just rows the user can rename.
const STARTER_DATA = {
  en: {
    account: ["Current account", "steelblue", "cc-mastercard", "FontAwesome"],
    expenses: [
      ["Groceries", "olivedrab", "shopping-cart", "AntDesign"],
      ["Home", "goldenrod", "home", "AntDesign"],
      ["Transport", "steelblue", "card-travel", "MaterialIcons"],
      ["Leisure", "orchid", "movie", "MaterialIcons"],
      ["Health", "tomato", "medical-services", "MaterialIcons"],
      ["Other", "dimgray", "dot-chart", "AntDesign"],
    ],
    income: [
      ["Salary", "forestgreen", "dollar", "FontAwesome"],
      ["Other income", "darkorange", "gift", "AntDesign"],
    ],
  },
  it: {
    account: ["Conto corrente", "steelblue", "cc-mastercard", "FontAwesome"],
    expenses: [
      ["Spesa", "olivedrab", "shopping-cart", "AntDesign"],
      ["Casa", "goldenrod", "home", "AntDesign"],
      ["Trasporti", "steelblue", "card-travel", "MaterialIcons"],
      ["Svago", "orchid", "movie", "MaterialIcons"],
      ["Salute", "tomato", "medical-services", "MaterialIcons"],
      ["Varie", "dimgray", "dot-chart", "AntDesign"],
    ],
    income: [
      ["Stipendio", "forestgreen", "dollar", "FontAwesome"],
      ["Altre entrate", "darkorange", "gift", "AntDesign"],
    ],
  },
  fr: {
    account: ["Compte courant", "steelblue", "cc-mastercard", "FontAwesome"],
    expenses: [
      ["Courses", "olivedrab", "shopping-cart", "AntDesign"],
      ["Maison", "goldenrod", "home", "AntDesign"],
      ["Transports", "steelblue", "card-travel", "MaterialIcons"],
      ["Loisirs", "orchid", "movie", "MaterialIcons"],
      ["Santé", "tomato", "medical-services", "MaterialIcons"],
      ["Divers", "dimgray", "dot-chart", "AntDesign"],
    ],
    income: [
      ["Salaire", "forestgreen", "dollar", "FontAwesome"],
      ["Autres revenus", "darkorange", "gift", "AntDesign"],
    ],
  },
  de: {
    account: ["Girokonto", "steelblue", "cc-mastercard", "FontAwesome"],
    expenses: [
      ["Einkauf", "olivedrab", "shopping-cart", "AntDesign"],
      ["Wohnen", "goldenrod", "home", "AntDesign"],
      ["Verkehr", "steelblue", "card-travel", "MaterialIcons"],
      ["Freizeit", "orchid", "movie", "MaterialIcons"],
      ["Gesundheit", "tomato", "medical-services", "MaterialIcons"],
      ["Sonstiges", "dimgray", "dot-chart", "AntDesign"],
    ],
    income: [
      ["Gehalt", "forestgreen", "dollar", "FontAwesome"],
      ["Sonstige Einnahmen", "darkorange", "gift", "AntDesign"],
    ],
  },
  es: {
    account: ["Cuenta corriente", "steelblue", "cc-mastercard", "FontAwesome"],
    expenses: [
      ["Compra", "olivedrab", "shopping-cart", "AntDesign"],
      ["Hogar", "goldenrod", "home", "AntDesign"],
      ["Transporte", "steelblue", "card-travel", "MaterialIcons"],
      ["Ocio", "orchid", "movie", "MaterialIcons"],
      ["Salud", "tomato", "medical-services", "MaterialIcons"],
      ["Varios", "dimgray", "dot-chart", "AntDesign"],
    ],
    income: [
      ["Nómina", "forestgreen", "dollar", "FontAwesome"],
      ["Otros ingresos", "darkorange", "gift", "AntDesign"],
    ],
  },
  zh: {
    account: ["活期账户", "steelblue", "cc-mastercard", "FontAwesome"],
    expenses: [
      ["日常采购", "olivedrab", "shopping-cart", "AntDesign"],
      ["居家", "goldenrod", "home", "AntDesign"],
      ["交通", "steelblue", "card-travel", "MaterialIcons"],
      ["休闲", "orchid", "movie", "MaterialIcons"],
      ["医疗", "tomato", "medical-services", "MaterialIcons"],
      ["其他", "dimgray", "dot-chart", "AntDesign"],
    ],
    income: [
      ["工资", "forestgreen", "dollar", "FontAwesome"],
      ["其他收入", "darkorange", "gift", "AntDesign"],
    ],
  },
};

const starterFor = (locale) => STARTER_DATA[String(locale || "").slice(0, 2)] || STARTER_DATA.en;

const createInitialData = async (locale) => {
  const starter = starterFor(locale);
  const [name, color, icon, family] = starter.account;

  await db.query(
    `INSERT INTO accounts (id, name, color, icon, icon_family, amount, type_id, is_account, actual_amount)
     VALUES (nextval('seq_accounts'), $1, $2, $3, $4, 0, 3, true, 0)`,
    [name, color, icon, family],
  );

  for (const [typeId, list] of [
    [1, starter.expenses],
    [2, starter.income],
  ]) {
    for (const [n, c, i, f] of list) {
      await db.query(
        `INSERT INTO accounts (id, name, color, icon, icon_family, type_id, is_account)
         VALUES (nextval('seq_accounts'), $1, $2, $3, $4, $5, false)`,
        [n, c, i, f, typeId],
      );
    }
  }
};

// ---------------------------------------------------------------------------
// A wallet and its starter data
// ---------------------------------------------------------------------------
// A new account gets no wallet: it lands on the picker, which lists the wallets
// somebody has already shared with it and otherwise asks it to name one. That
// is where this is called from (POST /api/auth/wallets). A wallet made
// automatically would be named after the username, and for somebody invited
// into a household's wallet it would be a second, empty one they never wanted.
//
// The currency is optional: an account's first wallet has nothing to inherit
// from and takes the column default (EUR), which its owner changes on the
// profile page. A second wallet is handed the currency of the one its creator
// was looking at -- routes.js passes it.
//
// All of it in one transaction: the wallet, the membership and the starter
// rows either all exist or none do. Before, each was its own statement, and a
// failure halfway left a wallet nobody was a member of. `client` joins a
// transaction the caller already opened.
const createWalletWithStarterData = async (user, name, locale, currency, client = null) => {
  if (!client) {
    return db.transactionAuth((c) => createWalletWithStarterData(user, name, locale, currency, c));
  }
  const wallet = await wallets.create(name, user.id, currency, client);
  await db.withTenant({ userId: user.id, walletId: wallet.id, write: true, client }, () =>
    createInitialData(locale),
  );
  return wallet;
};

// A new account, and nothing else: no wallet (see above). Sign-up, an
// administrator adding somebody and the first boot all come through here.
//
// A duplicate username surfaces as Postgres' 23505, untouched, for the caller
// to turn into USERNAME_TAKEN.
// The username is the only name an account has: what you sign in with is also
// what the members list and the passkey prompt show (there is no separate
// display name).
const createAccount = async ({ username, passwordHash, locale, isAdmin = false }) => {
  const { rows } = await db.queryAuth(
    `INSERT INTO users (id, username, password_hash, locale, is_admin)
     VALUES (nextval('seq_users'), $1, $2, coalesce($3, 'en'), $4)
     RETURNING *`,
    [username, passwordHash, locale || null, isAdmin === true],
  );
  return { user: rows[0] };
};

// ---------------------------------------------------------------------------
// The instance's first user
// ---------------------------------------------------------------------------
// On a new instance there is no user at all: we create one, an
// administrator, from the BUSSOLA_AUTH_* credentials in .env, without asking
// the installer anything. Like any other new account it signs in to the
// picker and names its first wallet there. BUSSOLA_AUTH_USER is the username.
const usernameFromConfig = () => process.env.BUSSOLA_AUTH_USER || "admin";

const bootstrapFirstUser = async () => {
  const { rows: total } = await db.queryAuth("SELECT count(*)::int AS n FROM users");
  if (total[0].n > 0) return; // nothing to do

  const password = process.env.BUSSOLA_AUTH_PASS;
  if (!password) {
    throw new Error(
      "No user is configured and BUSSOLA_AUTH_PASS is not set: the first " +
        "account cannot be created. See example.env.",
    );
  }

  const username = usernameFromConfig();
  const hash = await hashPassword(password);
  const locale = process.env.BUSSOLA_DEFAULT_LOCALE || "en";

  await createAccount({ username, passwordHash: hash, locale, isAdmin: true });
  console.log(`[auth] first user created: ${username}.`);
};

module.exports = {
  bootstrapFirstUser,
  createInitialData,
  createAccount,
  createWalletWithStarterData,
};
