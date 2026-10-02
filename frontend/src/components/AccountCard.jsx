import Amount from "./Amount";
import IconItem from "./IconItem";
import { FaSync } from "react-icons/fa";
import { useT } from "../i18n";

// quotesOff: the instance has no quote service. The badge still shows how
// many holdings would be refreshed, but it is dimmed and does nothing, and its
// tooltip says why.
const AccountCard = ({ account, handleTouch, onRefresh, refreshing, quotesOff = false }) => {
  const { t } = useT();
  const {
    id,
    name,
    amount,
    color,
    icon,
    icon_family,
    actual_amount,
    is_current,
    is_investment,
    n_asset_refresh,
  } = account;

  const nRefresh = Number(n_asset_refresh) || 0;

  return (
    <div data-nav-row onClick={() => handleTouch(account)} style={styles.container}>
      <IconItem icon={icon} family={icon_family} color={color} />
      <div
        style={{
          borderBottomColor: "var(--border-card)",
          padding: 10,
          margin: "0 auto",
          flex: 1,
          flexDirection: "column",
          justifyContent: "flex-start",
          alignItems: "flex-start",
          display: "flex",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          <div style={{ fontSize: 20 }}>{name}</div>
          {is_current ? <span style={styles.badgeCurrent}>{t("account.badge.current")}</span> : null}
          {is_investment ? (
            <span style={styles.badgeInvest}>{t("account.badge.investment")}</span>
          ) : null}
          {onRefresh && nRefresh > 0 ? (
            <span
              onClick={(e) => {
                // Stopped even when disabled: a click on the badge is not a
                // click on the card, which would open the account.
                e.stopPropagation();
                if (!refreshing && !quotesOff) onRefresh(id);
              }}
              style={{
                ...styles.badgeRefresh,
                cursor: refreshing || quotesOff ? "default" : "pointer",
                opacity: quotesOff ? 0.4 : refreshing ? 0.6 : 1,
              }}
              aria-disabled={quotesOff || undefined}
              title={quotesOff ? t("quotes.disabled") : t("account.refreshQuotes")}
            >
              <FaSync
                size={10}
                style={refreshing ? { animation: "spin 0.8s linear infinite" } : undefined}
              />
              {nRefresh}
            </span>
          ) : null}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            justifyContent: "space-between",
            width: "90%",
          }}
        >
          <Amount size={20} amount={amount} />
          {actual_amount && actual_amount !== amount ? (
            <Amount
              size={20}
              amount={actual_amount - amount}
              color={actual_amount >= amount ? "var(--positive)" : "var(--negative)"}
              forceSign={true}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default AccountCard;

const styles = {
  container: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "flex-start",
    alignItems: "center",
    margin: 20,
    padding: 10,
    border: "1px solid var(--border-card)",
    borderRadius: 10,
    cursor: "pointer",
  },
  badgeCurrent: {
    fontSize: 11,
    fontWeight: "bold",
    color: "white",
    backgroundColor: "dodgerblue",
    borderRadius: 8,
    padding: "1px 6px",
  },
  badgeInvest: {
    fontSize: 11,
    fontWeight: "bold",
    color: "white",
    backgroundColor: "#8e24aa",
    borderRadius: 8,
    padding: "1px 6px",
  },
  badgeRefresh: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    fontWeight: "bold",
    color: "white",
    backgroundColor: "#1e88e5",
    borderRadius: 8,
    padding: "1px 6px",
  },
};
