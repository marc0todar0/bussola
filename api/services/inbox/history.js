// ---------------------------------------------------------------------------
// The wallet's own history, as context for the notification reader
// ---------------------------------------------------------------------------
// A notification says "Paid €12.40 at Esselunga"; the wallet recorded
// "Esselunga" forty times, as groceries paid from the current account. That
// is told to the model (extract.js) as one line of context -- it is not a
// rule, and the model may well decide otherwise.
//
// A past description matches when the notification contains it, whatever
// the language: no words are parsed out of the text. Runs through db.query,
// inside the tenant transaction the caller opened: RLS narrows it to the
// wallet, and nothing here filters by wallet on its own.
const db = require("../../dbConn");

const TYPE_NAMES = { EXPENSE: "expense", INCOME: "income", TRANSFER: "transfer" };

// Up to `limit` past (description, type, counterpart, account) combinations
// whose description appears in `text`, the most frequent first.
const similarPast = async (text, limit = 3) => {
  if (!text) return [];
  const { rows } = await db.query(
    `with n as (select unaccent(lower($1::text)) as text)
     select min(btrim(t.description)) as description, tt.code as type,
            c.name as counterpart, a.name as account, count(*)::int as count
       from transactions t
       cross join n
       join transaction_types tt on (tt.id = t.type_id)
       join accounts c on (c.id = t.to_id and c.wallet_id = t.wallet_id and not c.archived)
       join accounts a on (a.id = t.from_id and a.wallet_id = t.wallet_id and not a.archived)
      where length(btrim(t.description)) >= 3
        and strpos(n.text, unaccent(lower(btrim(t.description)))) > 0
      group by lower(btrim(t.description)), tt.code, c.name, a.name
      order by count(*) desc, max(t.tx_date) desc
      limit $2`,
    [text, limit],
  );
  return rows.map((r) => ({ ...r, type: TYPE_NAMES[r.type] || String(r.type).toLowerCase() }));
};

module.exports = { similarPast };
