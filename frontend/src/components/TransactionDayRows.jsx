import { memo } from "react";
import { secondaryColor } from "../config";
import { parseDateyyyymmdd } from "../utils/generic";
import TransactionRow from "./TransactionRow";
import Amount from "./Amount";
import { useT } from "../i18n";

const TransactionDayRows = ({ items, date, onPress }) => {
  const { monthName, weekdayName } = useT();
  const dd = parseDateyyyymmdd(date);

  let sum = 0;
  for (const k of items) {
    if (k.type_id == 1) sum -= k.amount;
    else if (k.type_id == 2) sum += k.amount;
  }

  return (
    <div style={styles.container}>
      <div style={styles.row}>
        <div style={styles.dateBlock}>
          <div style={styles.dayNumber}>{dd.day}</div>
          <div style={styles.dayLabels}>
            <div style={styles.dayWeek}>{weekdayName(dd.dd).toUpperCase()}</div>
            <div style={styles.monthYear}>{`${monthName(dd.month)} ${dd.year}`}</div>
          </div>
        </div>
        <Amount style={{ flex: 1 }} amount={sum} isAbs={false} size={30} />
      </div>
      {/* Already in order: the API sorts a day's rows by when they were last
          touched, newest first, and a page never splits a day. */}
      <div style={styles.container}>
        {items.map((item) => (
          <TransactionRow key={item.id} styles={styles.row} item={item} onPress={onPress} />
        ))}
      </div>
    </div>
  );
};

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
  dateBlock: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  dayNumber: {
    color: "white",
    fontWeight: "bold",
    fontSize: 30,
    lineHeight: 1,
    minWidth: 32,
    textAlign: "right",
  },
  dayLabels: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    textAlign: "left",
  },
  dayWeek: {
    color: "white",
    fontSize: 13,
    fontWeight: "bold",
    letterSpacing: 0.5,
    lineHeight: 1.2,
  },
  monthYear: {
    color: "white",
    fontSize: 13,
    opacity: 0.85,
    lineHeight: 1.2,
  },
};

export default memo(TransactionDayRows);
