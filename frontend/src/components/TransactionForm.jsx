import { useState, useEffect, useContext, useRef } from "react";
import { FaExchangeAlt } from "react-icons/fa";
import { secondaryColor } from "../config";
import AccountPicker from "./AccountPicker";
import Calculator from "./Calculator";
import TransactionAuthors from "./TransactionAuthors";
import { parseDateyyyymmdd, formatDate } from "../utils/generic";
import GlobalContext from "../context/GlobalContext";
import Loading from "./Loading";
import toast from "react-hot-toast";
import { isKeyTargetBusy } from "../utils/useKeyboardShortcut";
import { useT } from "../i18n";
import { useCanWrite } from "../utils/useCanWrite";

// The keyboard shortcuts (S/E/T, D, A) are deliberately not derived from the
// labels: a key that moved when you switched language would be worse than a
// key whose letter no longer spells the word.
// onSaved is called after a successful save, and only then: it closes the
// form and reloads the list's first page. A failed save leaves the form open
// with what was typed in it.
//
// `draft` prefills a NEW transaction -- from an inbox item or a deep link
// (/transactions/new?amount=...): { amount, tx_date (YYYYMMDD), description,
// type_id, from_id, to_id }, any of them missing. An id that is not among the
// form's accounts or categories of the right kind is ignored, and the usual
// default takes its place. `savePath` sends the save elsewhere than POST
// /transactions: accepting an inbox item posts the same body to
// /inbox/:id/accept, which creates the transaction and resolves the item.
const TransactionForm = ({ closeForm, onSaved, transaction, onDelete, draft = null, savePath = null }) => {
  const { fetchAuth } = useContext(GlobalContext);
  const { t } = useT();
  const canWrite = useCanWrite();

  const [isLoading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState(null);
  const [incomeCategories, setIncomeCategories] = useState(null);
  const [expenseCategories, setExpenseCategories] = useState(null);
  const [lastUsed, setLastUsed] = useState({});
  // Accounts/categories that are archived and therefore block the detail view.
  const [blockedByArchived, setBlockedByArchived] = useState(null);

  const operationTypes = { expense: 1, income: 2, transfer: 3 };
  // What a new transaction starts from: the draft when there is one.
  const seed = transaction ? null : draft;
  const [opType, setOpType] = useState(
    transaction ? transaction.type_id : [1, 2, 3].includes(Number(seed?.type_id)) ? Number(seed.type_id) : operationTypes.expense,
  );
  const [currentIdFrom, setCurrentIdFrom] = useState(transaction ? transaction.from_id : null);
  const [currentIdTo, setCurrentIdTo] = useState(transaction ? transaction.to_id : null);

  const fromPickerRef = useRef(null);
  const toPickerRef = useRef(null);
  // One piece of state for both selects: opening one closes the other by
  // construction, no need to coordinate them by hand. null = none open.
  const [openPicker, setOpenPicker] = useState(null);
  const calculatorRef = useRef(null);

  const [note, setNote] = useState(transaction ? transaction.description : seed?.description || "");
  const [val, setVal] = useState(transaction ? transaction.amount : seed?.amount ?? null);

  const today = new Date();
  const [date, setDate] = useState(
    transaction
      ? parseDateyyyymmdd(transaction.tx_date).dd
      : seed?.tx_date && /^\d{8}$/.test(seed.tx_date)
        ? parseDateyyyymmdd(seed.tx_date).dd
        : today,
  );
  const isToday =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();

  const color =
    opType == operationTypes.transfer
      ? secondaryColor
      : opType == operationTypes.income
        ? "var(--positive)"
        : "var(--negative)";

  const typeLabel =
    opType == operationTypes.transfer
      ? t("common.transfer")
      : opType == operationTypes.income
        ? t("common.income.one")
        : t("common.expense.one");

  // Works out the default account/category for a type: it uses the last
  // transaction of that type (lastUsed), falling back to the first row in each
  // list. `from` may be given (a draft's account) and is then kept.
  const computeDefaults = (type, accountsArr, incomeArr, expenseArr, lastUsedMap, from) => {
    const last = lastUsedMap?.[type];
    const lastFrom = (arr) => (last != null ? arr.find((c) => c.id == last.from_id)?.id : undefined);
    const lastTo = (arr) => (last != null ? arr.find((c) => c.id == last.to_id)?.id : undefined);
    const fromId = from ?? lastFrom(accountsArr) ?? accountsArr[0]?.id ?? null;

    if (type == operationTypes.transfer) {
      // Both ends are accounts and must differ: the last destination if it is
      // not the source, else the first other account, else none (a wallet
      // with a single account, where the type cannot be chosen anyway).
      const prev = lastTo(accountsArr);
      return {
        from: fromId,
        to: prev != null && prev != fromId ? prev : accountsArr.find((c) => c.id != fromId)?.id ?? null,
      };
    }
    const toArr = type == operationTypes.income ? incomeArr : expenseArr;
    return { from: fromId, to: lastTo(toArr) ?? toArr[0]?.id ?? null };
  };

  // A transfer needs two accounts. The form's own type stays expense when a
  // draft asks for a transfer that cannot be made.
  const canTransfer = (accounts?.length ?? 0) >= 2;

  const getFormData = async () => {
    try {
      const response = await fetchAuth(`/transactions/form-data`, { cache: "no-store" });
      const json = await response.json();

      if (!json.accounts.length || !json.incomeCategories.length || !json.expenseCategories.length) {
        toast.error(t("form.needOneOfEach"));
        closeForm();
        return;
      }

      setAccounts(json.accounts);
      setIncomeCategories(json.incomeCategories);
      setExpenseCategories(json.expenseCategories);
      setLastUsed(json.lastUsed || {});

      if (!transaction) {
        // A transfer (from a draft or a deep link) in a wallet with a single
        // account cannot be made: start as an expense instead.
        const type =
          opType == operationTypes.transfer && json.accounts.length < 2 ? operationTypes.expense : opType;
        if (type != opType) setOpType(type);
        // A draft's ends win when they are real choices for this type: the
        // source among the accounts, the destination among the categories of
        // the right kind (or the accounts other than the source, for a
        // transfer). Otherwise default to the last transaction of that type.
        const draftFrom = seed?.from_id != null ? json.accounts.find((c) => c.id == seed.from_id)?.id : undefined;
        const def = computeDefaults(
          type,
          json.accounts,
          json.incomeCategories,
          json.expenseCategories,
          json.lastUsed,
          draftFrom,
        );
        const toChoices =
          type == operationTypes.transfer
            ? json.accounts.filter((c) => c.id != def.from)
            : type == operationTypes.income
              ? json.incomeCategories
              : json.expenseCategories;
        const draftTo = seed?.to_id != null ? toChoices.find((c) => c.id == seed.to_id)?.id : undefined;
        setCurrentIdFrom(def.from);
        setCurrentIdTo(draftTo ?? def.to);
      } else {
        // Editing: an archived account/category is absent from the lists, so
        // the detail cannot be opened until it is restored.
        const toArr =
          transaction.type_id == operationTypes.transfer
            ? json.accounts
            : transaction.type_id == operationTypes.income
              ? json.incomeCategories
              : json.expenseCategories;

        const archived = [];
        if (!json.accounts.find((c) => c.id == transaction.from_id))
          archived.push({ role: t("form.roleFrom"), name: transaction.from_name });
        if (!toArr.find((c) => c.id == transaction.to_id))
          archived.push({ role: t("form.roleTo"), name: transaction.to_name });
        if (archived.length) setBlockedByArchived(archived);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    getFormData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpChange = (nextType) => {
    if (nextType == operationTypes.transfer && !canTransfer) return;
    const def = computeDefaults(nextType, accounts, incomeCategories, expenseCategories, lastUsed);
    setCurrentIdFrom(def.from);
    setCurrentIdTo(def.to);
    setOpType(nextType);
  };

  const isTransfer = opType == operationTypes.transfer;

  // Swapping from/to only makes sense for a transfer, where both sides are
  // accounts.
  const handleSwap = () => {
    if (!isTransfer) return;
    setCurrentIdFrom(currentIdTo);
    setCurrentIdTo(currentIdFrom);
  };

  // Loads a balance into the keypad as the current amount.
  const applyAmount = (amount) => calculatorRef.current?.setAmount(amount);

  const loadFromBalance = () => {
    const account = accounts?.find((c) => c.id == currentIdFrom);
    if (account) applyAmount(account.amount);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (isKeyTargetBusy(e.target)) return;
      if (isLoading || !accounts || blockedByArchived) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        handleOpChange(operationTypes.expense);
      } else if (k === "e") {
        e.preventDefault();
        handleOpChange(operationTypes.income);
      } else if (k === "t") {
        e.preventDefault();
        handleOpChange(operationTypes.transfer);
      } else if (k === "d") {
        e.preventDefault();
        fromPickerRef.current?.open();
      } else if (k === "a") {
        e.preventDefault();
        toPickerRef.current?.open();
      } else if (k === "x") {
        e.preventDefault();
        handleSwap();
      } else if (k === "b") {
        e.preventDefault();
        loadFromBalance();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isLoading,
    accounts,
    incomeCategories,
    expenseCategories,
    lastUsed,
    blockedByArchived,
    opType,
    currentIdFrom,
    currentIdTo,
  ]);

  // One save at a time: a double tap on GO, or GO then Enter, would otherwise
  // record the transaction twice. The ref blocks a second call in the same
  // tick, before the state has re-rendered; the state greys GO out. Released
  // only when the save failed -- a success closes the form.
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const handleSubmit = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    let saved = false;
    const params = {
      from_id: currentIdFrom,
      to_id: currentIdTo,
      amount: val,
      type_id: opType,
      description: note,
      tx_date: formatDate(date),
    };

    try {
      const response = await fetchAuth(
        savePath || `/transactions${transaction ? "/" + transaction.id : ""}`,
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(params),
        },
      );
      if (!response.ok) {
        // The API names what went wrong when it knows: the transaction was
        // deleted or changed by somebody else in the meantime, say.
        const body = await response.json().catch(() => null);
        const key = body && body.code ? `error.${body.code}` : null;
        const text = key ? t(key) : null;
        toast.error(text && text !== key ? text : t("form.saveFailed"));
      } else {
        saved = true;
        if (onSaved) onSaved();
        else closeForm();
      }
    } catch (error) {
      console.error(error);
      toast.error(t("common.networkError"));
    } finally {
      if (!saved) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  };

  if (isLoading || !accounts || !incomeCategories || !expenseCategories) {
    return <Loading />;
  }

  // Two reasons this form cannot be used, and one screen for both: the
  // transaction touches an archived account, or the wallet is shared
  // read-only. In either case what is left to do is read it and close.
  if (blockedByArchived || !canWrite) {
    const list = (blockedByArchived || []).map((b) => `${b.role}: "${b.name}"`).join(" · ");
    return (
      <div style={{ ...styles.container, padding: 24, gap: 16 }}>
        <div style={{ fontSize: 22, fontWeight: "bold", textAlign: "center" }}>
          {t("form.notEditable")}
        </div>
        <div style={{ fontSize: 16, textAlign: "center", color: "var(--text)" }}>
          {blockedByArchived ? t("form.usesArchived", { list }) : t("form.readOnlyWallet")}
        </div>
        {transaction?.description && (
          <div
            style={{
              fontSize: 15,
              fontStyle: "italic",
              color: "var(--text-secondary)",
              textAlign: "center",
              borderTop: "1px solid var(--border-soft)",
              paddingTop: 12,
            }}
          >
            {t("form.note")}: {transaction.description}
          </div>
        )}
        <TransactionAuthors transaction={transaction} />
        <button
          type="button"
          onClick={closeForm}
          style={{
            padding: "10px 16px",
            border: "none",
            borderRadius: 6,
            color: "white",
            backgroundColor: secondaryColor,
            fontSize: 15,
            fontWeight: "bold",
            cursor: "pointer",
          }}
        >
          {t("common.close")}
        </button>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.menuOp}>
        {[
          { type: operationTypes.expense, label: t("common.expense.one"), key: "S", bg: "var(--negative-fill)" },
          { type: operationTypes.income, label: t("common.income.one"), key: "E", bg: "var(--positive-fill)" },
          {
            type: operationTypes.transfer,
            label: t("common.transfer"),
            key: "T",
            bg: secondaryColor,
          },
        ].map(({ type, label, key, bg }) => {
          const disabled = type == operationTypes.transfer && !canTransfer;
          return (
            <div key={type} style={styles.menuOpView}>
              <div
                onClick={() => handleOpChange(type)}
                aria-disabled={disabled || undefined}
                title={disabled ? t("form.transferNeedsTwoAccounts") : undefined}
              >
                <div
                  style={{
                    ...styles.menuOpText,
                    backgroundColor: bg,
                    fontSize: "clamp(14px, 4.4vw, 20px)",
                    opacity: opType == type ? 1 : disabled ? 0.2 : 0.45,
                    cursor: disabled ? "not-allowed" : undefined,
                  }}
                >
                  {label}
                  <span className="kbd-hint" style={styles.menuOpKey}>{key}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ ...styles.textOpTranslate, color, borderBottomColor: color }}>{typeLabel}</div>

      <div style={styles.fromToContainer}>
        <AccountPicker
          ref={fromPickerRef}
          isFrom={true}
          isAccount={true}
          arrayPicker={accounts}
          currentId={currentIdFrom}
          setCurrentId={setCurrentIdFrom}
          onUseAmount={applyAmount}
          shortcutHint="D"
          isOpen={openPicker === "from"}
          onOpenChange={(v) => setOpenPicker(v ? "from" : null)}
        />
        {isTransfer && (
          <div style={styles.swapColumn}>
            <div onClick={handleSwap} title={t("form.swap")} style={styles.swapButton}>
              <FaExchangeAlt size={16} />
            </div>
          </div>
        )}
        <AccountPicker
          ref={toPickerRef}
          isFrom={false}
          isAccount={isTransfer}
          arrayPicker={
            isTransfer
              ? accounts
              : opType == operationTypes.income
                ? incomeCategories
                : expenseCategories
          }
          currentId={currentIdTo}
          setCurrentId={setCurrentIdTo}
          onUseAmount={applyAmount}
          shortcutHint="A"
          isOpen={openPicker === "to"}
          onOpenChange={(v) => setOpenPicker(v ? "to" : null)}
        />
      </div>

      <Calculator
        ref={calculatorRef}
        color={color}
        note={note}
        setNote={setNote}
        val={val}
        setVal={setVal}
        date={date}
        setDate={setDate}
        isToday={isToday}
        submit={handleSubmit}
        busy={submitting}
        closeForm={closeForm}
        onDelete={transaction && onDelete ? () => onDelete(transaction) : null}
      />
      <TransactionAuthors transaction={transaction} />
    </div>
  );
};

const styles = {
  container: {
    flex: 1,
    width: "100%",
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-start",
    alignItems: "center",
  },
  menuOp: {
    display: "flex",
    flexDirection: "row",
    width: "100%",
    cursor: "pointer",
  },
  menuOpView: { flex: 1 },
  menuOpText: {
    color: "white",
    fontSize: 20,
    backgroundColor: secondaryColor,
    textAlign: "center",
    padding: 8,
  },
  menuOpKey: {
    marginLeft: 6,
    padding: "0 5px",
    borderRadius: 4,
    backgroundColor: "rgba(0,0,0,0.25)",
    fontSize: 12,
    fontFamily: "monospace",
    verticalAlign: "middle",
  },
  textOpTranslate: {
    textAlign: "center",
    fontSize: 25,
    marginVertical: 10,
    borderBottomWidth: 2,
  },
  fromToContainer: {
    display: "flex",
    flexDirection: "row",
    width: "100%",
  },
  swapColumn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 4px",
    backgroundColor: "var(--surface)",
  },
  swapButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    borderRadius: 18,
    border: `1px solid ${secondaryColor}`,
    color: secondaryColor,
    backgroundColor: "var(--surface)",
    cursor: "pointer",
    userSelect: "none",
    boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
  },
};

export default TransactionForm;
