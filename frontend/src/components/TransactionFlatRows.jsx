import { memo } from "react";
import { secondaryColor } from "../config";
import TransactionRow from "./TransactionRow";

// A flat list with no per-day grouping: used when the sort is by amount, where
// daily groups would no longer mean anything. The date therefore moves onto
// every row (TransactionRow's showDate prop).
const TransactionFlatRows = ({ items, onPress }) => (
  <div style={styles.container}>
    {items.map((item) => (
      <TransactionRow key={item.id} styles={styles.row} item={item} onPress={onPress} showDate />
    ))}
  </div>
);

// The same keys as TransactionDayRows: styles.row is merged underneath
// TransactionRow's own styles.container, which overrides
// backgroundColor/height/padding.
const styles = {
  container: {
    flex: 1,
    width: "100%",
    display: "flex",
    flexDirection: "column",
  },
  row: {
    backgroundColor: secondaryColor,
    height: 50,
    flexDirection: "row",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
  },
};

export default memo(TransactionFlatRows);
