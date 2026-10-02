import { useContext, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FaChevronLeft } from "react-icons/fa";
import GlobalContext from "../context/GlobalContext";
import Loading from "../components/Loading";
import CategoryPieChart from "../components/CategoryPieChart";
import { Blurrable, currencyFormat } from "../components/Amount";
import { mainColor, secondaryColor } from "../config";
import { DIVERSIF_CHARTS, DIVERSIF_GROUPS, toDonut } from "../utils/portfolioConfig";
import { useT } from "../i18n";

// A read-only view: it rebuilds the portfolio page from the frozen snapshot
// (pillar donut, diversification, and the accounts/holdings as of that date).
export default function SnapshotDetail() {
  const { fetchAuth } = useContext(GlobalContext);
  const { t, tLookup, monthName, formatPercent } = useT();
  const navigate = useNavigate();
  const { year, month } = useParams();
  const [isLoading, setLoading] = useState(true);
  const [snap, setSnap] = useState(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        const res = await fetchAuth(`/portfolio/snapshot/${year}/${month}`);
        if (!active) return;
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        if (res.ok) setSnap(await res.json());
      } catch (e) {
        console.error(e);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month]);

  const label = `${monthName(Number(month))} ${year}`;

  const fmtPct = (v) => (v == null ? null : `${formatPercent(v)}%`);

  if (isLoading) return <Loading />;

  const allocDonut = (snap?.allocation?.data || [])
    .filter((d) => Number(d.value) > 0)
    .map((d) => ({ name: tLookup(d), color: d.color, total: d.value }));

  const diversif = snap?.diversification || null;
  const accounts = snap?.accounts || null;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <button
          type="button"
          onClick={() => navigate("/portfolio")}
          style={styles.backBtn}
        >
          <FaChevronLeft size={16} />
          <span>{t("portfolio.title")}</span>
        </button>
        <div style={styles.title}>
          {t("portfolio.snapshot")} {label}
        </div>
        <div style={{ width: 120 }} />
      </div>

      {notFound ? (
        <div style={{ color: secondaryColor, fontSize: 16, marginTop: 24 }}>
          {t("portfolio.snapshotNotFound")}
        </div>
      ) : (
        <div style={styles.wrapper}>
          {/* The headline of the screen. Every figure below it is hidden in
              bank mode, so leaving the largest one in the open would defeat
              all of them at once. */}
          <div style={styles.total}>
            <Blurrable>{currencyFormat(snap?.total || 0)}</Blurrable>
          </div>

          <div style={styles.sectionTitle}>{t("portfolio.assetAllocation")}</div>
          <CategoryPieChart
            data={allocDonut}
            title={t("portfolio.pillars")}
            total={snap?.allocation?.total}
          />

          {diversif ? (
            <>
              <div style={styles.sectionTitle}>{t("portfolio.diversification")}</div>
              {DIVERSIF_GROUPS.map((groupKey) => {
                const charts = DIVERSIF_CHARTS.filter(
                  (c) => c.groupKey === groupKey && (diversif[c.key]?.data || []).length > 0,
                );
                if (charts.length === 0) return null;
                return (
                  <div key={groupKey} style={styles.diversifGroup}>
                    <div style={styles.diversifGroupTitle}>{t(groupKey)}</div>
                    <div style={styles.diversifRow}>
                      {charts.map((c) => (
                        <div key={c.key} style={styles.diversifCell}>
                          <CategoryPieChart
                            data={toDonut(diversif[c.key], tLookup)}
                            title={t(c.titleKey)}
                            total={diversif[c.key]?.total}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </>
          ) : (
            <div style={styles.notice}>{t("portfolio.partialSnapshot")}</div>
          )}

          {accounts && accounts.length > 0 && (
            <>
              <div style={styles.sectionTitle}>{t("portfolio.accountsAtDate")}</div>
              <div style={styles.accountList}>
                {accounts.map((c) => {
                  const imp = Number(c.amount) || 0;
                  const eff = c.actual_amount != null ? Number(c.actual_amount) : imp;
                  const showEff = c.is_investment && Math.abs(eff - imp) >= 0.005;
                  const gain =
                    showEff && imp > 0 ? ((eff - imp) / imp) * 100 : null;
                  return (
                    <div key={c.id} style={styles.accountBox}>
                      <div style={styles.accountHeader}>
                        <span
                          style={{ ...styles.accountDot, backgroundColor: c.color || "#888" }}
                        />
                        <span style={styles.accountName}>{c.name}</span>
                        <span style={styles.accountType}>
                          {tLookup({ code: c.type_code, name: c.type_name })}
                        </span>
                        <div style={styles.accountValues}>
                          <span style={styles.accountAmount}>
                            <Blurrable>{currencyFormat(eff)}</Blurrable>
                          </span>
                          {showEff && (
                            <span style={styles.accountSub}>
                              {t("common.cost")}{" "}
                              <Blurrable>{currencyFormat(imp)}</Blurrable>
                              {gain != null && (
                                <span
                                  style={{ color: gain >= 0 ? "var(--positive)" : "var(--negative)" }}
                                >
                                  {" "}
                                  · {fmtPct(gain)}
                                </span>
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                      {c.holdings && c.holdings.length > 0 && (
                        <div style={styles.holdingList}>
                          {c.holdings.map((h) => (
                            <div key={h.id} style={styles.holdingRow}>
                              <div style={styles.holdingLeft}>
                                <span style={styles.holdingName}>
                                  {h.name}
                                  {h.type_code || h.type_name ? (
                                    <span style={styles.holdingType}>
                                      {" "}
                                      · {tLookup({ code: h.type_code, name: h.type_name })}
                                    </span>
                                  ) : null}
                                </span>
                                {h.purchase_date && (
                                  <span style={styles.holdingDate}>
                                    {t("common.since")} {String(h.purchase_date).slice(0, 10)}
                                  </span>
                                )}
                              </div>
                              <div style={styles.holdingRight}>
                                <span style={styles.holdingAmount}>
                                  <Blurrable>{currencyFormat(h.amount)}</Blurrable>
                                </span>
                                {(h.cost != null || h.total_return != null) && (
                                  <span style={styles.holdingSub}>
                                    {h.cost != null && (
                                      <>
                                        {t("common.cost")}{" "}
                                        <Blurrable>{currencyFormat(h.cost)}</Blurrable>
                                      </>
                                    )}
                                    {h.total_return != null && (
                                      <span
                                        style={{
                                          color: Number(h.total_return) >= 0 ? "var(--positive)" : "var(--negative)",
                                        }}
                                      >
                                        {h.cost != null ? " · " : ""}
                                        {fmtPct(h.total_return)}
                                      </span>
                                    )}
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    backgroundColor: "var(--bg)",
    alignItems: "center",
    width: "90%",
    margin: "0 auto",
  },
  header: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    marginTop: 10,
  },
  title: {
    fontSize: 22,
    fontWeight: "bold",
    textAlign: "center",
  },
  backBtn: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    border: `1px solid ${mainColor}`,
    background: "var(--surface)",
    color: mainColor,
    fontSize: 16,
    fontWeight: "bold",
    cursor: "pointer",
    borderRadius: 20,
    padding: "8px 16px",
    width: 120,
    boxSizing: "border-box",
  },
  wrapper: {
    width: "100%",
    marginTop: 12,
  },
  total: {
    fontSize: 30,
    fontWeight: "bold",
    textAlign: "center",
    margin: "6px 0 4px",
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "bold",
    textAlign: "center",
    marginBottom: 6,
    marginTop: 18,
  },
  notice: {
    color: secondaryColor,
    fontSize: 14,
    textAlign: "center",
    marginTop: 8,
  },
  diversifGroup: {
    marginTop: 12,
  },
  diversifGroupTitle: {
    fontSize: 15,
    fontWeight: "bold",
    color: "var(--text-secondary)",
    margin: "8px 0 4px",
    borderLeft: `4px solid ${mainColor}`,
    paddingLeft: 8,
  },
  diversifRow: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
  },
  diversifCell: {
    flex: "1 1 320px",
    maxWidth: 460,
    minWidth: 280,
  },
  accountList: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    marginBottom: 32,
  },
  accountBox: {
    border: "1px solid var(--border-soft)",
    borderRadius: 8,
    padding: "8px 10px",
  },
  accountHeader: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  accountDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    flexShrink: 0,
  },
  accountName: {
    fontSize: 15,
    fontWeight: "bold",
    color: "var(--text)",
  },
  accountType: {
    fontSize: 12,
    color: "var(--text-subtle)",
    flex: 1,
  },
  accountValues: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
  },
  accountAmount: {
    fontSize: 15,
    fontWeight: "bold",
    textAlign: "right",
  },
  accountSub: {
    fontSize: 12,
    color: "var(--text-subtle)",
    textAlign: "right",
  },
  holdingList: {
    marginTop: 6,
    paddingLeft: 20,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  holdingRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    fontSize: 13,
    color: "var(--text-secondary)",
    gap: 10,
  },
  holdingLeft: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minWidth: 0,
  },
  holdingName: {
    fontWeight: 500,
  },
  holdingType: {
    color: "var(--text-subtle)",
    fontWeight: 400,
  },
  holdingDate: {
    fontSize: 11,
    color: "var(--text-subtle)",
  },
  holdingRight: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    minWidth: 120,
  },
  holdingAmount: {
    fontWeight: "bold",
    textAlign: "right",
  },
  holdingSub: {
    fontSize: 11,
    color: "var(--text-subtle)",
    textAlign: "right",
  },
};
