import { useContext } from "react";
import GlobalContext from "../context/GlobalContext";
import { useT } from "../i18n";

// "Entered by anna · edited by marco on 12 Sep 2026", under a transaction
// being looked at. Only when somebody other than you had a hand in it: in a
// wallet nobody shares every row would say your own name twice.
const TransactionAuthors = ({ transaction }) => {
  const { user } = useContext(GlobalContext);
  const { t, formatDate } = useT();
  if (!transaction) return null;

  const me = user?.data?.username;
  const { created_by_name: author, updated_by_name: editor, updated_at } = transaction;
  if (![author, editor].some((name) => name && name !== me)) return null;

  const parts = [];
  if (author) parts.push(t("form.enteredBy", { username: author }));
  if (editor) {
    parts.push(
      t("form.editedBy", {
        username: editor,
        date: updated_at ? formatDate(new Date(updated_at)) : "",
      }),
    );
  }

  return <div style={styles.line}>{parts.join(" · ")}</div>;
};

const styles = {
  line: {
    fontSize: 12,
    color: "var(--text-muted)",
    textAlign: "center",
    padding: "8px 12px",
  },
};

export default TransactionAuthors;
