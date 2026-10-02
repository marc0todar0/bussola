import { memo, useState } from "react";
import IconItem from "./IconItem";
import Amount from "./Amount";
import MyIcon from "./MyIcon";
import { parseDateyyyymmdd } from "../utils/generic";
import { secondaryColor } from "../config";

// "YYYYMMDD" -> "dd/mm", for the flat list where the day heading is missing.
const formatShortDate = (txDate) => {
  if (!txDate) return "";
  const dd = parseDateyyyymmdd(txDate);
  return `${String(dd.day).padStart(2, "0")}/${String(dd.month).padStart(2, "0")}`;
};

const TransactionRow = ({ item, styles: s, onPress, showDate }) => {
  const [showNote, setShowNote] = useState(false);

  const isTransfer = item.type_id == 3;
  const isExpense = item.type_id == 1;

  const from = {
    icon: item.from_icon,
    family: item.from_icon_family,
    color: item.from_color,
    name: item.from_name,
  };
  const to = {
    icon: item.to_icon,
    family: item.to_icon_family,
    color: item.to_color,
    name: item.to_name,
  };

  const hasNote = !!(item.description && item.description.trim());

  return (
    <div
      data-nav-row
      style={{ ...s, ...styles.container, cursor: "pointer", position: "relative" }}
      onClick={() => onPress(item)}
      onMouseEnter={() => hasNote && setShowNote(true)}
      onMouseLeave={() => setShowNote(false)}
    >
      {hasNote && showNote && (
        <div style={styles.tooltip}>
          {item.description}
          <div style={styles.tooltipArrow} />
        </div>
      )}
      <div style={styles.leftContainer}>
        <div
          onClick={(e) => {
            e.stopPropagation();
            if (hasNote) setShowNote((v) => !v);
          }}
          style={{ cursor: hasNote ? "help" : "default" }}
        >
          <IconItem
            icon={from.icon}
            family={from.family}
            color={from.color}
            size={40}
            width="clamp(42px, 13vw, 58px)"
            height="clamp(38px, 11.5vw, 50px)"
            styles={{ marginRight: "clamp(8px, 2.8vw, 14px)", flexShrink: 0 }}
          />
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-evenly",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <div
            style={{
              textAlign: "start",
              fontWeight: "bold",
              // proportional: at a fixed 21px "Banca Cartesio" wrapped at 375px
              fontSize: "clamp(15px, 4.6vw, 21px)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {from.name}
          </div>
          <div style={{ display: "flex", flexDirection: "row" }}>
            <MyIcon icon={to.icon} family={to.family} size={24} color={to.color} />
            <div
              style={{
                textAlign: "center",
                textAlignVertical: "center",
                fontSize: "clamp(13px, 3.9vw, 18px)",
                marginLeft: 5,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {to.name}
            </div>
          </div>
        </div>
      </div>
      <div style={styles.rightContainer}>
        {showDate && <div style={styles.txDate}>{formatShortDate(item.tx_date)}</div>}
        <Amount
          amount={isExpense ? item.amount * -1 : item.amount}
          isAbs={isTransfer}
          color={isTransfer ? "var(--neutral)" : null}
          size={18}
        />
      </div>
    </div>
  );
};

const styles = {
  container: {
    backgroundColor: "var(--row-bg)",
    // minHeight, not height: with enlarged system fonts the text wraps, and a
    // fixed height (minus the padding) pushed it out of the row
    minHeight: 80,
    display: "flex",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
    padding: "12px 16px",
    border: "solid",
    borderBottomWidth: 1,
    borderColor: "var(--border)",
  },
  leftContainer: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    // minWidth:0 lets the name shrink instead of pushing the amount out
    minWidth: 0,
  },
  rightContainer: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    justifyContent: "center",
    // the amount must never break between the digits and the symbol
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  txDate: {
    fontSize: 12,
    color: secondaryColor,
    marginBottom: 2,
  },
  tooltip: {
    position: "absolute",
    bottom: "calc(100% - 6px)",
    left: 24,
    maxWidth: 280,
    backgroundColor: "var(--tooltip-bg)",
    color: "var(--tooltip-text)",
    fontSize: 14,
    fontWeight: "normal",
    lineHeight: 1.35,
    padding: "8px 12px",
    borderRadius: 8,
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
    zIndex: 20,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    textAlign: "left",
    pointerEvents: "none",
  },
  tooltipArrow: {
    position: "absolute",
    top: "100%",
    left: 18,
    width: 10,
    height: 10,
    backgroundColor: "var(--tooltip-bg)",
    transform: "translateY(-50%) rotate(45deg)",
  },
};

// memo: the props (item, styles, onPress) are stable, so opening the form does
// not re-render every row in the list.
export default memo(TransactionRow);
