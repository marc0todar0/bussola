// ---------------------------------------------------------------------------
// Reading a bank notification with a language model
// ---------------------------------------------------------------------------
// One language model with structured output reads the notification and fills
// the whole draft: amount, currency, date, merchant, type, account, category
// and, for a transfer, the other account. No rules per bank or per language:
// the model is told the wallet's own names and answers with a JSON object
// whose choices are *enums of those names*, so it cannot invent an account.
//
// The model is any OpenAI-compatible chat-completions endpoint, named by
// BUSSOLA_AI_URL (its base, e.g. https://api.groq.com/openai/v1 for a hosted
// one, or http://host:11434/v1 for an Ollama, llama.cpp or LM Studio you run
// yourself), BUSSOLA_AI_MODEL and, if it needs one, BUSSOLA_AI_API_KEY. Bussola
// ships no model and downloads none. What is sent: the notification's text,
// the wallet's account and category names, the user's bank names and up to five
// lines of history -- and, unless the endpoint is on your own network, that
// leaves the machine (aiCloud()). The key is only ever put in the
// Authorization header: it is not logged, not in an error, not in any answer.
// Measured on 40 real-world notifications (tools/ai-eval/): qwen3.5:4b gets
// amount, merchant, accounts and category right every time, the type 39 times
// out of 40.
//
// Not every notification is a movement: a bank app also announces offers,
// features, security tips, statements and weekly summaries. The first field of
// the answer, `kind`, says which it is; "other" is dropped by the controller
// (dismissed on the spot, its text cleared) and never becomes a draft. The
// prompt leans the other way when unsure: a draft that turns out to be noise
// costs a click, a movement taken for noise is lost.
//
// This module is pure: no database. The inbox controller loads the context
// inside RLS, calls readNotification() with no transaction open (a reading
// takes seconds), and maps the answer back inside RLS again. Whatever the
// model says is a proposal: a person confirms it in the form.
//
// The notification's text is never logged, nor the model's answer: they can
// carry more than a transaction does (a card's digits, a balance).

// A hosted model answers in seconds; a small model on a CPU takes 10-15 s and
// more when it is loading: two minutes is generous for both.
const CHAT_TIMEOUT_MS = 120 * 1000;
const MERCHANT_MAX = 255;
const HISTORY_MAX = 5;

const TYPES = ["expense", "income", "transfer"];
const KINDS = ["transaction", "other"];
const TYPE_IDS = { expense: 1, income: 2, transfer: 3 };

