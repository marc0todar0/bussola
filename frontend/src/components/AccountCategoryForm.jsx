import { useContext, useEffect, useRef, useState } from "react";
import GlobalContext from "../context/GlobalContext";
import { mainColor, secondaryColor, isoCurrencies, typesPerPillar } from "../config";
import IconItem from "./IconItem";
import IconPicker from "./IconPicker";
import toast from "react-hot-toast";
import { toMoneyFormat } from "../utils/generic";
import { Blurrable, currencyFormat } from "./Amount";
import { useT } from "../i18n";
import { useCanWrite } from "../utils/useCanWrite";
import { useQuotesEnabled } from "../utils/useQuotesEnabled";
import "./AccountCategoryForm.css";

const DEFAULT_COLOR = "#3f51b5";
const DEFAULT_ICON = { icon: "wallet", iconFamily: "mdi" };

export default function AccountCategoryForm({
  isCategory,
  item,
  isExpenseDefault = true,
  closeForm,
  onSaved,
}) {
  const { fetchAuth } = useContext(GlobalContext);
  const { t, tLookup, language, formatPercent } = useT();

  const isEdit = !!(item && item.id);

  const [name, setName] = useState(item?.name || "");
  const [color, setColor] = useState(item?.color || DEFAULT_COLOR);
  const [icon, setIcon] = useState(item?.icon || DEFAULT_ICON.icon);
  const [iconFamily, setIconFamily] = useState(
    item?.icon_family || item?.iconFamily || DEFAULT_ICON.iconFamily,
  );
  const [description, setDescription] = useState(item?.description || "");
  const [amount, setAmount] = useState(
    item?.amount != null ? Number(toMoneyFormat(item.amount)) : 0,
  );
  // The balance as it was when the form was filled in, exactly as stored.
  // Saving sends a balance only if the field was changed, and then together
  // with this, so the API can refuse to overwrite a balance that moved in the
  // meantime -- a transaction somebody recorded while this form was open
  // (api/controllers/accounts_controller.js, updateAccount).
  const [baseAmount, setBaseAmount] = useState(item?.amount ?? 0);
  const [isExpense, setIsExpense] = useState(
    isEdit && item?.type_id != null ? Number(item.type_id) === 1 : isExpenseDefault,
  );
  const [isCurrent, setIsCurrent] = useState(
    item?.is_current != null ? item.is_current !== false : true,
  );
  const [isInvestment, setIsInvestment] = useState(item?.is_investment === true);
  const [submitting, setSubmitting] = useState(false);
  // A save that went through while the form stays open (some holdings
  // failed): the page is told when the form is unmounted, however it closes
  // -- its Close button, Esc, the backdrop.
  const refreshOnCloseRef = useRef(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  useEffect(
    () => () => {
      if (refreshOnCloseRef.current) onSavedRef.current?.();
    },
    [],
  );
  // On a wallet shared read-only the form still opens -- looking at an
  // account's details is not writing -- but everything that would save,
  // archive or delete is gone.
  const canWrite = useCanWrite();
  const quotesOff = !useQuotesEnabled();

  // ---- Investment holdings ----
  const EMPTY_DRAFT = {
    name: "",
    pillar_id: 1,
    amount: "",
    type_id: "",
    description: "",
    issuer: "",
    country: "",
    currency: "",
    isin: "",
    quantity: "",
    purchase_price: "",
    purchase_date: "",
    current_price: "",
    auto_update: true,
  };
  const [pillars, setPillars] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [holdingTypes, setHoldingTypes] = useState([]);
  const [issuerSuggestions, setIssuerSuggestions] = useState([]);
  const [countrySuggestions, setCountrySuggestions] = useState([]);
  const [expanded, setExpanded] = useState({}); // { [holdingId]: bool }, "draft" for the new one
  const [refreshingId, setRefreshingId] = useState(null); // id of the holding being refreshed

  // Holding rows carrying changes that have not been saved yet.
  // It lives in a ref rather than (only) in state because it is read inside
  // the setHoldings callbacks, where a state captured by the closure would
  // already be stale; the counter next to it exists only to repaint the
  // highlight.
  const dirtyRef = useRef({});
  const [, bumpDirty] = useState(0);
  const markDirty = (id) => {
    if (id == null || dirtyRef.current[id]) return;
    dirtyRef.current[id] = true;
    bumpDirty((n) => n + 1);
  };
  const clearDirty = (id) => {
    if (id == null || !dirtyRef.current[id]) return;
    delete dirtyRef.current[id];
    bumpDirty((n) => n + 1);
  };
  const isDirty = (id) => !!dirtyRef.current[id];

  // The draft counts as touched as soon as a single field differs from the
  // values it starts with.
  const draftTouched = (d) =>
    Object.keys(EMPTY_DRAFT).some(
      (k) => String(d[k] ?? "") !== String(EMPTY_DRAFT[k] ?? ""),
    );

  // How many holding changes the Save button would carry with it.
  const pendingCount =
    holdings.filter((h) => isDirty(h.id)).length + (draftTouched(draft) ? 1 : 0);

  useEffect(() => {
    if (!item) return;
    setName(item.name || "");
    setColor(item.color || DEFAULT_COLOR);
    setIcon(item.icon || DEFAULT_ICON.icon);
    setIconFamily(item.icon_family || item.iconFamily || DEFAULT_ICON.iconFamily);
    setDescription(item.description || "");
    setAmount(item.amount != null ? Number(toMoneyFormat(item.amount)) : 0);
    setBaseAmount(item.amount ?? 0);
    setIsCurrent(item.is_current != null ? item.is_current !== false : true);
    setIsInvestment(item.is_investment === true);
    if (item.type_id != null) setIsExpense(Number(item.type_id) === 1);
  }, [item]);

  // Load pillars, types and the datalist suggestions when the form is for an
  // account rather than a category.
  useEffect(() => {
    if (isCategory) return;
    (async () => {
      try {
        const [pRes, tRes, isRes, coRes] = await Promise.all([
          fetchAuth(`/pillars`),
          fetchAuth(`/holding-types`),
          fetchAuth(`/holdings/distinct/issuer`),
          fetchAuth(`/holdings/distinct/country`),
        ]);
        if (pRes.ok) setPillars(await pRes.json());
        if (tRes.ok) setHoldingTypes(await tRes.json());
        if (isRes.ok) setIssuerSuggestions(await isRes.json());
        if (coRes.ok) setCountrySuggestions(await coRes.json());
      } catch (e) {
        console.error(e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCategory]);

  // Load the holdings of the investment account being edited.
  const loadHoldings = async () => {
    if (!isEdit) return;
    try {
      const res = await fetchAuth(`/accounts/${item.id}/holdings`);
      if (res.ok) setHoldings(await res.json());
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    if (!isCategory && isEdit && isInvestment) loadHoldings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, isInvestment]);

  const holdingsTotal = holdings.reduce((acc, h) => acc + (Number(h.amount) || 0), 0);

  // Saves, one after the other, the holding rows with pending changes and, if
  // the "new holding" row has been filled in, creates it. Returns the counts.
  const savePendingHoldings = async (created) => {
    let saved = 0;
    let failed = 0;
    for (const h of holdings.filter((x) => isDirty(x.id))) {
      try {
        const res = await fetchAuth(`/holdings/${h.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(holdingBody(h)),
        });
        if (res.ok) {
          clearDirty(h.id);
          saved++;
        } else {
          failed++;
        }
      } catch (e) {
        console.error(e);
        failed++;
      }
    }
    if (created) {
      try {
        const res = await fetchAuth(`/accounts/${item.id}/holdings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(holdingBody(created)),
        });
        if (res.ok) {
          setDraft(EMPTY_DRAFT);
          setExpanded((e) => ({ ...e, draft: false }));
          saved++;
        } else {
          failed++;
        }
      } catch (e) {
        console.error(e);
        failed++;
      }
    }
    return { saved, failed };
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error(t("form.nameRequired"));
      return;
    }
    // The new holding row leaves with the rest: if it has been filled in but
    // has no name we stop before writing anything, so nothing is saved half
    // way through.
    const newHolding =
      !isCategory && isEdit && isInvestment && draftTouched(draft) ? draft : null;
    if (newHolding && !newHolding.name.trim()) {
      toast.error(t("holding.newNeedsName"));
      return;
    }
    setSubmitting(true);
    try {
      const base = isCategory ? "/categories" : "/accounts";
      const url = isEdit ? `${base}/${item.id}` : base;
      // Editing an account: the balance travels only when it was changed
      // here, and with the balance it was changed from.
      const balanceChanged = !isEdit || Number(amount) !== Number(toMoneyFormat(baseAmount));
      const body = isCategory
        ? { name: name.trim(), color, icon, iconFamily, description, isExpense }
        : {
            name: name.trim(),
            color,
            icon,
            iconFamily,
            description,
            ...(balanceChanged
              ? { amount: Number(amount) || 0, ...(isEdit ? { previous_amount: baseAmount } : {}) }
              : {}),
            is_current: isCurrent,
            is_investment: isInvestment,
          };
      const response = await fetchAuth(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        if (failure && failure.code === "BALANCE_CHANGED") {
          // Somebody moved the balance while this form was open. The number
          // typed here stays; what it is compared against becomes the balance
          // as it is now, so saving again applies it knowingly.
          setBaseAmount(failure.balance ?? 0);
          toast.error(t("error.BALANCE_CHANGED", { balance: currencyFormat(failure.balance ?? 0) }));
          return;
        }
        // Any other refusal the API names (NAME_TAKEN; CATEGORY_IN_USE, a
        // category with transactions moved between expense and income) is
        // said as such when the catalogue knows the code.
        const key = failure && failure.code ? `error.${failure.code}` : null;
        const text = key ? t(key) : null;
        toast.error(text && text !== key ? text : t("form.saveFailed"));
        return;
      }
      const outcome = await savePendingHoldings(newHolding);
      if (outcome.failed > 0) {
        // The modal stays open: the rows that were not saved are still
        // highlighted and no edit is lost. The account itself was saved, but
        // the page's refresh replaces it with a spinner and would unmount this
        // form, so it waits until the form goes away.
        toast.error(
          outcome.failed === 1
            ? t("holding.notSavedOne")
            : t("holding.notSaved", { n: outcome.failed }),
        );
        refreshOnCloseRef.current = true;
        return;
      }
      toast.success(
        outcome.saved > 0
          ? outcome.saved === 1
            ? t("holding.savedWithOne")
            : t("holding.savedWith", { n: outcome.saved })
          : isEdit
            ? t("form.updated")
            : t("form.created"),
      );
      refreshOnCloseRef.current = false;
      onSaved && onSaved();
      closeForm && closeForm();
    } catch (error) {
      console.error(error);
      toast.error(t("common.networkError"));
    } finally {
      setSubmitting(false);
    }
  };

  // Closing: warn when there are holding changes that would be thrown away.
  const handleClose = () => {
    if (
      pendingCount > 0 &&
      !confirm(
        pendingCount === 1
          ? t("holding.confirmDiscardOne")
          : t("holding.confirmDiscard", { n: pendingCount }),
      )
    )
      return;
    closeForm && closeForm();
  };

  const isArchived = !!item?.archived;

  const handleArchive = async (archived) => {
    if (!isEdit) return;
    // Accounts get a warning when the balance is not zero; categories have no
    // balance to check.
    if (!isCategory && archived && Number(toMoneyFormat(amount)) !== 0) {
      if (
        !confirm(t("form.archiveNonZero", { name, balance: toMoneyFormat(amount) }))
      )
        return;
    }
    setSubmitting(true);
    try {
      const base = isCategory ? "/categories" : "/accounts";
      const response = await fetchAuth(`${base}/${item.id}/archive`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      });
      if (!response.ok) {
        toast.error(archived ? t("form.archiveFailed") : t("form.restoreFailed"));
        return;
      }
      toast.success(archived ? t("form.archived") : t("form.restored"));
      onSaved && onSaved();
      closeForm && closeForm();
    } catch (error) {
      console.error(error);
      toast.error(t("common.networkError"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!isEdit) return;
    const what = isCategory ? t("common.category") : t("common.account");
    if (!confirm(t("form.confirmDelete", { what, name }))) return;
    setSubmitting(true);
    try {
      const base = isCategory ? "/categories" : "/accounts";
      const response = await fetchAuth(`${base}/${item.id}`, { method: "DELETE" });
      if (!response.ok) {
        toast.error(t("form.deleteFailed", { what }));
        return;
      }
      toast.success(t("form.deleted"));
      onSaved && onSaved();
      closeForm && closeForm();
    } catch (error) {
      console.error(error);
      toast.error(t("common.networkError"));
    } finally {
      setSubmitting(false);
    }
  };

  // ---- Holding CRUD ----
  // amount = quantity x price when both are present, otherwise the manual value.
  const computeAmount = (h) => {
    const q = Number(h.quantity);
    const p = Number(h.current_price);
    const hasQ = h.quantity !== "" && h.quantity != null && !Number.isNaN(q);
    const hasP = h.current_price !== "" && h.current_price != null && !Number.isNaN(p);
    if (hasQ && hasP) return q * p;
    return Number(h.amount) || 0;
  };

  // The body shared by the create and update POSTs.
  const holdingBody = (h) => ({
    name: (h.name || "").trim(),
    pillar_id: Number(h.pillar_id) || 1,
    amount: Number(h.amount) || 0,
    type_id: h.type_id ?? null,
    description: h.description || null,
    issuer: h.issuer || null,
    country: h.country || null,
    currency: h.currency || null,
    isin: h.isin || null,
    quantity: h.quantity === "" ? null : h.quantity,
    purchase_price: h.purchase_price === "" ? null : h.purchase_price,
    purchase_date: h.purchase_date ? String(h.purchase_date).slice(0, 10) : null,
    current_price: h.current_price === "" ? null : h.current_price,
    // Only crypto and ET* can be auto-updated; for everything else it is false.
    auto_update: typeIsAutoUpdatable(h.type_id) ? h.auto_update !== false : false,
  });

  const addHolding = async () => {
    if (!draft.name.trim()) {
      toast.error(t("holding.nameRequired"));
      return;
    }
    try {
      const res = await fetchAuth(`/accounts/${item.id}/holdings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(holdingBody(draft)),
      });
      if (!res.ok) return toast.error(t("holding.addFailed"));
      mergeHoldings(await res.json());
      setDraft(EMPTY_DRAFT);
      setExpanded((e) => ({ ...e, draft: false }));
      onSaved && onSaved();
    } catch (e) {
      console.error(e);
      toast.error(t("common.networkError"));
    }
  };

  // Replaces the list with the server's, keeping the rows whose changes have
  // not been saved yet: without this, saving, adding or deleting one holding
  // threw away what was being typed in the others -- which is why only one row
  // at a time could be worked on.
  const mergeHoldings = (list) => {
    setHoldings((prev) =>
      list.map((remote) => {
        const local = prev.find((p) => p.id === remote.id);
        return local && dirtyRef.current[remote.id] ? local : remote;
      }),
    );
  };

  const updateHoldingLocal = (idx, field, value) => {
    setHoldings((arr) => arr.map((h, i) => (i === idx ? { ...h, [field]: value } : h)));
    markDirty(holdings[idx]?.id);
  };

  const saveHolding = async (h) => {
    try {
      const res = await fetchAuth(`/holdings/${h.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(holdingBody(h)),
      });
      if (!res.ok) return toast.error(t("holding.saveFailed"));
      clearDirty(h.id);
      mergeHoldings(await res.json());
      toast.success(t("holding.saved"));
      onSaved && onSaved();
    } catch (e) {
      console.error(e);
      toast.error(t("common.networkError"));
    }
  };

  // Refresh price and return through the ISIN (best effort). It updates ONLY
  // the row concerned -- no reload of the whole detail -- so edits in progress
  // on the other rows survive.
  const refreshHolding = async (h) => {
    if (!h.isin) {
      toast.error(t("holding.needIsin"));
      return;
    }
    setRefreshingId(h.id);
    const tid = toast.loading(t("holding.refreshing"));
    try {
      const res = await fetchAuth(`/holdings/${h.id}/refresh`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data && data.code === "QUOTES_DISABLED" ? t("error.QUOTES_DISABLED") : t("holding.refreshFailed"), {
          id: tid,
        });
        return;
      }
      const updated = (data.holdings || []).find((x) => x.id === h.id);
      if (updated) {
        clearDirty(h.id);
        setHoldings((prev) => prev.map((x) => (x.id === h.id ? updated : x)));
      }
      if (data.updated) {
        const source = t("holding.externalSource");
        const price =
          updated && updated.current_price != null
            ? Number(updated.current_price).toLocaleString(language)
            : null;
        toast.success(
          t("holding.priceUpdated", { source }) + (price ? `: ${price}` : ""),
          { id: tid },
        );
      } else if (data.hint && data.hint.reason === "CURRENCY_UNSUPPORTED") {
        // The source is up; it just cannot quote in this wallet's currency,
        // and a price in another one would be added up with the wrong unit.
        toast(t("holding.currencyUnsupported", { currency: data.hint.currency }), { id: tid, icon: "⚠️" });
      } else {
        toast(t("holding.sourceUnavailable"), { id: tid, icon: "⚠️" });
      }
    } catch (e) {
      console.error(e);
      toast.error(t("common.networkError"), { id: tid });
    } finally {
      setRefreshingId(null);
    }
  };

  // Adds a new holding type (a quick free-text field) and selects it.
  const addHoldingType = async (apply) => {
    const typed = window.prompt(t("holding.newTypePrompt"));
    if (!typed || !typed.trim()) return;
    try {
      const res = await fetchAuth(`/holding-types`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: typed.trim() }),
      });
      if (!res.ok) return toast.error(t("holding.typeCreateFailed"));
      const list = await res.json();
      setHoldingTypes(list);
      const created = list.find((x) => x.name === typed.trim());
      if (created && apply) apply(created.id);
    } catch (e) {
      console.error(e);
      toast.error(t("common.networkError"));
    }
  };

  // Removes a type this wallet invented (the seeded ones cannot be). The
  // server leaves the holdings that used it without a type; the rows on
  // screen follow, so that saving one of them does not send the id back.
  const removeHoldingType = async (id) => {
    const type = holdingTypes.find((x) => String(x.id) === String(id));
    if (!type || !type.custom) return;
    if (!confirm(t("holding.confirmRemoveType", { name: type.name }))) return;
    try {
      const res = await fetchAuth(`/holding-types/${type.id}`, { method: "DELETE" });
      if (!res.ok) return toast.error(t("holding.typeRemoveFailed"));
      setHoldingTypes(await res.json());
      const untyped = (h) =>
        String(h.type_id ?? "") === String(type.id)
          ? { ...h, type_id: "", type_code: null, type_name: null, type_color: null }
          : h;
      setHoldings((arr) => arr.map(untyped));
      setDraft(untyped);
    } catch (e) {
      console.error(e);
      toast.error(t("common.networkError"));
    }
  };
  const isCustomType = (id) =>
    holdingTypes.some((x) => String(x.id) === String(id) && x.custom);

  const deleteHolding = async (h) => {
    if (!confirm(t("holding.confirmDelete", { name: h.name }))) return;
    try {
      const res = await fetchAuth(`/holdings/${h.id}`, { method: "DELETE" });
      if (!res.ok) return toast.error(t("holding.deleteFailed"));
      clearDirty(h.id);
      mergeHoldings(await res.json());
      onSaved && onSaved();
    } catch (e) {
      console.error(e);
      toast.error(t("common.networkError"));
    }
  };

  const gv = (h, field) => {
    const v = h[field];
    return v == null ? "" : v;
  };
  const isAuto = (h) => gv(h, "quantity") !== "" && gv(h, "current_price") !== "";

  // The type's stable code from its id. Every rule below keys on the code, not
  // on the name: a name follows the interface language and a rule written
  // against it would quietly stop matching.
  const typeCode = (id) => {
    const found = holdingTypes.find((x) => String(x.id) === String(id));
    return found ? found.code : null;
  };
  // Types selectable for a given pillar (absent from the map = all of them).
  const visibleTypes = (pillarId) => {
    const allowed = typesPerPillar[Number(pillarId)];
    return allowed ? holdingTypes.filter((x) => allowed.includes(x.code)) : holdingTypes;
  };
  // Auto-updatable only for crypto and ET* (ETF/ETN/ETP/money market), the
  // instruments the quote service prices. Everything else is manual only.
  const typeIsAutoUpdatable = (typeId) => {
    const code = typeCode(typeId) || "";
    return code === "CRYPTO" || /^ET/.test(code) || code === "MONEY_MARKET_ETF";
  };
  const isAutoUpdatable = (h) => typeIsAutoUpdatable(gv(h, "type_id"));

  // Changing pillar: if the current type is no longer allowed, clear it.
  const changePillar = (h, update, value) => {
    update("pillar_id", value);
    const allowed = typesPerPillar[Number(value)];
    const code = typeCode(gv(h, "type_id"));
    if (allowed && code && !allowed.includes(code)) update("type_id", "");
  };

  // Derived return % (current_price vs purchase_price), null when it cannot be
  // computed.
  const returnPct = (h) => {
    const a = Number(gv(h, "purchase_price"));
    const c = Number(gv(h, "current_price"));
    if (gv(h, "purchase_price") === "" || gv(h, "current_price") === "") return null;
    if (!a || Number.isNaN(a) || Number.isNaN(c)) return null;
    return ((c - a) / a) * 100;
  };

  // Annualised return (CAGR) from the purchase date. null when it cannot be
  // computed, or for holdings younger than 30 days where extrapolating is
  // misleading.
  const annualisedReturnPct = (h) => {
    const a = Number(gv(h, "purchase_price"));
    const c = Number(gv(h, "current_price"));
    const d = gv(h, "purchase_date");
    if (!a || Number.isNaN(a) || Number.isNaN(c) || !d) return null;
    const days = (Date.now() - new Date(d).getTime()) / 86400000;
    if (!(days >= 30)) return null;
    return (Math.pow(c / a, 365 / days) - 1) * 100;
  };

  // The holding's detail panel (ISIN, quantity, price, issuer, country...).
  const renderDetail = (s, update) => (
    <div style={styles.detailPanel}>
      <div className="holding-detail-grid">
        <label style={styles.miniLabel}>
          {t("holding.pillar")}
          <select
            value={gv(s, "pillar_id") || 1}
            onChange={(e) => changePillar(s, update, e.target.value)}
            style={styles.input}
          >
            {pillars.map((p) => (
              <option key={p.id} value={p.id}>
                {tLookup(p)}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.miniLabel}>
          {t("holding.type")}
          <select
            value={gv(s, "type_id")}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__add__") addHoldingType((id) => update("type_id", id));
              else if (v === "__remove__") removeHoldingType(gv(s, "type_id"));
              else update("type_id", v);
            }}
            style={styles.input}
          >
            <option value="">{t("holding.typePlaceholder")}</option>
            {visibleTypes(gv(s, "pillar_id") || 1).map((x) => (
              <option key={x.id} value={x.id}>
                {tLookup(x)}
              </option>
            ))}
            <option value="__add__">➕ {t("common.add")}</option>
            {canWrite && isCustomType(gv(s, "type_id")) && (
              <option value="__remove__">🗑 {t("holding.removeType")}</option>
            )}
          </select>
        </label>
        <label style={styles.miniLabel}>
          {t("holding.isin")}
          <input
            type="text"
            value={gv(s, "isin")}
            onChange={(e) => update("isin", e.target.value.toUpperCase())}
            style={styles.input}
            placeholder="IE00… / BTC-EUR"
          />
        </label>
        <label style={styles.miniLabel}>
          {t("holding.quantity")}
          <input
            type="number"
            step="any"
            value={gv(s, "quantity")}
            onChange={(e) => update("quantity", e.target.value)}
            style={styles.input}
          />
        </label>
        <label style={styles.miniLabel}>
          {t("holding.purchasePrice")}
          <input
            type="number"
            step="any"
            value={gv(s, "purchase_price")}
            onChange={(e) => update("purchase_price", e.target.value)}
            style={styles.input}
            placeholder={t("common.manual")}
          />
        </label>
        <label style={styles.miniLabel}>
          {t("holding.purchaseDate")}
          <input
            type="date"
            value={String(gv(s, "purchase_date") || "").slice(0, 10)}
            onChange={(e) => update("purchase_date", e.target.value)}
            style={styles.input}
          />
        </label>
        <label style={styles.miniLabel}>
          {t("holding.currentPrice")}
          <input
            type="number"
            step="any"
            value={gv(s, "current_price")}
            onChange={(e) => update("current_price", e.target.value)}
            style={styles.input}
            placeholder={t("holding.currentPricePlaceholder")}
          />
        </label>
        <label style={styles.miniLabel}>
          {t("holding.issuer")}
          <input
            type="text"
            list="issuer-list"
            value={gv(s, "issuer")}
            onChange={(e) => update("issuer", e.target.value)}
            style={styles.input}
            placeholder="iShares, Vanguard…"
          />
        </label>
        <label style={styles.miniLabel}>
          {t("holding.country")}
          <input
            type="text"
            list="country-list"
            value={gv(s, "country")}
            onChange={(e) => update("country", e.target.value)}
            style={styles.input}
            placeholder={t("holding.countryPlaceholder")}
          />
        </label>
        <label style={styles.miniLabel}>
          {t("holding.currency")}
          <select
            value={gv(s, "currency")}
            onChange={(e) => update("currency", e.target.value)}
            style={styles.input}
          >
            <option value="">—</option>
            {isoCurrencies.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.miniLabel}>
          {t("holding.return")}
          {(() => {
            const r = returnPct(s);
            return (
              <div
                style={{
                  ...styles.input,
                  backgroundColor: "var(--surface-2)",
                  color: r == null ? "var(--text-subtle)" : r >= 0 ? "var(--positive)" : "var(--negative)",
                  fontWeight: "bold",
                }}
              >
                {r == null ? "—" : `${formatPercent(r)}%`}
              </div>
            );
          })()}
        </label>
        <label style={styles.miniLabel}>
          {t("holding.annualisedReturn")}
          {(() => {
            const r = annualisedReturnPct(s);
            return (
              <div
                style={{
                  ...styles.input,
                  backgroundColor: "var(--surface-2)",
                  color: r == null ? "var(--text-subtle)" : r >= 0 ? "var(--positive)" : "var(--negative)",
                  fontWeight: "bold",
                }}
                title={t("holding.cagrHint")}
              >
                {r == null ? "—" : `${formatPercent(r)}%${t("holding.perYear")}`}
              </div>
            );
          })()}
        </label>
      </div>
      <label style={{ ...styles.miniLabel, marginTop: 8 }}>
        {t("common.description")}
        <input
          type="text"
          value={gv(s, "description")}
          onChange={(e) => update("description", e.target.value)}
          style={styles.input}
          placeholder={t("holding.notesPlaceholder")}
        />
      </label>
      {(() => {
        const auto = isAutoUpdatable(s);
        return (
          <>
            <label
              style={{ ...styles.checkRow, opacity: auto ? 1 : 0.5 }}
              title={auto ? undefined : t("holding.autoOnlyFor")}
            >
              <input
                type="checkbox"
                disabled={!auto}
                checked={auto && gv(s, "auto_update") !== false}
                onChange={(e) => update("auto_update", e.target.checked)}
              />
              {t("holding.autoUpdate")}
            </label>
            {!auto && <div style={styles.hint}>{t("holding.autoUpdateHint")}</div>}
          </>
        );
      })()}
    </div>
  );

  return (
    <div style={styles.container}>
      <button
        type="button"
        onClick={handleClose}
        disabled={submitting}
        style={styles.closeX}
        title={t("common.close")}
        aria-label={t("common.close")}
      >
        ✕
      </button>
      <div style={styles.title}>
        {!canWrite
          ? isCategory ? t("form.viewCategory") : t("form.viewAccount")
          : isEdit
            ? isCategory ? t("form.editCategory") : t("form.editAccount")
            : isCategory ? t("form.newCategory") : t("form.newAccount")}
      </div>

      {/* Every field at once rather than one `disabled` per input: on a wallet
          shared read-only the whole form is something to read. `display:
          contents` keeps the fieldset out of the layout, so the column below
          is laid out exactly as it was. */}
      <fieldset disabled={!canWrite} style={styles.fields}>

      <div style={styles.previewRow}>
        <IconItem icon={icon} family={iconFamily} color={color} width={56} height={56} size={32} />
        <div style={styles.previewName}>{name || "—"}</div>
      </div>

      <label style={styles.label}>{t("common.name")}</label>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={styles.input}
        placeholder={t("common.name")}
      />

      <label style={styles.label}>{t("common.color")}</label>
      <input
        type="color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        style={styles.colorInput}
      />

      <label style={styles.label}>{t("common.icon")}</label>
      <IconPicker
        icon={icon}
        family={iconFamily}
        onSelect={({ icon: newIcon, iconFamily: newFamily }) => {
          setIcon(newIcon);
          setIconFamily(newFamily);
        }}
      />

      <label style={styles.label}>{t("common.description")}</label>
      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        style={styles.input}
        placeholder={t("form.descriptionOptional")}
      />

      {!isCategory && (
        <>
          <label style={styles.label}>{t("common.kind")}</label>
          <div style={styles.kindRow}>
            <div
              onClick={() => setIsCurrent((v) => !v)}
              style={{
                ...styles.kindPill,
                backgroundColor: isCurrent ? mainColor : "var(--chip-bg)",
                color: isCurrent ? "white" : "var(--text)",
              }}
            >
              {t("account.currentAccount")}
            </div>
            <div
              onClick={() => setIsInvestment((v) => !v)}
              style={{
                ...styles.kindPill,
                backgroundColor: isInvestment ? "#8e24aa" : "var(--chip-bg)",
                color: isInvestment ? "white" : "var(--text)",
              }}
            >
              {t("account.investment")}
            </div>
          </div>

          <label style={styles.label}>{t("account.balance")}</label>
          <input
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={styles.input}
          />

          {isInvestment && (
            <>
              <label style={styles.label}>{t("account.actualBalance")}</label>
              <div style={styles.readonlyBox}>
                {/* Blurred like every other amount. It is read-only and
                    computed from the holdings below, so hiding it costs the
                    person editing the form nothing they cannot get by
                    switching bank mode off for a moment. */}
                <Blurrable>{currencyFormat(holdingsTotal)}</Blurrable>
              </div>
            </>
          )}
        </>
      )}

      {/* Holdings editor: only for an investment account being edited */}
      {!isCategory && isInvestment && (
        <div style={styles.holdingsSection}>
          <div style={styles.holdingsTitle}>{t("holding.plural")}</div>
          {!isEdit ? (
            <div style={styles.hint}>{t("holding.saveAccountFirst")}</div>
          ) : (
            <>
              {/* Datalist suggestions for issuer and country */}
              <datalist id="issuer-list">
                {issuerSuggestions.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
              <datalist id="country-list">
                {countrySuggestions.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>

              {holdings.map((s, idx) => {
                const update = (field, value) => updateHoldingLocal(idx, field, value);
                const auto = isAuto(s);
                const price = gv(s, "current_price");
                const rend = returnPct(s);
                // Refresh is possible only when the auto flag is ticked (and
                // the type supports it), and the instance has a quote service.
                const canRefresh = isAutoUpdatable(s) && gv(s, "auto_update") !== false && !quotesOff;
                return (
                  <div
                    key={s.id}
                    className={`holding-block${isDirty(s.id) ? " is-dirty" : ""}`}
                  >
                    <div className="holding-row">
                      <input
                        type="text"
                        value={s.name || ""}
                        onChange={(e) => update("name", e.target.value)}
                        style={styles.input}
                        className="holding-name"
                        placeholder={t("common.name")}
                      />
                      <div className="holding-metrics">
                        <div style={styles.priceBox} title={t("holding.currentPrice")}>
                          {price === "" ? "—" : Number(price).toLocaleString(language)}
                        </div>
                        <div
                          style={{
                            ...styles.returnBox,
                            color: rend == null ? "var(--text-subtle)" : rend >= 0 ? "var(--positive)" : "var(--negative)",
                          }}
                          title={t("holding.returnHint")}
                        >
                          {rend == null ? "—" : `${rend >= 0 ? "+" : ""}${rend.toFixed(1)}%`}
                        </div>
                      </div>
                      <div className="holding-amount">
                        {auto ? (
                          <div
                            style={{ ...styles.readonlyBox, padding: "8px" }}
                            title={t("holding.computedHint")}
                          >
                            {currencyFormat(computeAmount(s))}
                          </div>
                        ) : (
                          <input
                            type="number"
                            step="0.01"
                            value={s.amount}
                            onChange={(e) => update("amount", e.target.value)}
                            style={styles.input}
                          />
                        )}
                      </div>
                      <div className="holding-actions">
                        {canWrite && (
                        <button
                          type="button"
                          onClick={() => refreshHolding(s)}
                          disabled={!canRefresh || refreshingId === s.id}
                          style={{
                            ...styles.iconBtn,
                            backgroundColor: canRefresh ? "#1e88e5" : "#bdbdbd",
                            opacity: !canRefresh || refreshingId === s.id ? 0.6 : 1,
                            cursor: canRefresh && refreshingId !== s.id ? "pointer" : "default",
                          }}
                          aria-disabled={!canRefresh || undefined}
                          title={
                            quotesOff
                              ? t("quotes.disabled")
                              : canRefresh
                                ? t("holding.refreshFromIsin")
                                : t("holding.autoOff")
                          }
                        >
                          <span
                            style={
                              refreshingId === s.id
                                ? { display: "inline-block", animation: "spin 0.8s linear infinite" }
                                : undefined
                            }
                          >
                            🔄
                          </span>
                        </button>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            setExpanded((x) => ({ ...x, [s.id]: !x[s.id] }))
                          }
                          style={{ ...styles.iconBtn, backgroundColor: "#607d8b" }}
                          title={t("common.details")}
                        >
                          {expanded[s.id] ? "▾" : "▸"}
                        </button>
                        {canWrite && (
                          <>
                            <button
                              type="button"
                              onClick={() => saveHolding(s)}
                              style={{ ...styles.iconBtn, backgroundColor: mainColor }}
                              title={t("holding.saveRowOnly")}
                            >
                              ✓
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteHolding(s)}
                              style={{ ...styles.iconBtn, backgroundColor: "var(--negative-fill)" }}
                              title={t("common.delete")}
                            >
                              ✕
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {expanded[s.id] && renderDetail(s, update)}
                  </div>
                );
              })}

              {/* New holding */}
              {canWrite && (
              <div
                className={`holding-block${draftTouched(draft) ? " is-dirty" : ""}`}
              >
                <div className="holding-row">
                  <input
                    type="text"
                    value={draft.name}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    style={styles.input}
                    className="holding-name"
                    placeholder={t("holding.newPlaceholder")}
                  />
                  <div className="holding-amount">
                    {isAuto(draft) ? (
                      <div
                        style={{ ...styles.readonlyBox, padding: "8px" }}
                        title={t("holding.computedHint")}
                      >
                        {currencyFormat(computeAmount(draft))}
                      </div>
                    ) : (
                      <input
                        type="number"
                        step="0.01"
                        value={draft.amount}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, amount: e.target.value }))
                        }
                        style={styles.input}
                        placeholder="0"
                      />
                    )}
                  </div>
                  <div className="holding-actions">
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((x) => ({ ...x, draft: !x.draft }))
                      }
                      style={{ ...styles.iconBtn, backgroundColor: "#607d8b" }}
                      title={t("common.details")}
                    >
                      {expanded.draft ? "▾" : "▸"}
                    </button>
                    <button
                      type="button"
                      onClick={addHolding}
                      style={{ ...styles.iconBtn, backgroundColor: "var(--positive-fill)" }}
                      title={t("holding.addNow")}
                    >
                      +
                    </button>
                  </div>
                </div>
                {expanded.draft &&
                  renderDetail(draft, (field, value) =>
                    setDraft((d) => ({ ...d, [field]: value })),
                  )}
              </div>
              )}
            </>
          )}
        </div>
      )}

      {isCategory && (
        <>
          <label style={styles.label}>{t("common.kind")}</label>
          <div style={styles.kindRow}>
            <div
              onClick={() => setIsExpense(true)}
              style={{
                ...styles.kindPill,
                backgroundColor: isExpense ? "var(--negative-fill)" : "var(--chip-bg)",
                color: isExpense ? "white" : "var(--text)",
              }}
            >
              {t("common.expense.one")}
            </div>
            <div
              onClick={() => setIsExpense(false)}
              style={{
                ...styles.kindPill,
                backgroundColor: !isExpense ? "var(--positive-fill)" : "var(--chip-bg)",
                color: !isExpense ? "white" : "var(--text)",
              }}
            >
              {t("common.income.one")}
            </div>
          </div>
        </>
      )}

      </fieldset>

      {pendingCount > 0 && (
        <div style={styles.pendingHint}>
          {pendingCount === 1
            ? t("holding.pendingOne", { button: isEdit ? t("common.save") : t("common.create") })
            : t("holding.pending", {
                n: pendingCount,
                button: isEdit ? t("common.save") : t("common.create"),
              })}
        </div>
      )}

      <div style={styles.actionsRow}>
        <button
          type="button"
          onClick={handleClose}
          disabled={submitting}
          style={{ ...styles.btn, backgroundColor: secondaryColor }}
        >
          {canWrite ? t("common.cancel") : t("common.close")}
        </button>
        {isEdit && canWrite && (
          <button
            type="button"
            onClick={() => handleArchive(!isArchived)}
            disabled={submitting}
            style={{ ...styles.btn, backgroundColor: "#fb8c00" }}
          >
            {isArchived ? t("common.restore") : t("common.archive")}
          </button>
        )}
        {isEdit && canWrite && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={submitting}
            style={{ ...styles.btn, backgroundColor: "var(--negative-fill)" }}
          >
            {t("common.delete")}
          </button>
        )}
        {canWrite && (
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          style={{ ...styles.btn, backgroundColor: mainColor }}
        >
          {isEdit ? t("common.save") : t("common.create")}
        </button>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    width: "100%",
    padding: 16,
    boxSizing: "border-box",
    gap: 6,
    // No overflow here: what scrolls is .modal-body, which already has
    // overscroll-behavior and momentum on iOS. Two nested scrollable
    // containers make finger scrolling unpredictable.
  },
  fields: {
    display: "contents",
    border: "none",
    margin: 0,
    padding: 0,
    minWidth: 0,
  },
  closeX: {
    position: "absolute",
    top: 12,
    right: 12,
    width: 32,
    height: 32,
    border: "none",
    borderRadius: 16,
    backgroundColor: "var(--chip-bg)",
    color: "var(--text-secondary)",
    fontSize: 16,
    fontWeight: "bold",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
    zIndex: 1,
  },
  title: {
    fontSize: 22,
    fontWeight: "bold",
    textAlign: "center",
    marginBottom: 8,
  },
  previewRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 8,
    border: "1px solid var(--border-soft)",
    borderRadius: 8,
    marginBottom: 8,
  },
  previewName: {
    fontSize: 18,
    fontWeight: "bold",
  },
  label: {
    fontSize: 13,
    fontWeight: "bold",
    color: "var(--text-secondary)",
    marginTop: 6,
  },
  input: {
    width: "100%",
    padding: "8px 10px",
    fontSize: 15,
    border: "1px solid var(--border-strong)",
    borderRadius: 6,
    boxSizing: "border-box",
  },
  readonlyBox: {
    width: "100%",
    padding: "8px 10px",
    fontSize: 16,
    fontWeight: "bold",
    border: "1px solid var(--border-soft)",
    borderRadius: 6,
    boxSizing: "border-box",
    backgroundColor: "var(--surface-2)",
  },
  colorInput: {
    width: 60,
    height: 36,
    border: "1px solid var(--border-strong)",
    borderRadius: 6,
    cursor: "pointer",
    padding: 2,
  },
  kindRow: {
    display: "flex",
    flexDirection: "row",
    gap: 8,
  },
  kindPill: {
    flex: 1,
    padding: "8px 14px",
    borderRadius: 20,
    cursor: "pointer",
    fontWeight: "bold",
    textAlign: "center",
    userSelect: "none",
  },
  holdingsSection: {
    marginTop: 12,
    borderTop: "1px solid var(--border-soft)",
    paddingTop: 8,
  },
  holdingsTitle: {
    fontSize: 15,
    fontWeight: "bold",
    color: "var(--text)",
    marginBottom: 6,
  },
  priceBox: {
    minWidth: 64,
    textAlign: "right",
    fontSize: 13,
    color: "var(--text)",
    whiteSpace: "nowrap",
  },
  returnBox: {
    minWidth: 52,
    textAlign: "right",
    fontSize: 13,
    fontWeight: "bold",
    whiteSpace: "nowrap",
  },
  detailPanel: {
    marginTop: 8,
    paddingTop: 8,
    borderTop: "1px dashed var(--border)",
  },
  miniLabel: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    fontSize: 12,
    fontWeight: "bold",
    color: "var(--text-muted)",
  },
  checkRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
    fontSize: 13,
    color: "var(--text-secondary)",
  },
  iconBtn: {
    border: "none",
    borderRadius: 6,
    color: "white",
    fontSize: 16,
    fontWeight: "bold",
    cursor: "pointer",
    padding: "8px 10px",
    minWidth: 36,
  },
  hint: {
    fontSize: 13,
    color: "var(--text-subtle)",
    fontStyle: "italic",
  },
  pendingHint: {
    marginTop: 10,
    padding: "6px 10px",
    borderRadius: 6,
    backgroundColor: "var(--warning-soft)",
    border: "1px solid var(--warning)",
    color: "var(--warning-text)",
    fontSize: 13,
  },
  actionsRow: {
    display: "flex",
    flexDirection: "row",
    gap: 8,
    marginTop: 16,
    justifyContent: "flex-end",
  },
  btn: {
    padding: "10px 16px",
    border: "none",
    borderRadius: 6,
    color: "white",
    fontSize: 15,
    fontWeight: "bold",
    cursor: "pointer",
  },
};
