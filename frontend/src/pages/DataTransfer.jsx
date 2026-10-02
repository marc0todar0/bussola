import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { FaArrowLeft, FaFileArchive, FaFileCsv, FaFileExport, FaFileImport } from "react-icons/fa";
import Amount from "../components/Amount";
import { useT } from "../i18n";
import fetchAuth from "../utils/fetchAuth";
import useCanWrite from "../utils/useCanWrite";
import "./DataTransfer.css";

// The wallet's data in and out of files.
//
// Export is two downloads and nothing else: the transactions for a
// spreadsheet, and the whole wallet as an archive another wallet can import.
// Both are reads, so a read-only member gets them too.
//
// Import is a conversation with the server in up to three steps, and every
// step sends the file again. The server keeps nothing between them: it parses
// the file each time, answers with the questions it cannot settle on its own
// (how a bank's CSV is laid out) or with a preview, and on confirmation parses
// and validates it all once more before writing anything. What this page
// holds is only the person's decisions -- the layout, which rows, which
// category for a row -- never data the server will take on trust.

// The API's own limit (api/controllers/import_controller.js). Checked here
// only to spare a pointless upload; the server checks it for itself.
const MAX_MB = 5;
const PAGE_SIZE = 100;

// The row's type by code, never by the name a lookup row happens to carry.
const TYPE_LABEL = { EXPENSE: "common.expense.one", INCOME: "common.income.one", TRANSFER: "common.transfer" };
const TYPE_COLOR = { EXPENSE: "var(--negative)", INCOME: "var(--positive)", TRANSFER: "var(--neutral)" };

const ENCODINGS = [
  ["utf-8", "data.encoding.utf8"],
  ["windows-1252", "data.encoding.windows1252"],
];
const SEPARATORS = [
  [",", "data.sep.comma"],
  [";", "data.sep.semicolon"],
  ["\t", "data.sep.tab"],
];
const DECIMALS = [
  [".", "data.decimal.dot"],
  [",", "data.decimal.comma"],
];
const DATE_FORMATS = ["YMD", "DMY", "MDY"];
const SKIP_CHOICES = Array.from({ length: 21 }, (_, i) => i);

const readJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const postJson = async (path, payload) => {
  const response = await fetchAuth(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  return { ok: response.ok, body: await readJson(response) };
};

// The file rides in a JSON body, so it goes as base64. readAsDataURL does the
// encoding natively; the "data:...;base64," prefix is dropped.
const fileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

// Through fetchAuth rather than a plain link, so that an expired session or a
// wallet taken away is handled like everywhere else, and an error arrives as
// a message instead of as a page of JSON. The filename is the server's.
const saveDownload = async (path, fallbackName) => {
  const response = await fetchAuth(path, { cache: "no-store" });
  if (!response.ok) return { ok: false, body: await readJson(response) };
  const blob = await response.blob();
  const match = (response.headers.get("content-disposition") || "").match(/filename="([^"]+)"/);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = match ? match[1] : fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { ok: true };
};

const nameKey = (s) => String(s || "").trim().toLowerCase();
const columnValue = (v) => (v === null || v === undefined ? "" : String(v));
const columnOf = (v) => (v === "" ? null : Number(v));

// The wizard's starting point: the server's guesses for the columns, and the
// names already chosen if this is a second look at the same file.
const mappingFrom = (sniff, previous) => {
  const g = sniff.guess;
  const e = sniff.existing;
  return {
    amountMode: g.debit !== null && g.credit !== null ? "split" : "single",
    date: g.date,
    amount: g.amount,
    debit: g.debit,
    credit: g.credit,
    note: g.note,
    account: previous?.account ?? (e.accounts[0] || ""),
    expenseCategory: previous?.expenseCategory ?? (e.expenseCategories[0] || ""),
    incomeCategory: previous?.incomeCategory ?? (e.incomeCategories[0] || ""),
  };
};