const aiUrl = () => String(process.env.BUSSOLA_AI_URL || "").trim().replace(/\/+$/, "");
const aiModel = () => String(process.env.BUSSOLA_AI_MODEL || "").trim();
const aiApiKey = () => String(process.env.BUSSOLA_AI_API_KEY || "").trim();
const aiEnabled = () => Boolean(aiUrl()) && Boolean(aiModel());
// Whether the endpoint is on the owner's own network: localhost, a private
// address, a .local name or a bare name such as a compose service. Anything
// else is taken to be somebody else's server.
const isLocalHost = (hostname) => {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h === "::1" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (!h.includes(".") && !h.includes(":")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return /^(fc|fd|fe80)/.test(h);
};
// Whether the text leaves the owner's network: only a yes or no, for the About
// page; never the host, the model or the key.
const aiCloud = () => {
  if (!aiEnabled()) return false;
  try {
    return !isLocalHost(new URL(aiUrl()).hostname);
  } catch {
    return true;
  }
};
// Where the notifications go, for the startup line: the host only, since a
// base URL may carry an account id.
const aiHost = () => {
  try {
    return new URL(aiUrl()).host;
  } catch {
    return "?";
  }
};

// An error whose message is safe to log: a code, never the text read.
// `retryAfterMs` is what the endpoint asked us to wait (a 429's Retry-After),
// when it said.
class AiError extends Error {
  constructor(code, retryAfterMs = null) {
    super(code);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

// Whether a failed reading is worth trying again later, by its code. A quota
// (429), a server error (5xx), a timeout and an endpoint that cannot be
// reached are the endpoint's passing trouble: waiting mends them. A refused key
// (401, 403), a model that does not exist (404), any other status and an
// answer that is not the JSON asked for are not: the same question would get
// the same answer, so the item is left for the hand at once.
const TRANSIENT = new Set(["AI_RATE_LIMITED", "AI_TIMEOUT", "AI_UNREACHABLE", "AI_HTTP_408"]);
const isTransient = (reason) => TRANSIENT.has(reason) || /^AI_HTTP_5\d\d$/.test(String(reason || ""));

// A Retry-After header, in milliseconds from `now`: either a number of seconds
// or an HTTP date. Anything else, or a moment already past, is null.
const parseRetryAfter = (value, now = Date.now()) => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const ms = Math.round(Number(s) * 1000);
    return ms > 0 ? ms : null;
  }
  const at = Date.parse(s);
  if (Number.isNaN(at)) return null;
  return at > now ? at - now : null;
};

// Names, case-insensitively unique, in the order given. Two categories of
// different kinds may share a name ("Other"): the enum needs it once, and the
// type says which of the two it is.
const uniqueNames = (rows) => {
  const seen = new Map();
  for (const r of rows || []) {
    const name = String(r.name || "").trim();
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()];
};

const quoteList = (names) => (names.length ? names.map((n) => JSON.stringify(n)).join(", ") : "(none)");

// A line of history, as context and never as a rule: what this wallet did the
// last times a description that appears in the notification was recorded.
const historyLine = (h) => {
  const what =
    h.type === "transfer"
      ? `transfer from account ${JSON.stringify(h.account)} to account ${JSON.stringify(h.counterpart)}`
      : `${h.type}, category ${JSON.stringify(h.counterpart)}, account ${JSON.stringify(h.account)}`;
  return `- ${JSON.stringify(h.description)}: ${what}${h.count > 1 ? ` (${h.count} times)` : ""}`;
};

// The prompt and the JSON schema for one notification. `accounts`,
// `expenseCategories` and `incomeCategories` are the wallet's rows ({id,
// name}), read inside RLS; `bankNames` the sender's own names; `history` the
// lines of history.js; `today` YYYY-MM-DD on the server's clock.
const buildRequest = ({
  text,
  source,
  accounts = [],
  expenseCategories = [],
  incomeCategories = [],
  currency = "EUR",
  bankNames = [],
  history = [],
  today,
}) => {
  const accountNames = uniqueNames(accounts);
  const expense = uniqueNames(expenseCategories);
  const income = uniqueNames(incomeCategories);
  const categories = uniqueNames([...expense, ...income].map((name) => ({ name })));

  const schema = {
    type: "object",
    properties: {
      // First: the model decides what the notification is before it fills in
      // anything else. For "other" the rest is null.
      kind: { enum: KINDS },
      amount: { type: ["number", "null"] },
      currency: { type: ["string", "null"] },
      date: { type: ["string", "null"] },
      merchant: { type: ["string", "null"] },
      type: { enum: [...TYPES, null] },
      account: { enum: accountNames.length ? [...accountNames, null] : [null] },
      category: { enum: [...categories, null] },
      other_account: { enum: [...accountNames, null] },
      direction: { enum: ["out", "in", null] },
    },
    // In this order: the model writes the fields as listed, so it names the
    // account before it says which way the money went through it.
    required: ["kind", "amount", "currency", "date", "merchant", "type", "account", "category", "other_account", "direction"],
  };

  const names = (bankNames || []).map((n) => String(n).trim()).filter(Boolean);
  const system = [
    "You turn one bank notification into a draft transaction for a personal finance app.",
    `The user's own accounts are: ${quoteList(accountNames)}.`,
    `Expense categories: ${quoteList(expense)}. Income categories: ${quoteList(income)}.`,
    `The wallet's currency is ${currency}.${today ? ` Today is ${today}.` : ""}`,
    names.length
      ? `The user's own names, as banks write them: ${quoteList(names)}. ` +
        "A movement between two parties that are both the user is a transfer."
      : null,
    "First decide `kind`:",
    "- transaction: the notification reports ONE movement of money that already happened or was ordered: a card payment, a transfer sent or received, a top-up, a withdrawal, a direct debit, interest or a reward paid, a crypto buy or sell, a deposit.",
    "- other: everything else -- offers, promotions and marketing, new features, tips, security alerts, login or verification codes, statements and balance summaries, reminders, price alerts, surveys, news.",
    "  A text that only mentions an amount as an offer, a limit, a fee schedule or a balance is other.",
    "If it is other, answer kind other and null in every other field.",
    "When it is plausibly a real movement, even with little detail, answer transaction: a movement taken for noise is lost, a draft that turns out to be noise only costs a click.",
    "Rules for the fields (for a transaction):",
    "- amount: the money amount as a positive number; currency: its ISO code (or the asset's ticker).",
    "- date: YYYY-MM-DD if the notification states one, else null.",
    "- merchant: who was paid or who paid, as written, else null.",
    "- type: expense (money paid to someone else), income (money from someone else, interest, rewards),",
    "  transfer (money moving between two of the user's OWN accounts: top-ups, deposits or withdrawals between them, the user's own name on both sides).",
    "- account: the user's account where this happened (usually the app that sent the notification).",
    "- category: for an expense one expense category, for an income one income category, for a transfer null.",
    "- other_account: for a transfer the user's account on the other side, otherwise null.",
    "- direction: which way the money went through `account`, read from the notification's own words:",
    "  out if it left `account` (a payment, a transfer the user made or ordered to someone or to another account, a withdrawal);",
    "  in if it arrived in `account` (money received or credited from someone or from another account).",
    "  An account named after 'to' or its equivalent is where the money went: it is other_account, and direction is out.",
    "Answer with the JSON only.",
  ]
    .filter(Boolean)
    .join("\n");

  const lines = [`Notification from the app ${source || "unknown"}:`, String(text || "")];
  const past = (history || []).slice(0, HISTORY_MAX);
  if (past.length) {
    lines.push("How similar payments were recorded before in this wallet (context, not a rule):");
    for (const h of past) lines.push(historyLine(h));
  }

  return { system, user: lines.join("\n"), schema };
};

// fetch with a deadline. An abort is a timeout; anything that never reached
// the endpoint is AI_UNREACHABLE.
const post = async (url, body, timeoutMs, fetchImpl = fetch, headers = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    const retryAfter = res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
    return { status: res.status, json, retryAfter };
  } catch (error) {
    if (controller.signal.aborted) throw new AiError("AI_TIMEOUT");
    void error;
    throw new AiError("AI_UNREACHABLE");
  } finally {
    clearTimeout(timer);
  }
};

