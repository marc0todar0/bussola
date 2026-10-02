// Configuration shared by the portfolio page (live data) and a snapshot's
// detail (data frozen in JSON). The diversification charts' `key` values match
// the ones the API stores inside a snapshot.

// A cycling palette for dimensions with no colour of their own (country,
// issuer, and so on).
export const PALETTE = [
  "#42a5f5",
  "#66bb6a",
  "#ffa726",
  "#ef5350",
  "#ab47bc",
  "#26c6da",
  "#ffca28",
  "#8d6e63",
  "#ec407a",
  "#7e57c2",
  "#9ccc65",
  "#5c6bc0",
];

// Diversification charts: each entry is one donut. `url` is used only by the
// live page; the snapshot detail reads by `key` from the stored JSON.
//
// `titleKey` and `groupKey` are translation keys rather than text: these
// headings are the only part of this file the reader ever sees.
export const DIVERSIF_CHARTS = [
  {
    key: "type",
    titleKey: "portfolio.chart.byType",
    groupKey: "portfolio.group.general",
    url: "/portfolio/allocation/type",
  },
  {
    key: "broker",
    titleKey: "portfolio.chart.byBroker",
    groupKey: "portfolio.group.general",
    url: "/portfolio/allocation/broker",
  },
  {
    key: "issuer_etf",
    titleKey: "portfolio.chart.etfByIssuer",
    groupKey: "portfolio.group.general",
    url: "/portfolio/allocation/issuer?types=ETF,ETN,ETP",
  },
  {
    key: "bond_country",
    titleKey: "portfolio.chart.byCountry",
    groupKey: "portfolio.group.bonds",
    url: "/portfolio/allocation/country?pillar=3",
  },
  {
    key: "bond_issuer",
    titleKey: "portfolio.chart.byIssuer",
    groupKey: "portfolio.group.bonds",
    url: "/portfolio/allocation/issuer?pillar=3",
  },
  {
    key: "equity_country",
    titleKey: "portfolio.chart.byRegion",
    groupKey: "portfolio.group.equities",
    url: "/portfolio/allocation/country?pillar=4",
  },
  {
    key: "equity_issuer",
    titleKey: "portfolio.chart.byIssuer",
    groupKey: "portfolio.group.equities",
    url: "/portfolio/allocation/issuer?pillar=4",
  },
  {
    key: "equity_currency",
    titleKey: "portfolio.chart.byCurrency",
    groupKey: "portfolio.group.equities",
    url: "/portfolio/allocation/currency?pillar=4",
  },
  {
    key: "crypto",
    titleKey: "portfolio.chart.byAsset",
    groupKey: "portfolio.group.crypto",
    url: "/portfolio/allocation/asset?types=CRYPTO",
  },
];

export const DIVERSIF_GROUPS = [
  "portfolio.group.general",
  "portfolio.group.bonds",
  "portfolio.group.equities",
  "portfolio.group.crypto",
];

// Maps a {data:[{name, code, color, value}]} response into the shape
// CategoryPieChart expects, filling in palette colours where the dimension has
// none of its own (country/issuer/currency...).
//
// `translate` turns a lookup code into the reader's language and is also what
// names an unfilled value, which arrives as null from the API.
export const toDonut = (alloc, translate) =>
  (alloc?.data || []).map((d, i) => ({
    name: translate ? translate(d) : d.name,
    color: d.color || PALETTE[i % PALETTE.length],
    total: d.value,
  }));
