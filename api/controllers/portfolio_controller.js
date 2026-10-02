const db = require("../dbConn");
const holdings_controller = require("./holdings_controller");
const DataError = require("../services/dataError");

// Current allocation per pillar (Coletti's four pillars):
//  - investment accounts -> sum of their holdings, grouped by pillar;
//  - non-investment active accounts -> their whole actual balance goes to
//    Cash (pillar 1).
const computeCurrentAllocation = async () => {
  const { rows } = await db.query(
    `select
       p.id,
       p.code,
       p.name,
       p.color,
       coalesce(hold.total, 0)
         + case when p.id = 1 then coalesce(cash.total, 0) else 0 end as value
     from pillars p
     left join (
       select h.pillar_id as pid, sum(h.amount) as total
       from holdings h
       join accounts a on (h.account_id = a.id)
       where a.is_account and a.is_investment and not a.archived
       group by h.pillar_id
     ) hold on (hold.pid = p.id)
     left join (
       select sum(coalesce(a.actual_amount, a.amount)) as total
       from accounts a
       where a.is_account and not a.is_investment and not a.archived
     ) cash on (true)
     order by p.id`,
  );

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    color: r.color,
    value: Number(r.value) || 0,
  }));
};

exports.computeCurrentAllocation = computeCurrentAllocation;

exports.getAllocation = async () => {
  const data = await computeCurrentAllocation();
  const total = data.reduce((acc, d) => acc + d.value, 0);
  return { total, data };
};

// Current allocation grouped by one diversification dimension.
// `dim` must be in the whitelist (no SQL injection through a column name).
// Optional filters: pillar (int), types (csv of holding-type CODES).
exports.allocationByDimension = async ({ dim, pillar, types } = {}) => {
  const DIM = {
    type: { group: "t.name", color: "min(t.color)", code: "min(t.code)" },
    issuer: { group: "h.issuer", color: "null", code: "null" },
    country: { group: "h.country", color: "null", code: "null" },
    currency: { group: "h.currency", color: "null", code: "null" },
    broker: { group: "a.name", color: "min(a.color)", code: "null" },
    asset: { group: "h.name", color: "null", code: "null" },
  };
  const d = DIM[dim];
  if (!d) throw new DataError(400, "INVALID_REQUEST", "Invalid dimension");

  const where = ["a.is_account", "a.is_investment", "not a.archived"];
  const params = [];

  const hasPillar = pillar != null && pillar !== "";
  if (hasPillar) {
    params.push(Number(pillar));
    where.push(`h.pillar_id = $${params.length}`);
  }

  // Filter on the stable code, never on the name: the name is display text.
  const typeCodes = types
    ? String(types)
        .split(",")
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean)
    : [];
  if (typeCodes.length) {
    params.push(typeCodes);
    where.push(`t.code = ANY($${params.length})`);
  }

  const { rows } = await db.query(
    `select ${d.group} as name,
            ${d.color} as color,
            ${d.code} as code,
            sum(h.amount) as value
     from holdings h
     join accounts a on (h.account_id = a.id)
     left join pillars p on (h.pillar_id = p.id)
     left join holding_types t on (h.type_id = t.id)
     where ${where.join(" and ")}
     group by ${d.group}
     having sum(h.amount) > 0
     order by value desc`,
    params,
  );

  // A null name means the field was never filled in. It stays null all the way
  // to the interface, which labels it in the reader's own language rather than
  // having a fixed word baked in here.
  const data = rows.map((r) => ({
    name: r.name ?? null,
    code: r.code ?? null,
    color: r.color,
    value: Number(r.value) || 0,
  }));

  // For the unfiltered type breakdown, add the cash held in non-investment
  // accounts as its own group, consistent with pillar 1.
  if (dim === "type" && !hasPillar && !typeCodes.length) {
    const { rows: cash } = await db.query(
      `select coalesce(sum(coalesce(a.actual_amount, a.amount)), 0) as total
       from accounts a
       where a.is_account and not a.is_investment and not a.archived`,
    );
    const total = Number(cash[0].total) || 0;
    if (total > 0) {
      // If a CASH type already exists (cash sitting inside investment
      // accounts), add to it instead of drawing a second slice.
      const existing = data.find((x) => x.code === "CASH");
      if (existing) existing.value += total;
      else data.push({ name: "Cash", code: "CASH", color: "#90a4ae", value: total });
      data.sort((a, b) => b.value - a.value);
    }
  }

  const total = data.reduce((acc, x) => acc + x.value, 0);
  return { total, data };
};

// History for the trend chart: one row per period with the total plus the
// value per pillar. Pillar names and colours come from the allocation donut.
exports.getHistory = async () => {
  const { rows } = await db.query(
    `select year, month, total, value_p1, value_p2, value_p3, value_p4
     from portfolio_snapshots
     order by year, month`,
  );
  return rows;
};

// The diversification dimensions frozen into a snapshot: the same keys and
// filters as the donuts on the portfolio page (see DIVERSIF_CHARTS in the
// frontend). The type filters are codes, so they survive a language change.
const DIVERSIF_SNAPSHOT = [
  { key: "type", args: { dim: "type" } },
  { key: "broker", args: { dim: "broker" } },
  { key: "issuer_etf", args: { dim: "issuer", types: "ETF,ETN,ETP" } },
  { key: "bond_country", args: { dim: "country", pillar: 3 } },
  { key: "bond_issuer", args: { dim: "issuer", pillar: 3 } },
  { key: "equity_country", args: { dim: "country", pillar: 4 } },
  { key: "equity_issuer", args: { dim: "issuer", pillar: 4 } },
  { key: "equity_currency", args: { dim: "currency", pillar: 4 } },
  { key: "crypto", args: { dim: "asset", types: "CRYPTO" } },
];