// The model's text, as the object it must be: JSON, not an array.
const parseAnswer = (content) => {
  if (typeof content !== "string") throw new AiError("AI_BAD_ANSWER");
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new AiError("AI_BAD_ANSWER");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AiError("AI_BAD_ANSWER");
  return parsed;
};

// One question to the OpenAI-compatible /chat/completions, answered as the
// schema says (response_format json_schema, best-effort rather than strict:
// strict modes insist on a schema shape ours, with its nullable enums, does
// not have, and toDraft() checks every field anyway). A 429 is a quota (its
// Retry-After kept, for the backoff), 401 and 403 a bad key, 404 a model that
// is not there: each a failed reading, which isTransient() sorts into the ones
// tried again later and the ones left for the hand. The key goes in the header
// and nowhere else.
const askModel = async (
  request,
  { url = aiUrl(), model = aiModel(), apiKey = aiApiKey(), timeoutMs = CHAT_TIMEOUT_MS, fetchImpl } = {},
) => {
  const body = {
    model,
    temperature: 0,
    stream: false,
    response_format: { type: "json_schema", json_schema: { name: "notification", strict: false, schema: request.schema } },
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
  };
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const answer = await post(`${url}/chat/completions`, body, timeoutMs, fetchImpl, headers);
  if (answer.status === 429) throw new AiError("AI_RATE_LIMITED", parseRetryAfter(answer.retryAfter));
  if (answer.status === 401 || answer.status === 403) throw new AiError("AI_AUTH");
  if (answer.status === 404) throw new AiError("AI_MODEL_MISSING");
  if (answer.status !== 200) throw new AiError(`AI_HTTP_${answer.status}`);
  const choice = answer.json && Array.isArray(answer.json.choices) && answer.json.choices[0];
  return parseAnswer(choice && choice.message && choice.message.content);
};

