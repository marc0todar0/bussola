const db = require("../dbConn");
const { dayRange, monthRange, monthOf, rangeSql, yearOf, yearRange } = require("../services/period");

// Type ids: 1 = expense, 2 = income, 3 = transfer. -1 is not a type but the
// synthetic "difference" series the chart draws alongside the other two.
const EXPENSE = 1;
const INCOME = 2;
const DIFFERENCE = -1;

const and = (predicates) => (predicates.length ? predicates.join(" and ") : "true");

// The year chart: income, expenses and their difference, month by month.
//
// One pass over the period. It used to be three -- one per series, each a
// left join from a generated list of months with extract(month) in the join
// condition -- and a UNION on top. The months with nothing in them are filled
// in here instead, as zeros rather than gaps. Transfers move money between
// the wallet's own accounts and count in neither series, so the difference is
// income minus expenses, as it always was.
exports.getChartData = async (req) => {
  const params = [];
  const where = rangeSql("tx_date", dayRange(req.query), params);

  const { rows } = await db.query(
    `select extract(month from tx_date)::int as month,
            coalesce(sum(amount) filter (where type_id = 1), 0) as expenses,
            coalesce(sum(amount) filter (where type_id = 2), 0) as income
       from transactions
      where ${and(where)}
      group by 1`,
    params,
  );

  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const series = (typeCode, typeId, pick) =>
    Array.from({ length: 12 }, (_, i) => {
      const r = byMonth.get(i + 1);
      return { month: i + 1, type_code: typeCode, type_id: typeId, total: r ? pick(r) : 0 };
    });

  const expenses = series("EXPENSE", EXPENSE, (r) => r.expenses);
  const income = series("INCOME", INCOME, (r) => r.income);
  const difference = series("DIFFERENCE", DIFFERENCE, (r) => r.income - r.expenses);

  const sumTotals = (list) => list.reduce((acc, c) => acc + c.total, 0);

  return {
    difference,
    expenses,
    income,
    totals: {
      difference: sumTotals(difference),
      income: sumTotals(income),
      expenses: sumTotals(expenses),
    },
  };
};

// Both the monthly and the yearly view group the same way; only the period
// differs. The period is a range on tx_date rather than extract(year) and
// extract(month), which no index can serve: every call used to read the
// wallet's whole history to keep one month of it. And the totals are made
// before the join with the categories, not after -- joined first, the planner
// re-read the accounts table once per transaction.
const totalsByCategory = async (range) => {
  const params = [];
  const where = rangeSql("tx_date", range, params);
  const { rows } = await db.query(
    `with s as (
       select type_id, to_id, sum(amount) as category_total
         from transactions
        where ${and(where)}
        group by type_id, to_id
     )
     select s.type_id, s.to_id, a.name, a.color, a.icon, a.icon_family, s.category_total
       from s
       join accounts a on (a.id = s.to_id)`,
    params,
  );
  return rows;
};

const splitByType = (sums) => ({
  expenses: withTotal(sums.filter((c) => c.type_id == EXPENSE)),
  income: withTotal(sums.filter((c) => c.type_id == INCOME)),
  transfer: withTotal(sums.filter((c) => c.type_id == 3)),
});

exports.getMonthlyData = async (req) => {
  const year = yearOf(req.query.year);
  const month = monthOf(req.query.month);
  const sums = await totalsByCategory(monthRange(year, month));
  return { year, month, ...splitByType(sums) };
};

exports.getYearlyData = async (req) => {
  const year = yearOf(req.query.year);
  const sums = await totalsByCategory(yearRange(year));
  return { year, ...splitByType(sums) };
};

const withTotal = (rows) => ({
  data: rows,
  total: rows.reduce((acc, row) => acc + row.category_total, 0),
});
