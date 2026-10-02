import { useState, useContext, useEffect } from "react";
import GlobalContext from "../context/GlobalContext";
import Loading from "../components/Loading";
import Amount from "../components/Amount";
import AccountCard from "../components/AccountCard";
import Modal from "../components/Modal";
import AccountCategoryForm from "../components/AccountCategoryForm";
import { mainColor } from "../config";
import { useNavigate } from "react-router-dom";
import { FaChartPie, FaSync } from "react-icons/fa";
import toast from "react-hot-toast";
import { useKeyboardShortcut } from "../utils/useKeyboardShortcut";
import { useCanWrite } from "../utils/useCanWrite";
import { useQuotesEnabled } from "../utils/useQuotesEnabled";
import { useT } from "../i18n";
import { errorText } from "../utils/errorText";

export default function BankAccounts() {
  const { fetchAuth, accounts } = useContext(GlobalContext);
  const { t } = useT();
  const canWrite = useCanWrite();
  const quotesOff = !useQuotesEnabled();
  const navigate = useNavigate();
  const [isLoading, setLoading] = useState(true);
  const { data, setData } = accounts;
  const [tot, setTot] = useState({
    totalAmount: 0,
    totalActualAmount: 0,
    accountCount: 0,
    currentCount: 0,
    investmentCount: 0,
  });
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [open, setOpen] = useState(false);
  const [archived, setArchived] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [refreshingQuotes, setRefreshingQuotes] = useState(false);
  const [refreshingAccountId, setRefreshingAccountId] = useState(null);

  const getAccounts = async () => {
    // No setLoading(true) here: the spinner is for the first load only
    // (isLoading starts true). A refresh after a save -- a holding added from
    // the open account -- must keep the page, and the modal on it, mounted;
    // replacing it with <Loading/> threw away whatever the modal held.
    try {
      const response = await fetchAuth(`/accounts`);
      const json = await response.json().catch(() => null);
      // A refusal (a 409 while the wallet changes, a 500) keeps what is on
      // screen: its body has no list, and setting it would crash every .map.
      if (!response.ok || !json || !Array.isArray(json.data)) {
        if (response.status !== 401) toast.error(errorText(t, json, t("common.loadFailed")));
        return;
      }
      setData(json.data);
      setTot({
        totalAmount: json.totalAmount,
        totalActualAmount: json.totalActualAmount,
        accountCount: json.accountCount,
        currentCount: json.currentCount,
        investmentCount: json.investmentCount,
      });
    } catch (error) {
      console.error(error);
      toast.error(t("error.NETWORK_ERROR"));
    } finally {
      setLoading(false);
    }
  };

  const getArchived = async () => {
    try {
      const response = await fetchAuth(`/accounts?archived=true`);
      const json = await response.json().catch(() => null);
      // getAccounts() reports the failure; this one only keeps what it had.
      if (!response.ok || !json || !Array.isArray(json.data)) return;
      setArchived(json.data);
    } catch (error) {
      console.error(error);
    }
  };

  const refresh = () => {
    getAccounts();
    getArchived();
  };

  // A refusal the API names (QUOTES_DISABLED, if the instance lost its quotes service
  // since /me was read) is said as such; anything else is a plain failure.
  const quotesError = (body) =>
    body && body.code === "QUOTES_DISABLED" ? t("error.QUOTES_DISABLED") : t("quotes.failed");

  // Refresh the quotes of every investment account, then reload.
  const refreshQuotes = async () => {
    if (refreshingQuotes || quotesOff) return;
    setRefreshingQuotes(true);
    const tid = toast.loading(t("quotes.updating"));
    try {
      const res = await fetchAuth(`/holdings/refresh-all`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(quotesError(data), { id: tid });
        return;
      }
      toast.success(t("quotes.updatedOf", { updated: data.updated, total: data.total }), {
        id: tid,
      });
      await getAccounts();
    } catch (e) {
      console.error(e);
      toast.error(t("common.networkError"), { id: tid });
    } finally {
      setRefreshingQuotes(false);
    }
  };

  // Refresh the quotes of one investment account.
  const refreshAccount = async (id) => {
    if (refreshingAccountId || quotesOff) return;
    setRefreshingAccountId(id);
    const tid = toast.loading(t("quotes.updating"));
    try {
      const res = await fetchAuth(`/accounts/${id}/holdings/refresh`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(quotesError(data), { id: tid });
        return;
      }
      toast.success(t("quotes.updated", { updated: data.updated }), { id: tid });
      await getAccounts();
    } catch (e) {
      console.error(e);
      toast.error(t("common.networkError"), { id: tid });
    } finally {
      setRefreshingAccountId(null);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openAccountDetail = (account) => {
    setSelectedAccount(account);
    setOpen(true);
  };

  const openCreate = () => {
    setSelectedAccount(null);
    setOpen(true);
  };

  const closeForm = () => {
    setOpen(false);
    setSelectedAccount(null);
  };

  useKeyboardShortcut((e) => {
    if (open || !canWrite) return;
    if (e.key === "n" || e.key === "N") openCreate();
  }, [open, openCreate, canWrite]);

  if (isLoading) {
    return <Loading />;
  }

  return (
    <div style={styles.container}>
      <Amount size={40} amount={tot.totalAmount} />
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          justifyContent: "space-between",
          width: "60%",
        }}
      >
        <Amount
          size={20}
          amount={tot.totalActualAmount}
          color={tot.totalActualAmount >= tot.totalAmount ? "var(--positive)" : "var(--negative)"}
        />

        <Amount size={20} amount={tot.totalActualAmount - tot.totalAmount} />
      </div>
      <div style={styles.summaryLine}>
        {t("account.summaryLine", {
          active: tot.accountCount,
          current: tot.currentCount,
          investment: tot.investmentCount,
        })}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          justifyContent: "center",
          alignItems: "center",
          gap: 16,
          marginTop: 10,
        }}
      >
        {/* Creating, and refreshing quotes, both write. On a wallet shared
            read-only they are not dimmed but absent: there is nothing here to
            unlock. */}
        {canWrite && (
          <div onClick={openCreate} style={styles.buttonAdd}>
            <div
              style={{
                textAlign: "center",
                fontSize: 30,
                color: "white",
              }}
            >
              +
            </div>
          </div>
        )}
        <div
          onClick={() => navigate("/portfolio")}
          style={styles.buttonPortfolio}
          title={t("portfolio.assetAllocation")}
        >
          <FaChartPie size={26} color="white" />
        </div>
        {canWrite && (
        <div
          onClick={refreshQuotes}
          style={{
            ...styles.buttonRefresh,
            cursor: refreshingQuotes || quotesOff ? "default" : "pointer",
            opacity: quotesOff ? 0.4 : refreshingQuotes ? 0.6 : 1,
          }}
          aria-disabled={quotesOff || undefined}
          title={quotesOff ? t("quotes.disabled") : t("quotes.refresh")}
        >
          <FaSync
            size={22}
            color="white"
            style={
              refreshingQuotes
                ? { animation: "spin 0.8s linear infinite" }
                : undefined
            }
          />
        </div>
        )}
      </div>
      <div style={{ width: "100%", marginVertical: 20 }}>
        {data.map((d) => (
          <AccountCard
            key={d.id}
            account={d}
            handleTouch={openAccountDetail}
            onRefresh={refreshAccount}
            refreshing={refreshingAccountId === d.id}
            quotesOff={quotesOff}
          />
        ))}
      </div>

      {archived.length > 0 && (
        <div style={styles.archiveSection}>
          <div onClick={() => setShowArchived((s) => !s)} style={styles.archiveHeader}>
            {showArchived ? "▾" : "▸"} {t("account.archived", { count: archived.length })}
          </div>
          {showArchived && (
            <div style={{ width: "100%", opacity: 0.6 }}>
              {archived.map((d) => (
                <AccountCard key={d.id} account={d} handleTouch={openAccountDetail} />
              ))}
            </div>
          )}
        </div>
      )}

      <Modal
        isOpen={open}
        onClose={closeForm}
        label={t("modal.accountDetail")}
        size="wide"
      >
        <AccountCategoryForm
          isCategory={false}
          item={selectedAccount}
          closeForm={closeForm}
          onSaved={refresh}
        />
      </Modal>
    </div>
  );
}

const styles = {
  container: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    backgroundColor: "var(--bg)",
    alignItems: "center",
    justifyContent: "flex-start",
    paddingVertical: 10,
    width: "90%",
    margin: "0 auto",
  },
  summaryLine: {
    fontSize: 14,
    color: "var(--text-muted)",
    marginTop: 8,
    textAlign: "center",
  },
  buttonAdd: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: mainColor,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    cursor: "pointer",
  },
  buttonPortfolio: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#8e24aa",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    cursor: "pointer",
  },
  buttonRefresh: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#1e88e5",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
  },
  archiveSection: {
    width: "100%",
    marginTop: 24,
    borderTop: "1px solid var(--border-soft)",
    paddingTop: 8,
  },
  archiveHeader: {
    fontSize: 13,
    color: "var(--text-subtle)",
    cursor: "pointer",
    userSelect: "none",
    padding: "6px 0",
  },
};