// ---------------------------------------------------------------------------
// From the model's answer to a draft
// ---------------------------------------------------------------------------
const byName = (rows, name) => {
  if (typeof name !== "string" || !name.trim()) return null;
  const key = name.trim().toLowerCase();
  const row = (rows || []).find((r) => String(r.name || "").trim().toLowerCase() === key);
  return row ? row.id : null;
};

// A positive amount with at most two decimals; 12.4000001 is 12.40, 0.0021 is
// nothing (a fraction of a cent is not an amount in the wallet's unit).
const cleanAmount = (value) => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 1e12) return null;
  const cents = Math.round(n * 100);
  if (cents <= 0 || Math.abs(cents - n * 100) > 1e-6) return null;
  return cents / 100;
};

const cleanCurrency = (value) => {
  const s = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{2,10}$/.test(s) ? s : null;
};

const addDays = (ymd, days) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
};

// YYYY-MM-DD, a day that exists, and not after tomorrow (a notification from
// a phone in another time zone may be a day ahead; later than that is a
// misreading). Anything else is null: the item keeps the day it arrived.
const cleanDate = (value, today) => {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
  if (y < 1970) return null;
  const s = `${m[1]}-${m[2]}-${m[3]}`;
  if (today && s > addDays(today, 1)) return null;
  return s;
};

const cleanMerchant = (value) => {
  if (typeof value !== "string") return null;
  const s = value.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, MERCHANT_MAX) : null;
};

// The model's answer, as a draft with ids. Every name is looked up among the
// rows it was offered (the wallet's own, read inside RLS): a name that is not
// there -- the schema should prevent it, a model may still try -- is null.
// The controller then checks the ends once more under RLS (checkEnds).
const toDraft = (answer, { accounts = [], expenseCategories = [], incomeCategories = [], today } = {}) => {
  // Only an explicit "other" drops the notification: an answer with no kind
  // (an older model, a malformed one) is read as a transaction, as it always was.
  if (answer.kind === "other") return { skip: true };
  const type = TYPES.includes(answer.type) ? answer.type : null;
  const typeId = type ? TYPE_IDS[type] : null;
  const accountId = byName(accounts, answer.account);
  let fromId = accountId;
  let toId = null;

  if (type === "transfer") {
    let other = byName(accounts, answer.other_account);
    if (other === accountId) other = null;
    if (answer.direction === "in") {
      fromId = other;
      toId = accountId;
    } else {
      toId = other;
    }
  } else if (type === "expense") {
    toId = byName(expenseCategories, answer.category);
  } else if (type === "income") {
    toId = byName(incomeCategories, answer.category);
  }

  return {
    amount: cleanAmount(answer.amount),
    currency: cleanCurrency(answer.currency),
    date: cleanDate(answer.date, today),
    merchant: cleanMerchant(answer.merchant),
    typeId,
    fromId,
    toId,
  };
};

// The whole reading: prompt, model, draft. Never throws; logs one line,
// without the text. `label` names the item in the log. A failure says whether
// it is worth trying again (`transient`) and, if the endpoint said, after how
// long (`retryAfterMs`).
const readNotification = async (context, { label = "item", ...options } = {}) => {
  const started = Date.now();
  try {
    const request = buildRequest(context);
    const answer = await askModel(request, options);
    const draft = toDraft(answer, context);
    console.log(`[ai] ${label}: ${draft.skip ? "not a transaction, dropped" : "read"} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    return draft.skip ? { ok: true, skip: true } : { ok: true, draft };
  } catch (error) {
    const reason = error instanceof AiError ? error.code : "AI_FAILED";
    const transient = isTransient(reason);
    console.error(`[ai] ${label}: could not be read (${reason})`);
    const retryAfterMs = error instanceof AiError && error.retryAfterMs ? error.retryAfterMs : null;
    return { ok: false, reason, transient, retryAfterMs };
  }
};

module.exports = {
  aiEnabled,
  aiCloud,
  aiUrl,
  aiModel,
  aiHost,
  buildRequest,
  askModel,
  toDraft,
  readNotification,
  isTransient,
  parseRetryAfter,
  AiError,
};
