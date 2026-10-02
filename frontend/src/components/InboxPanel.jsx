import { mainColor, secondaryColor } from "../config";
import Amount from "./Amount";
import { useT } from "../i18n";
import { useCanWrite } from "../utils/useCanWrite";
import { canAcceptInboxItem, inboxOtherCurrency, missingInboxFields } from "../utils/transactionDraft";

// The inbox: bank notifications a phone sent (docs/notifications.md), each a
// draft waiting for somebody to confirm it. Nothing here writes a transaction:
// "Review" opens the ordinary form filled in with the draft, and only saving
// it there records anything. The page decides whether to show this at all --
// a read-only member never gets here.
//
// The amount goes through <Amount>, so bank mode hides it like any other.
//
// When the instance has a model that reads the notifications, an item is
// "Reading..." until it has (the page asks again every few seconds meanwhile),
// and "Could not read it" when it could not: still there, to be filled in by
// hand. The model's proposals carry no percentage, since it gives none.
const typeLabel = (t, code) =>
  code === "INCOME"
    ? t("common.income.one")
    : code === "TRANSFER"
      ? t("common.transfer")
      : code === "EXPENSE"
        ? t("common.expense.one")
        : null;

const typeColor = (code) =>
  code === "INCOME" ? "var(--positive)" : code === "TRANSFER" ? secondaryColor : "var(--negative)";

const Sure = ({ value }) => {
  const { t } = useT();
  if (value == null) return null;
  return <span style={styles.sure}>{t("inbox.confidence", { pct: Math.round(value * 100) })}</span>;
};

export default function InboxPanel({ items, onReview, onAccept, onDismiss, busyId, walletCurrency }) {
  const { t, formatDate } = useT();
  const canWrite = useCanWrite();

  if (!items.length) {
    return <div style={styles.empty}>{t("inbox.empty")}</div>;
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>{t("inbox.hint")}</p>
      <ul style={styles.list}>
        {items.map((item) => {
          const type = typeLabel(t, item.type_code);
          const reading = item.extraction === "pending";
          const otherCurrency = inboxOtherCurrency(item, walletCurrency);
          const missing = missingInboxFields(item);
          // An amount in another currency is only ever recorded through
          // Review, where it can be converted first.
          const acceptHint = missing.length
            ? t("inbox.acceptMissing", { what: missing.map((m) => t(`inbox.missing${m}`)).join(", ") })
            : otherCurrency
              ? t("inbox.otherCurrency", { currency: otherCurrency })
              : undefined;
          const acceptOff = !canAcceptInboxItem(item, walletCurrency) || busyId === item.id;
          return (
            <li key={item.id} style={styles.item}>
              <div style={styles.head}>
                <span style={styles.source}>
                  {t("inbox.received", {
                    source: item.source,
                    date: formatDate(new Date(item.received_at), { dateStyle: "short", timeStyle: "short" }),
                  })}
                </span>
                {item.amount != null && (
                  <Amount size={18} amount={item.amount} color={typeColor(item.type_code)} isAbs={true} />
                )}
              </div>
              <div style={styles.merchant}>
                {item.merchant || (reading ? t("inbox.reading") : t("inbox.noMerchant"))}
              </div>
              {item.raw_text && <div style={styles.raw}>{item.raw_text}</div>}
              {item.extraction === "failed" && <div style={styles.warn}>{t("inbox.readFailed")}</div>}
              {otherCurrency && (
                <div style={styles.warn}>{t("inbox.otherCurrency", { currency: otherCurrency })}</div>
              )}
              <div style={styles.proposal}>
                {reading ? (
                  <span style={styles.none} role="status">
                    {t("inbox.readingHint")}
                  </span>
                ) : type ? (
                  <span>
                    {type} <Sure value={item.confidence?.type} />
                  </span>
                ) : (
                  <span style={styles.none}>{t("inbox.noProposal")}</span>
                )}
                {item.from_name && (
                  <span>
                    {t("form.roleFrom")}: {item.from_name} <Sure value={item.confidence?.account} />
                  </span>
                )}
                {item.to_name && (
                  <span>
                    {t("form.roleTo")}: {item.to_name} <Sure value={item.confidence?.category} />
                  </span>
                )}
              </div>
              <div style={styles.actions}>
                {canWrite && (
                  <button
                    type="button"
                    style={{ ...styles.accept, ...(acceptOff ? styles.acceptOff : null) }}
                    disabled={acceptOff}
                    title={acceptHint}
                    aria-label={acceptHint ? `${t("inbox.accept")}. ${acceptHint}` : t("inbox.accept")}
                    onClick={() => onAccept(item)}
                  >
                    {t("inbox.accept")}
                  </button>
                )}
                <button
                  type="button"
                  style={styles.review}
                  disabled={busyId === item.id}
                  onClick={() => onReview(item)}
                >
                  {t("inbox.review")}
                </button>
                <button
                  type="button"
                  style={styles.dismiss}
                  disabled={busyId === item.id}
                  onClick={() => onDismiss(item)}
                >
                  {t("inbox.dismiss")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const styles = {
  container: { width: "100%", padding: "4px 12px 16px", boxSizing: "border-box" },
  hint: { margin: "4px 0 12px", fontSize: 13, color: "var(--text-muted)" },
  empty: { padding: 24, textAlign: "center", color: "var(--text-muted)" },
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 },
  item: {
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "10px 12px",
    background: "var(--surface)",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    minWidth: 0,
  },
  head: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 },
  source: { fontSize: 12, color: "var(--text-muted)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  merchant: { fontSize: 16, fontWeight: "bold", overflowWrap: "anywhere" },
  raw: { fontSize: 12, fontStyle: "italic", color: "var(--text-secondary)", overflowWrap: "anywhere" },
  proposal: { display: "flex", flexWrap: "wrap", gap: "2px 12px", fontSize: 13, color: "var(--text)" },
  none: { color: "var(--text-muted)" },
  warn: { fontSize: 12, color: "var(--negative)" },
  sure: { fontSize: 11, color: "var(--text-muted)" },
  actions: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 },
  accept: {
    padding: "6px 14px",
    borderRadius: 16,
    border: "none",
    background: "var(--positive-fill)",
    color: "white",
    fontWeight: "bold",
    cursor: "pointer",
  },
  acceptOff: { opacity: 0.45, cursor: "not-allowed" },
  review: {
    padding: "6px 14px",
    borderRadius: 16,
    border: "none",
    background: mainColor,
    color: "white",
    fontWeight: "bold",
    cursor: "pointer",
  },
  dismiss: {
    padding: "6px 14px",
    borderRadius: 16,
    border: "1px solid var(--border-strong)",
    background: "var(--surface)",
    color: "var(--text-secondary)",
    cursor: "pointer",
  },
};