// Builds the portfolio's complete frozen state: every diversification donut
// plus the list of active accounts with their holdings.
//
// No try/catch around each donut: the dimensions are the constants above, so
// the only thing that can fail is a statement, and a failed statement aborts
// the whole transaction -- every later query would fail as well, so a catch
// here could never leave the donut empty and carry on. The error goes up and
// the transaction rolls back: no snapshot rather than a half-written one.
const buildDetail = async () => {
  const diversification = {};
  for (const d of DIVERSIF_SNAPSHOT) {
    diversification[d.key] = await exports.allocationByDimension(d.args);
  }

  const { rows: accounts } = await db.query(
    `select a.id, a.name, a.color, a.icon, a.icon_family, a.amount,
            a.actual_amount, a.is_investment, a.is_current,
            t.code as type_code, t.name as type_name
     from accounts a
     join account_types t on (a.type_id = t.id)
     where a.is_account and not a.archived
     order by a.amount desc`,
  );

  const accountDetail = [];
  for (const a of accounts) {
    const raw = a.is_investment ? await holdings_controller.getHoldings(a.id) : [];
    // amount = current value (quantity x current_price); cost = the amount
    // actually invested (quantity x purchase_price), null when not computable.
    const holdings = raw.map((h) => ({
      ...h,
      cost:
        h.quantity != null && h.purchase_price != null
          ? Number(h.quantity) * Number(h.purchase_price)
          : null,
    }));
    accountDetail.push({ ...a, holdings });
  }

  return { diversification, accounts: accountDetail };
};

// ---------------------------------------------------------------------------
// What a snapshot's month means
// ---------------------------------------------------------------------------
// A snapshot is the portfolio as it is at the moment it is taken, labelled with
// the month it is taken IN. The scheduled one runs on the 1st (SNAPSHOT_CRON,
// cron.js), so the row labelled June holds the values at the opening of June,
// which are also the values at the close of May. Nothing here reconstructs the
// past: there is no price history to do it with.
//
// The body may name the year and month to label it with (a manual snapshot
// re-labelled to the month it stands for); either one left out is the current
// one. Taking one again for the same month replaces it: one row per wallet and
// month, UNIQUE(wallet_id, year, month). Both are checked before anything is
// computed, so month 13 or year "abc" is a 400 INVALID_SNAPSHOT_PERIOD and
// nothing is written.
const SNAPSHOT_MIN_YEAR = 1900;
const SNAPSHOT_MAX_YEAR = 2999;

const snapshotPart = (value, fallback, min, max, what) => {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new DataError(400, "INVALID_SNAPSHOT_PERIOD", `The snapshot's ${what} is not valid`);
  }
  return n;
};

exports.snapshotPeriod = (body = {}, now = new Date()) => ({
  year: snapshotPart(body.year, now.getFullYear(), SNAPSHOT_MIN_YEAR, SNAPSHOT_MAX_YEAR, "year"),
  month: snapshotPart(body.month, now.getMonth() + 1, 1, 12, "month"),
});

// Computes the current allocation and upserts the snapshot for that month,
// with the frozen detail.
exports.createSnapshot = async (body = {}) => {
  const { year, month } = exports.snapshotPeriod(body);

  const allocation = await computeCurrentAllocation();
  const byPillar = {};
  allocation.forEach((p) => {
    byPillar[p.id] = p.value;
  });
  const total = allocation.reduce((acc, p) => acc + p.value, 0);

  const detail = await buildDetail();

  await db.query(
    `insert into portfolio_snapshots
       (id, year, month, total, value_p1, value_p2, value_p3, value_p4, detail)
     values (nextval('seq_portfolio_snapshots'), $1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (wallet_id, year, month)
     do update set total      = excluded.total,
                   value_p1   = excluded.value_p1,
                   value_p2   = excluded.value_p2,
                   value_p3   = excluded.value_p3,
                   value_p4   = excluded.value_p4,
                   detail     = excluded.detail,
                   created_at = CURRENT_TIMESTAMP`,
    [year, month, total, byPillar[1] || 0, byPillar[2] || 0, byPillar[3] || 0, byPillar[4] || 0, detail],
  );

  return { year, month, total, data: allocation };
};

// One snapshot's detail: rebuilds the allocation donut from the per-pillar
// values (always available, even for old rows) and returns the frozen state
// (diversification + accounts) when there is one.
exports.getSnapshotDetail = async (year, month) => {
  const { rows } = await db.query(
    `select year, month, total, value_p1, value_p2, value_p3, value_p4, detail
     from portfolio_snapshots
     where year = $1 and month = $2`,
    [Number(year), Number(month)],
  );
  if (rows.length === 0) return null;
  const r = rows[0];

  const { rows: pillars } = await db.query(`select id, code, name, color from pillars order by id`);
  const byPillar = { 1: r.value_p1, 2: r.value_p2, 3: r.value_p3, 4: r.value_p4 };

  const allocation = {
    total: Number(r.total) || 0,
    data: pillars.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      color: p.color,
      value: Number(byPillar[p.id]) || 0,
    })),
  };

  const detail = r.detail || {};
  return {
    year: r.year,
    month: r.month,
    total: Number(r.total) || 0,
    allocation,
    diversification: detail.diversification || null,
    accounts: detail.accounts || null,
  };
};