function DataTransfer() {
  const { t } = useT();
  const navigate = useNavigate();
  const canWrite = useCanWrite();

  const [range, setRange] = useState({ from: "", to: "" });
  const [exporting, setExporting] = useState(null);

  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sniff, setSniff] = useState(null);
  const [settings, setSettings] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [preview, setPreview] = useState(null);
  // The options the preview on screen was made with: the commit sends exactly
  // these, so what is confirmed is what was looked at.
  const [previewOptions, setPreviewOptions] = useState(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [selected, setSelected] = useState(() => new Set());
  const [overrides, setOverrides] = useState({});
  const fileInput = useRef(null);

  // The server's code, translated when the catalogue knows it; its English
  // text otherwise. The body doubles as the variables, so {max} and {lines}
  // come from what the server said.
  const errorText = (body, fallbackKey) => {
    const code = body && body.code;
    if (code) {
      const key = `error.${code}`;
      const text = t(key, body);
      if (text !== key) return text;
    }
    return (body && body.error) || t(fallbackKey);
  };

  const exportFile = async (kind) => {
    setExporting(kind);
    try {
      const query = new URLSearchParams();
      if (range.from) query.set("from", range.from);
      if (range.to) query.set("to", range.to);
      const qs = query.toString();
      const result =
        kind === "csv"
          ? await saveDownload(`/data/export/transactions.csv${qs ? `?${qs}` : ""}`, "transactions.csv")
          : await saveDownload("/data/export/wallet.zip", "wallet.zip");
      if (!result.ok) toast.error(errorText(result.body, "error.EXPORT_FAILED"));
    } catch {
      toast.error(t("common.networkError"));
    } finally {
      setExporting(null);
    }
  };

  const reset = () => {
    setFile(null);
    setSniff(null);
    setSettings(null);
    setMapping(null);
    setPreview(null);
    setPreviewOptions(null);
    setSelected(new Set());
    setOverrides({});
    if (fileInput.current) fileInput.current.value = "";
  };

  // One request for every step: for a bank CSV with no layout yet the server
  // answers with its questions, otherwise with the preview.
  const ask = async (content, options) => {
    setBusy(true);
    try {
      const { ok, body } = await postJson("/data/import/preview", { file: content.base64, options });
      if (!ok || !body) {
        toast.error(errorText(body, "error.IMPORT_FAILED"));
        return;
      }
      if (body.stage === "mapping") {
        setPreview(null);
        setSniff(body);
        setSettings(body.settings);
        setMapping((previous) => mappingFrom(body, previous));
        return;
      }
      setPreview(body);
      setPreviewOptions(options);
      setPreviewVersion((v) => v + 1);
      // Rows with errors cannot be chosen, and probable duplicates start
      // unchosen: the server's defaults, which the person can overrule.
      setSelected(new Set(body.rows.filter((r) => r.selected).map((r) => r.line)));
      setOverrides({});
    } catch {
      toast.error(t("common.networkError"));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e) => {
    const chosen = e.target.files && e.target.files[0];
    if (!chosen) return;
    if (chosen.size > MAX_MB * 1024 * 1024) {
      toast.error(t("error.IMPORT_TOO_LARGE", { max: MAX_MB }));
      e.target.value = "";
      return;
    }
    setSniff(null);
    setSettings(null);
    setMapping(null);
    setPreview(null);
    let content;
    try {
      content = { name: chosen.name, base64: await fileToBase64(chosen) };
    } catch {
      toast.error(t("error.IMPORT_UNREADABLE"));
      return;
    }
    setFile(content);
    await ask(content, {});
  };

  // The separator, the character set, the header and the skipped rows decide
  // what the columns *are*, so the server reads the file again and guesses
  // afresh. The decimal mark and the date format only matter to the preview.
  const changeSettings = (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    if (["separator", "encoding", "headerRow", "skipRows"].some((k) => k in patch)) {
      ask(file, { ...next, decimal: "auto", dateFormat: "auto" });
    }
  };

  const runPreview = () => {
    const m = mapping;
    const split = m.amountMode === "split";
    const hasAmount = split ? m.debit !== null || m.credit !== null : m.amount !== null;
    if (m.date === null || !hasAmount || !m.account.trim()) {
      toast.error(t("error.IMPORT_MAPPING_INCOMPLETE"));
      return;
    }
    ask(file, {
      ...settings,
      mapping: {
        date: m.date,
        amount: split ? null : m.amount,
        debit: split ? m.debit : null,
        credit: split ? m.credit : null,
        note: m.note,
        account: m.account,
        expenseCategory: m.expenseCategory,
        incomeCategory: m.incomeCategory,
      },
    });
  };

  const commit = async () => {
    setBusy(true);
    try {
      const { ok, body } = await postJson("/data/import/commit", {
        file: file.base64,
        options: previewOptions,
        selection: { lines: [...selected], overrides },
      });
      if (!ok || !body) {
        toast.error(errorText(body, "error.IMPORT_FAILED"));
        return;
      }
      toast.success(t(preview.format === "bussola-zip" ? "data.importedArchive" : "data.imported", body));
      reset();
    } catch {
      toast.error(t("common.networkError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="data-transfer">
      <button type="button" className="data-back" onClick={() => navigate(-1)}>
        <FaArrowLeft /> {t("common.back")}
      </button>

      <section className="data-section">
        <h2>
          <FaFileExport /> {t("data.exportTitle")}
        </h2>
        <p className="data-hint">{t("data.exportHint")}</p>
        <div className="data-row">
          <label className="data-field">
            <span>{t("data.from")}</span>
            <input
              type="date"
              value={range.from}
              max={range.to || undefined}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            />
          </label>
          <label className="data-field">
            <span>{t("data.to")}</span>
            <input
              type="date"
              value={range.to}
              min={range.from || undefined}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            />
          </label>
          <button
            type="button"
            className="data-button"
            disabled={Boolean(exporting)}
            onClick={() => exportFile("csv")}
          >
            <FaFileCsv /> {exporting === "csv" ? t("data.exporting") : t("data.exportCsv")}
          </button>
        </div>
        <p className="data-hint data-small">{t("data.rangeHint")}</p>
        <div className="data-row">
          <button
            type="button"
            className="data-button"
            disabled={Boolean(exporting)}
            onClick={() => exportFile("zip")}
          >
            <FaFileArchive /> {exporting === "zip" ? t("data.exporting") : t("data.exportZip")}
          </button>
        </div>
      </section>

      <section className="data-section">
        <h2>
          <FaFileImport /> {t("data.importTitle")}
        </h2>
        {/* The API refuses a read-only member anyway; a file picker whose
            only outcome is that refusal is not offered at all. */}
        {!canWrite ? (
          <p className="data-hint">{t("data.readOnly")}</p>
        ) : (
          <>
            <p className="data-hint">{t("data.importHint", { max: MAX_MB })}</p>
            <div className="data-row">
              <label className={`data-button data-file${busy ? " data-disabled" : ""}`}>
                <FaFileImport /> {t("data.chooseFile")}
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,.tsv,.txt,.zip,text/csv,application/zip"
                  onChange={onFile}
                  disabled={busy}
                />
              </label>
              {file && <span className="data-file-name">{file.name}</span>}
              {busy && <span className="data-hint data-inline">{t("data.working")}</span>}
            </div>

            {sniff && settings && mapping && !preview && (
              <MappingStep
                sniff={sniff}
                settings={settings}
                mapping={mapping}
                setMapping={setMapping}
                onSettings={changeSettings}
                onPreview={runPreview}
                busy={busy}
              />
            )}

            {preview && (
              <PreviewStep
                key={previewVersion}
                preview={preview}
                selected={selected}
                setSelected={setSelected}
                overrides={overrides}
                setOverrides={setOverrides}
                onBack={preview.format === "bank-csv" ? () => setPreview(null) : null}
                onCancel={reset}
                onCommit={commit}
                busy={busy}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step two, for a bank's CSV: which column is which
// ---------------------------------------------------------------------------
function MappingStep({ sniff, settings, mapping, setMapping, onSettings, onPreview, busy }) {
  const { t } = useT();
  const set = (patch) => setMapping((m) => ({ ...m, ...patch }));
  const split = mapping.amountMode === "split";
  const labelOf = (j) => sniff.columns[j] || t("data.mapping.column", { n: j + 1 });

  // Which role a column has been given, so the sample can show it.
  const roles = new Map();
  const give = (j, key) => j !== null && j !== undefined && roles.set(j, key);
  give(mapping.date, "data.mapping.date");
  if (split) {
    give(mapping.debit, "data.mapping.debit");
    give(mapping.credit, "data.mapping.credit");
  } else give(mapping.amount, "data.mapping.amount");
  give(mapping.note, "data.mapping.note");

  const columnSelect = (field) => (
    <select value={columnValue(mapping[field])} onChange={(e) => set({ [field]: columnOf(e.target.value) })}>
      <option value="">{t("data.mapping.none")}</option>
      {sniff.columns.map((_, j) => (
        <option key={j} value={j}>
          {labelOf(j)}
        </option>
      ))}
    </select>
  );

  return (
    <div className="data-step">
      <h3>{t("data.mapping.title")}</h3>
      <p className="data-hint">{t("data.mapping.hint")}</p>

      <div className="data-grid">
        <label className="data-field">
          <span>{t("data.mapping.encoding")}</span>
          <select value={settings.encoding} onChange={(e) => onSettings({ encoding: e.target.value })}>
            {ENCODINGS.map(([value, key]) => (
              <option key={value} value={value}>
                {t(key)}
              </option>
            ))}
          </select>
        </label>
        <label className="data-field">
          <span>{t("data.mapping.separator")}</span>
          <select value={settings.separator} onChange={(e) => onSettings({ separator: e.target.value })}>
            {SEPARATORS.map(([value, key]) => (
              <option key={key} value={value}>
                {t(key)}
              </option>
            ))}
          </select>
        </label>
        <label className="data-field">
          <span>{t("data.mapping.skipRows")}</span>
          <select value={settings.skipRows} onChange={(e) => onSettings({ skipRows: Number(e.target.value) })}>
            {SKIP_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="data-check">
          <input
            type="checkbox"
            checked={Boolean(settings.headerRow)}
            onChange={(e) => onSettings({ headerRow: e.target.checked })}
          />
          {t("data.mapping.headerRow")}
        </label>
        <label className="data-field">
          <span>{t("data.mapping.decimal")}</span>
          <select value={settings.decimal} onChange={(e) => onSettings({ decimal: e.target.value })}>
            {DECIMALS.map(([value, key]) => (
              <option key={value} value={value}>
                {t(key)}
              </option>
            ))}
          </select>
        </label>
        <label className="data-field">
          <span>{t("data.mapping.dateFormat")}</span>
          <select value={settings.dateFormat} onChange={(e) => onSettings({ dateFormat: e.target.value })}>
            {DATE_FORMATS.map((f) => (
              <option key={f} value={f}>
                {t(`data.date.${f}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {sniff.dateAmbiguous && <p className="data-warning">{t("data.mapping.dateAmbiguous")}</p>}

      <div className="data-grid">
        <label className="data-field">
          <span>{t("data.mapping.date")}</span>
          {columnSelect("date")}
        </label>
        <fieldset className="data-fieldset">
          <legend>{t("data.mapping.amountMode")}</legend>
          <label>
            <input
              type="radio"
              name="amount-mode"
              checked={!split}
              onChange={() => set({ amountMode: "single" })}
            />
            {t("data.mapping.amountSingle")}
          </label>
          <label>
            <input
              type="radio"
              name="amount-mode"
              checked={split}
              onChange={() => set({ amountMode: "split" })}
            />
            {t("data.mapping.amountSplit")}
          </label>
        </fieldset>
        {split ? (
          <>
            <label className="data-field">
              <span>{t("data.mapping.debit")}</span>
              {columnSelect("debit")}
            </label>
            <label className="data-field">
              <span>{t("data.mapping.credit")}</span>
              {columnSelect("credit")}
            </label>
          </>
        ) : (
          <label className="data-field">
            <span>{t("data.mapping.amount")}</span>
            {columnSelect("amount")}
          </label>
        )}
        <label className="data-field">
          <span>{t("data.mapping.note")}</span>
          {columnSelect("note")}
        </label>
      </div>

      {/* Free text with the wallet's names as suggestions: picking one uses
          it, typing a new one creates it -- and the preview lists it before
          anything is created. */}
      <div className="data-grid">
        <label className="data-field">
          <span>{t("data.mapping.account")}</span>
          <input
            list="data-accounts"
            value={mapping.account}
            onChange={(e) => set({ account: e.target.value })}
          />
        </label>
        <label className="data-field">
          <span>{t("data.mapping.expenseCategory")}</span>
          <input
            list="data-expense-categories"
            value={mapping.expenseCategory}
            onChange={(e) => set({ expenseCategory: e.target.value })}
          />
        </label>
        <label className="data-field">
          <span>{t("data.mapping.incomeCategory")}</span>
          <input
            list="data-income-categories"
            value={mapping.incomeCategory}
            onChange={(e) => set({ incomeCategory: e.target.value })}
          />
        </label>
      </div>
      <p className="data-hint data-small">{t("data.mapping.namesHint")}</p>
      <datalist id="data-accounts">
        {sniff.existing.accounts.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <datalist id="data-expense-categories">
        {sniff.existing.expenseCategories.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <datalist id="data-income-categories">
        {sniff.existing.incomeCategories.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      <h4>{t("data.mapping.sample", { n: sniff.rowCount })}</h4>
      <div className="data-scroll">
        <table className="data-table data-sample">
          <thead>
            <tr>
              {sniff.columns.map((_, j) => (
                <th key={j} className={roles.has(j) ? "data-mapped" : undefined}>
                  {labelOf(j)}
                  {roles.has(j) && <small>{t(roles.get(j))}</small>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sniff.sample.map((row, i) => (
              <tr key={i}>
                {sniff.columns.map((_, j) => (
                  <td key={j} className={roles.has(j) ? "data-mapped" : undefined}>
                    {row[j] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="data-actions">
        <button type="button" className="data-button data-primary" onClick={onPreview} disabled={busy}>
          {t("data.mapping.preview")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step three: what would happen, and the choice of rows
// ---------------------------------------------------------------------------
function PreviewStep({ preview, selected, setSelected, overrides, setOverrides, onBack, onCancel, onCommit, busy }) {
  const { t, formatDate } = useT();
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const archive = preview.format === "bussola-zip";
  const bank = preview.format === "bank-csv";

  const rows = useMemo(() => {
    if (filter === "selected") return preview.rows.filter((r) => selected.has(r.line));
    if (filter === "errors") return preview.rows.filter((r) => r.errors.length > 0);
    if (filter === "duplicates") return preview.rows.filter((r) => r.duplicate);
    return preview.rows;
  }, [preview.rows, filter, selected]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const shown = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  // What the rows still chosen would create, recomputed as rows are toggled:
  // the server only creates what the confirmed rows name (plus, for an
  // archive, everything its own lists hold), and the list on screen says so.
  const needed = useMemo(() => {
    const names = new Set();
    for (const r of preview.rows) {
      if (!selected.has(r.line)) continue;
      names.add(`ACCOUNT|${nameKey(r.from)}`);
      names.add(`${r.type === "TRANSFER" ? "ACCOUNT" : r.type}|${nameKey(overrides[r.line] ?? r.to)}`);
    }
    return preview.create.filter((c) => c.always || names.has(`${c.kind}|${nameKey(c.name)}`));
  }, [preview, selected, overrides]);

  // A bank row's category can be changed, to one the wallet already has or
  // to the default this import creates anyway.
  const categoryOptions = useMemo(() => {
    const withDefault = (list, fallback) =>
      fallback && !list.some((n) => nameKey(n) === nameKey(fallback)) ? [fallback, ...list] : list;
    return {
      EXPENSE: withDefault(preview.existing.expenseCategories, preview.mapping?.expenseCategory),
      INCOME: withDefault(preview.existing.incomeCategories, preview.mapping?.incomeCategory),
    };
  }, [preview]);

  const toggle = (line) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });

  const setOverride = (row, value) =>
    setOverrides((o) => {
      const next = { ...o };
      if (nameKey(value) === nameKey(row.to)) delete next[row.line];
      else next[row.line] = value;
      return next;
    });

  const confirmLabel = archive
    ? t("data.preview.confirmArchive", { n: selected.size })
    : selected.size === 1
      ? t("data.preview.confirmOne")
      : t("data.preview.confirm", { n: selected.size });

  const manifest = preview.manifest;
  const currency = preview.currency || {};

  return (
    <div className="data-step">
      <h3>
        {t("data.preview.title")} · {t(`data.format.${preview.format}`)}
      </h3>
      {manifest && manifest.exportedAt && (
        <p className="data-hint">
          {t("data.preview.archiveFrom", {
            wallet: (manifest.wallet && manifest.wallet.name) || "?",
            date: formatDate(new Date(manifest.exportedAt)),
          })}
        </p>
      )}
      <p>{t("data.preview.summary", preview.totals)}</p>
      {currency.file && currency.file !== currency.wallet && (
        <p className="data-warning">
          {t("data.preview.currencyMismatch", { file: currency.file, wallet: currency.wallet })}
        </p>
      )}

      <div className="data-block">
        <h4>{t("data.preview.create")}</h4>
        {needed.length === 0 ? (
          <p className="data-hint">{t("data.preview.createNone")}</p>
        ) : (
          <ul className="data-list">
            {needed.map((c) => (
              <li key={`${c.kind}|${c.name}`}>
                <strong>{c.name}</strong> <span className="data-muted">{t(`data.preview.kind.${c.kind}`)}</span>
              </li>
            ))}
          </ul>
        )}
        {preview.reused.length > 0 && (
          <p className="data-hint">{t("data.preview.reused", { list: preview.reused.join(", ") })}</p>
        )}
        {archive && (
          <p className="data-hint">
            {t("data.preview.holdings", { add: preview.holdings.add, skipped: preview.holdings.skipped.length })}
            <br />
            {t("data.preview.snapshots", { add: preview.snapshots.add, skipped: preview.snapshots.skipped.length })}
          </p>
        )}
        {preview.holdingTypes.length > 0 && (
          <p className="data-hint">{t("data.preview.holdingTypes", { list: preview.holdingTypes.join(", ") })}</p>
        )}
        {preview.issues.length > 0 && (
          <div className="data-warning">
            {t("data.preview.issues")}
            <ul className="data-list">
              {preview.issues.slice(0, 50).map((i) => (
                <li key={`${i.file}|${i.line}`}>
                  {t("data.issue", { file: i.file, line: i.line, error: t(`data.rowError.${i.code}`) })}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {preview.rows.length > 0 && (
        <>
          <div className="data-filter">
            {[
              ["all", preview.totals.rows],
              ["selected", selected.size],
              ["errors", preview.totals.errors],
              ["duplicates", preview.totals.duplicates],
            ].map(([f, n]) => (
              <button
                key={f}
                type="button"
                className={`data-chip${filter === f ? " active" : ""}`}
                aria-pressed={filter === f}
                onClick={() => {
                  setFilter(f);
                  setPage(0);
                }}
              >
                {t(`data.preview.filter.${f}`)} <span className="data-count">{n}</span>
              </button>
            ))}
            <span className="data-spacer" />
            <button
              type="button"
              className="data-link"
              onClick={() => setSelected(new Set(preview.rows.filter((r) => r.errors.length === 0).map((r) => r.line)))}
            >
              {t("data.preview.selectAll")}
            </button>
            <button type="button" className="data-link" onClick={() => setSelected(new Set())}>
              {t("data.preview.selectNone")}
            </button>
          </div>

          <div className="data-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th aria-label={t("data.preview.filter.selected")} />
                  <th>{t("data.preview.line")}</th>
                  <th>{t("common.date")}</th>
                  <th>{t("data.preview.type")}</th>
                  <th>{t("form.roleFrom")}</th>
                  <th>{t("form.roleTo")}</th>
                  <th className="data-num">{t("common.amount")}</th>
                  <th>{t("form.note")}</th>
                  <th>{t("data.preview.status")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={9} className="data-empty">
                      {t("data.preview.empty")}
                    </td>
                  </tr>
                )}
                {shown.map((r) => {
                  const invalid = r.errors.length > 0;
                  const chosen = selected.has(r.line);
                  const options = bank && !invalid ? categoryOptions[r.type] : null;
                  return (
                    <tr key={r.line} className={invalid ? "data-invalid" : chosen ? undefined : "data-unselected"}>
                      <td>
                        <input
                          type="checkbox"
                          checked={chosen}
                          disabled={invalid}
                          onChange={() => toggle(r.line)}
                          aria-label={`${t("data.preview.line")} ${r.line}`}
                        />
                      </td>
                      <td className="data-muted">{r.line}</td>
                      <td>{r.date ? formatDate(new Date(`${r.date}T00:00:00`), { dateStyle: "short" }) : "—"}</td>
                      <td>{r.type ? t(TYPE_LABEL[r.type]) : "—"}</td>
                      <td>
                        {r.from || "—"}
                        {r.fromNew && <span className="data-badge data-new">{t("data.preview.new")}</span>}
                      </td>
                      <td>
                        {options ? (
                          <select value={overrides[r.line] ?? r.to} onChange={(e) => setOverride(r, e.target.value)}>
                            {options.map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <>
                            {r.to || "—"}
                            {r.toNew && <span className="data-badge data-new">{t("data.preview.new")}</span>}
                          </>
                        )}
                      </td>
                      <td className="data-num">
                        {r.amount != null ? <Amount amount={r.amount} color={TYPE_COLOR[r.type]} size={14} /> : "—"}
                      </td>
                      <td className="data-note">{r.note}</td>
                      <td>
                        {invalid && (
                          <span className="data-badge data-error">
                            {r.errors.map((c) => t(`data.rowError.${c}`)).join(" · ")}
                          </span>
                        )}
                        {r.duplicate && (
                          <span className="data-badge data-warn">
                            {t(r.duplicate === "wallet" ? "data.preview.duplicateWallet" : "data.preview.duplicateFile")}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pages > 1 && (
            <div className="data-pager">
              <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>
                {t("data.preview.previous")}
              </button>
              <span>
                {t("data.preview.page", {
                  from: current * PAGE_SIZE + 1,
                  to: Math.min(rows.length, (current + 1) * PAGE_SIZE),
                  total: rows.length,
                })}
              </span>
              <button type="button" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                {t("data.preview.next")}
              </button>
            </div>
          )}
        </>
      )}

      <div className="data-actions">
        {onBack && (
          <button type="button" className="data-button" onClick={onBack} disabled={busy}>
            {t("data.mapping.edit")}
          </button>
        )}
        <button type="button" className="data-button" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="data-button data-primary"
          onClick={onCommit}
          disabled={busy || (!archive && selected.size === 0)}
        >
          {busy ? t("data.preview.importing") : confirmLabel}
        </button>
      </div>
    </div>
  );
}

export default DataTransfer;
