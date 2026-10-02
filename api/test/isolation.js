#!/usr/bin/env node
// ===========================================================================
// Isolation test between wallets
// ===========================================================================
// Creates users with deliberately similar data in separate wallets, then
// exercises every endpoint as user A and checks that nothing belonging to B
// ever appears in a response.
//
// Since data belongs to a wallet rather than to a person, the test also has to
// cover the other half of the arrangement: a wallet shared read-only really is
// readable and really is not writable, a wallet you were never invited to
// cannot be selected, and losing your membership takes effect at once.
//
// The wallet itself is a belonging like the rest of them: renaming or deleting
// one is refused to a read-only member and to a stranger alike, the first
// wallet of an account cannot be deleted at all, and a deletion that does go
// through has to be confirmed by name -- to the server, not merely to a dialog.
//
// The inbox is data like the rest, and the personal tokens that feed it are
// credentials of the narrowest kind: a token posts drafts to its own wallet
// and opens nothing else, an id of another wallet's account in a draft is
// dropped, and losing the right to write makes a token useless at once.
//
// This is the defence against the leak introduced by inattention: a new query
// that forgets its filter, or an endpoint wired to the read-only wrapper by
// mistake, makes no noise until it is too late. Here it fails the test.
//
//   node api/test/isolation.js            (against http://127.0.0.1:3001)
//   BASE_URL=http://... node api/test/isolation.js
//
// The instance under test must have BUSSOLA_SIGNUP=open: the test creates its
// own users. Never point it at an instance holding real data -- it writes and
// deletes.
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3001").replace(/\/$/, "");

// Every string B writes to the database contains this marker. If even one
// response to A contains it, that is a leak.
//
// Unique per run: without that, a second pass would find the first pass's
// marked rows -- which belong to a different user -- and fail during setup
// instead of measuring what it is meant to measure.
//
// The run's suffix is kept apart from the marker, and the usernames are built
// from the suffix alone. Were the accounts called after the marker instead, an
// endpoint that legitimately returns *A's own* username -- the profile
// endpoints do -- would look like a leak of B's data.
const RUN = Date.now().toString(36);
const MARK_B = `ZZTOPSECRETB${RUN}`;

const results = [];
let failures = 0;

const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
// An HTTP client that remembers the session cookie
// ---------------------------------------------------------------------------
// Every file in a ZIP, as one string. fflate is the API's own dependency (the
// export writes with it); it is required here, lazily, so that a missing
// install fails the archive checks loudly instead of letting them pass on
// bytes nobody could read.
const unzippedText = (bytes) => {
  let fflate;
  try {
    fflate = require("fflate");
  } catch {
    throw new Error("reading the wallet export needs fflate: run `yarn install` in api/");
  }
  const files = fflate.unzipSync(new Uint8Array(bytes));
  return Object.entries(files)
    .map(([name, data]) => `${name}\n${fflate.strFromU8(data)}`)
    .join("\n");
};

// An import request: the file travels base64-encoded inside the JSON body.
const importRequest = (content, extra = {}) => ({
  file: Buffer.from(content).toString("base64"),
  ...extra,
});

// One transaction of A's, in the export's own format. Its category does not
// exist yet, so the import also creates something -- in A's wallet.
const OWN_IMPORT =
  "date,type,amount,from,to,note\r\n" +
  "2026-01-15,EXPENSE,3.5,A's account,A's imported category,A's import\r\n";

const createClient = () => {
  let cookie = null;

  return async (method, path, body) => {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers["Cookie"] = cookie;

    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const setCookies = response.headers.getSetCookie
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    for (const c of setCookies) {
      if (c.startsWith("bussola_sess=")) cookie = c.split(";")[0];
    }

    // The bytes are kept as well as the text: the wallet export is a ZIP, and
    // the test imports it back. For the leak check a ZIP is read as what it
    // contains -- its bytes are deflated, and B's marker would pass through
    // them unseen.
    const bytes = Buffer.from(await response.arrayBuffer());
    const zipped = /zip/.test(response.headers.get("content-type") || "");
    const text = zipped ? unzippedText(bytes) : bytes.toString("utf8");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* some responses are not JSON: keep the text */
    }
    return { status: response.status, text, json, bytes };
  };
};

// A request carrying a personal API token instead of a session: what an
// iPhone Shortcut or an Android app sends to the inbox. No cookie, ever.
const tokenCall = async (token, method, path, body) => {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: response.status, text, json };
};

// The secrets of the tokens A and B make: kept out of the resources printed
// below, because a token is a credential even on a test instance.
const tokenSecrets = {};

// Responses have different shapes depending on the endpoint (flat lists,
// grouped by date, objects with .data): searching depth-first saves having to
// know the structure of each one.
const search = (node, predicate) => {
  if (Array.isArray(node)) {
    for (const v of node) {
      const found = search(v, predicate);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    if (predicate(node)) return node;
    for (const v of Object.values(node)) {
      const found = search(v, predicate);
      if (found) return found;
    }
  }
  return null;
};

const hasMark = (field) => (o) => typeof o[field] === "string" && o[field].includes(MARK_B);

// ---------------------------------------------------------------------------
// A software authenticator, for the passkey checks
// ---------------------------------------------------------------------------
// A real passkey needs a real device and a finger on it, which a script does
// not have. What the server checks, though, is only arithmetic: a P-256 key
// pair, a CBOR-encoded attestation of the "none" format, and ECDSA signatures
// over authenticatorData + sha256(clientDataJSON). That much can be done here,
// so the ceremonies are exercised end to end -- everything except the browser
// and the fingerprint, which no test on this side of the screen can reach.
const crypto = require("node:crypto");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (data) => crypto.createHash("sha256").update(data).digest();

// The sliver of CBOR this needs: small integers of either sign, byte strings,
// text strings and maps.
const cborHead = (major, n) => {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(n, 1);
  return b;
};
const cbor = (v) => {
  if (typeof v === "number") return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    return Buffer.concat([cborHead(3, s.length), s]);
  }
  if (v instanceof Map) {
    const parts = [cborHead(5, v.size)];
    for (const [k, x] of v) parts.push(cbor(k), cbor(x));
    return Buffer.concat(parts);
  }
  throw new Error("cbor: unsupported value");
};

const createAuthenticator = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = crypto.randomBytes(16);
  const id = b64u(credentialId);
  let counter = 0;
  let userHandle = null;

  // User present and user verified: the fingerprint the server insists on.
  const UP_UV = 0x01 | 0x04;
  const counterBytes = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const clientData = (type, challenge, origin) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const coseKey = cbor(new Map([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, Buffer.from(jwk.x, "base64url")],
    [-3, Buffer.from(jwk.y, "base64url")],
  ]));

  return {
    id,
    register(options, origin) {
      userHandle = options.user.id;
      const authData = Buffer.concat([
        sha256(options.rp.id),
        Buffer.from([UP_UV | 0x40]), // + attested credential data
        counterBytes(counter),
        Buffer.alloc(16), // aaguid: none
        Buffer.from([0, credentialId.length]),
        credentialId,
        coseKey,
      ]);
      const attestationObject = cbor(new Map([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]));
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: b64u(clientData("webauthn.create", options.challenge, origin)),
          attestationObject: b64u(attestationObject),
          transports: ["internal"],
        },
      };
    },
    // `forge` signs with a key nobody registered: a bad signature on a
    // credential id the server does know.
    assert(options, origin, { forge = false } = {}) {
      counter += 1;
      const authData = Buffer.concat([sha256(options.rpId), Buffer.from([UP_UV]), counterBytes(counter)]);
      const cd = clientData("webauthn.get", options.challenge, origin);
      const key = forge
        ? crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey
        : privateKey;
      const signature = crypto.sign("sha256", Buffer.concat([authData, sha256(cd)]), key);
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: b64u(cd),
          authenticatorData: b64u(authData),
          signature: b64u(signature),
          userHandle,
        },
      };
    },
  };
};

// The two ceremonies as the frontend runs them: options, device, verify.
const registerPasskey = async (client, password, name, origin, authenticator) => {
  const options = await client("POST", "/api/auth/passkeys/register/options", { password });
  if (options.status !== 200) return { options, verify: null };
  const verify = await client("POST", "/api/auth/passkeys/register/verify", {
    response: authenticator.register(options.json, origin),
    name,
  });
  return { options, verify };
};

const passkeySignIn = async (client, authenticator, origin, how) => {
  const options = await client("POST", "/api/auth/passkeys/login/options");
  if (options.status !== 200) return options;
  return client("POST", "/api/auth/passkeys/login/verify", {
    response: authenticator.assert(options.json, origin, how),
  });
};

const registerUser = async (client, username, password) => {
  const r = await client("POST", "/api/auth/signup", { username, password });
  if (r.status === 409) {
    const l = await client("POST", "/api/auth/login", { username, password });
    if (l.status !== 200) throw new Error(`login for ${username} failed: ${l.text}`);
    return l.json;
  }
  if (r.status !== 201) {
    throw new Error(
      `sign-up for ${username} failed (${r.status}): ${r.text}\n` +
        `Does the instance under test have BUSSOLA_SIGNUP=open?`,
    );
  }

  // A new account gets no wallet: it lands on the picker, and until it names
  // one every data endpoint says so.
  record(`${username}: a new account starts with no wallet`, r.json.wallet === null, JSON.stringify(r.json.wallet));
  const none = await client("GET", "/api/auth/wallets");
  record(`${username}: and has none to pick`, none.status === 200 && Array.isArray(none.json) && none.json.length === 0, none.text);
  const noData = await client("GET", "/api/accounts");
  record(`${username}: its data endpoints answer NO_WALLET_SELECTED`, noData.status === 409 && /NO_WALLET_SELECTED/.test(noData.text), `${noData.status}`);

  const created = await client("POST", "/api/auth/wallets", { name: `${username}'s wallet` });
  if (created.status !== 201) throw new Error(`creating ${username}'s wallet failed (${created.status}): ${created.text}`);
  return { ...r.json, wallet: created.json };
};

// ---------------------------------------------------------------------------
// B's data: everything marked, so a leak is recognisable at a glance
// ---------------------------------------------------------------------------
const populateB = async (b) => {
  const account = await b("POST", "/api/accounts", {
    name: `Account ${MARK_B}`,
    color: "crimson",
    icon: "bank",
    iconFamily: "FontAwesome",
    amount: 99999,
    description: `description ${MARK_B}`,
    is_investment: true,
  });

  const category = await b("POST", "/api/categories", {
    name: `Category ${MARK_B}`,
    color: "crimson",
    icon: "tag",
    iconFamily: "FontAwesome",
    isExpense: true,
    description: `expense ${MARK_B}`,
  });

  const accounts = await b("GET", "/api/accounts");
  const accountB = search(accounts.json, hasMark("name"));
  const categories = await b("GET", "/api/categories/expenses");
  const catB = search(categories.json, hasMark("name"));

  const transaction = await b("POST", "/api/transactions", {
    from_id: accountB.id,
    to_id: catB ? catB.id : accountB.id,
    amount: 12345,
    type_id: 1,
    description: `transaction ${MARK_B}`,
    tx_date: new Date().toISOString(),
  });

  // A holding type of B's own invention (they belong to a wallet): its name must never reach A, and A must not be able to use it.
  const typesB = await b("POST", "/api/holding-types", { name: `Type ${MARK_B}`, color: "crimson" });
  const typeB = search(typesB.json, hasMark("name"));

  // No ISIN: the refresh calls no external provider.
  const holding = await b("POST", `/api/accounts/${accountB.id}/holdings`, {
    name: `Holding ${MARK_B}`,
    pillar_id: 4,
    type_id: typeB && typeB.id,
    amount: 54321,
    issuer: `Issuer ${MARK_B}`,
    country: `Country ${MARK_B}`,
    auto_update: false,
  });

  await b("POST", "/api/portfolio/snapshot", {});

  const holdings = await b("GET", `/api/accounts/${accountB.id}/holdings`);
  const holdingB = search(holdings.json, hasMark("name"));

  const transactions = await b("GET", "/api/transactions");
  const transactionB = search(transactions.json, hasMark("description"));

  // A personal token of B's, named with the marker, and a notification posted
  // with it: B's inbox holds a pending item A must never see nor resolve.
  const tokenB = await b("POST", "/api/auth/tokens", { label: `Token ${MARK_B}`, password: "test-password-b" });
  tokenSecrets.b = tokenB.json && tokenB.json.token;
  // Text and draft: the draft is taken as it is, model or no model, so the
  // merchant carries the marker either way.
  await tokenCall(tokenSecrets.b, "POST", "/api/inbox", {
    source: `Phone ${MARK_B}`,
    text: `Pagamento di 7,77 € presso Shop ${MARK_B}`,
    draft: { amount: 7.77, description: `Shop ${MARK_B}` },
  });
  const inboxB = await b("GET", "/api/inbox");
  const itemB = search(inboxB.json, hasMark("merchant"));

  const resources = {
    account: accountB && accountB.id,
    category: catB && catB.id,
    transaction: transactionB && transactionB.id,
    holding: holdingB && holdingB.id,
    holdingType: typeB && typeB.id,
    token: tokenB.json && tokenB.json.id,
    inbox: itemB && itemB.id,
  };

  for (const [name, id] of Object.entries(resources)) {
    if (!id) {
      throw new Error(
        `could not prepare B's data: ${name} was not created ` +
          `(account=${account.status} category=${category.status} ` +
          `transaction=${transaction.status} holding=${holding.status} token=${tokenB.status} ` +
          `inbox=${inboxB.status})`,
      );
    }
  }
  return resources;
};

// ---------------------------------------------------------------------------
// A sets up their own data, so the test does not run against an empty account
// ---------------------------------------------------------------------------
const populateA = async (a) => {
  await a("POST", "/api/accounts", {
    name: "A's account",
    color: "steelblue",
    icon: "bank",
    iconFamily: "FontAwesome",
    amount: 1000,
    is_investment: true,
  });

  const accounts = await a("GET", "/api/accounts");
  const accountA = search(accounts.json, (c) => c.name === "A's account");

  const categories = await a("GET", "/api/categories/expenses");
  const catA = search(categories.json, (c) => typeof c.name === "string" && typeof c.icon === "string");

  await a("POST", "/api/transactions", {
    from_id: accountA.id,
    to_id: catA.id,
    amount: 50,
    type_id: 1,
    description: "A's transaction",
    tx_date: new Date().toISOString(),
  });

  await a("POST", `/api/accounts/${accountA.id}/holdings`, {
    name: "A's holding",
    pillar_id: 4,
    amount: 500,
    issuer: "A's issuer",
    auto_update: false,
  });

  // The read-only checks further down need something of A's to aim at, so the
  // ids are read back rather than only created.
  const holdings = await a("GET", `/api/accounts/${accountA.id}/holdings`);
  const holdingA = search(holdings.json, (h) => h.name === "A's holding");

  const transactions = await a("GET", "/api/transactions");
  const transactionA = search(transactions.json, (m) => m.description === "A's transaction");

  // A holding type of A's own, for the read-only member to fail to delete.
  const typesA = await a("POST", "/api/holding-types", { name: "A's own type", color: "steelblue" });
  const typeA = search(typesA.json, (t) => t.name === "A's own type");

  // A's phone, and a notification it sent that stays pending: the read-only
  // member must fail to accept or dismiss it.
  const tokenA = await a("POST", "/api/auth/tokens", { label: "A's phone", password: "test-password-a" });
  tokenSecrets.a = tokenA.json && tokenA.json.token;
  await tokenCall(tokenSecrets.a, "POST", "/api/inbox", {
    source: "A's phone",
    text: "Pagamento di 3,20 € presso Pending shop of A",
    draft: { amount: 3.2, description: "Pending shop of A" },
  });
  const inboxA = await a("GET", "/api/inbox");
  const itemA = search(inboxA.json, (i) => i.merchant === "Pending shop of A");
  if (!tokenSecrets.a || !itemA) {
    throw new Error(`could not prepare A's inbox: token=${tokenA.status} ${tokenA.text.slice(0, 120)} inbox=${inboxA.text.slice(0, 120)}`);
  }

  return {
    account: accountA.id,
    category: catA.id,
    holding: holdingA && holdingA.id,
    holdingType: typeA && typeA.id,
    transaction: transactionA && transactionA.id,
    token: tokenA.json.id,
    inbox: itemA.id,
  };
};

// Every endpoint that writes, all 28 of them. A read-only member must be
// turned away from all of them, and the list is spelled out rather than derived
// so that adding a write endpoint without adding it here is a visible omission.
//
// The fourth element is the code the refusal must carry, and defaults to
// READ_ONLY. The two wallet endpoints at the end are the exception: they do not
// write the wallet's data but the wallet itself, and a member who only reads is
// not its manager either, so what comes back is NOT_WALLET_MANAGER.
const writeEndpoints = (of, wallet) => [
  ["POST", "/api/accounts", { name: "nope", color: "gray", icon: "bank", iconFamily: "FontAwesome", amount: 1 }],
  ["POST", `/api/accounts/${of.account}`, { name: "nope", color: "gray", icon: "bank", iconFamily: "FontAwesome", amount: 1 }],
  ["POST", `/api/accounts/${of.account}/archive`, { archived: true }],
  ["DELETE", `/api/accounts/${of.account}`],
  ["POST", "/api/categories", { name: "nope", color: "gray", icon: "tag", iconFamily: "FontAwesome", isExpense: true }],
  ["POST", `/api/categories/${of.category}`, { name: "nope", color: "gray", icon: "tag", iconFamily: "FontAwesome", isExpense: true }],
  ["POST", `/api/categories/${of.category}/archive`, { archived: true }],
  ["DELETE", `/api/categories/${of.category}`],
  ["POST", "/api/holding-types", { name: `nope ${Date.now()}`, color: "gray" }],
  ["DELETE", `/api/holding-types/${of.holdingType}`],
  ["POST", `/api/accounts/${of.account}/holdings`, { name: "nope", pillar_id: 1, amount: 1, auto_update: false }],
  ["POST", "/api/holdings/refresh-all"],
  ["POST", `/api/holdings/${of.holding}`, { name: "nope", pillar_id: 1, amount: 1, auto_update: false }],
  ["DELETE", `/api/holdings/${of.holding}`],
  ["POST", `/api/accounts/${of.account}/holdings/refresh`],
  ["POST", `/api/holdings/${of.holding}/refresh`],
  ["POST", "/api/transactions", { from_id: of.account, to_id: of.category, amount: 1, type_id: 1, description: "nope", tx_date: new Date().toISOString() }],
  ["POST", `/api/transactions/${of.transaction}`, { from_id: of.account, to_id: of.category, amount: 1, type_id: 1, description: "nope", tx_date: new Date().toISOString() }],
  ["DELETE", `/api/transactions/${of.transaction}`],
  ["POST", "/api/portfolio/snapshot", {}],
  ["POST", `/api/auth/wallets/${wallet.id}/name`, { name: "nope" }, "NOT_WALLET_MANAGER"],
  // The currency is guarded by the same rule as the rename, and for the same
  // reason: every member reads these numbers, so the unit they are counted in
  // is not each member's to change.
  ["POST", `/api/auth/wallets/${wallet.id}/currency`, { currency: "USD" }, "NOT_WALLET_MANAGER"],
  ["DELETE", `/api/auth/wallets/${wallet.id}`, { confirm: wallet.name }, "NOT_WALLET_MANAGER"],
  // The import writes whatever the file holds, so both halves count: the
  // preview is only ever the first step of a write.
  ["POST", "/api/data/import/preview", importRequest(OWN_IMPORT)],
  ["POST", "/api/data/import/commit", importRequest(OWN_IMPORT, { selection: { lines: [2] } })],
  // The inbox: resolving a draft writes (accepting one creates a
  // transaction), and a token exists only to write -- so a member who may
  // only read can make none, whatever password they type.
  ["POST", `/api/inbox/${of.inbox}/accept`, { from_id: of.account, to_id: of.category, amount: 1, type_id: 1, description: "nope", tx_date: new Date().toISOString() }],
  ["POST", `/api/inbox/${of.inbox}/dismiss`, {}],
  ["POST", "/api/auth/tokens", { label: "nope", password: "test-password-r" }],
];

const walletOf = async (client) => {
  const r = await client("GET", "/api/auth/wallets");
  if (r.status !== 200 || !Array.isArray(r.json) || r.json.length === 0) {
    throw new Error(`could not read the wallets (${r.status}): ${r.text}`);
  }
  return r.json[0];
};

// ---------------------------------------------------------------------------
// The 58 session endpoints, exercised as A (the inbox's two token endpoints
// are exercised with a token, in section 3f: 60 in all)
// ---------------------------------------------------------------------------
// `mine` marks a call that operates on A's own data, where a 5xx is a genuine
// failure. The others deliberately aim at B's ids and are expected to be
// rejected, so their status carries no information -- only the absence of B's
// marker in the body does.
//
// B's wallet has been renamed to carry the marker as well, so an endpoint that
// echoed back the wallet it just refused to touch would be caught here.
const MINE = true;

// What a browser's PushManager would hand over (the keys are made up: the
// server only checks their shape).
const pushSubscription = (endpoint) => ({
  endpoint,
  keys: { p256dh: `BP${"x".repeat(85)}`, auth: "a".repeat(22) },
});

const endpointsToExercise = (mine, ofB, me) => [
  // accounts and categories (22)
  ["GET", "/api/accounts", undefined, MINE],
  ["GET", "/api/categories/expenses", undefined, MINE],
  ["POST", "/api/accounts", { name: "A's new account", color: "gray", icon: "bank", iconFamily: "FontAwesome", amount: 1 }, MINE],
  ["POST", `/api/accounts/${ofB.account}`, { name: "TAKEN", color: "gray", icon: "bank", iconFamily: "FontAwesome", amount: 1 }],
  ["POST", `/api/accounts/${ofB.account}/archive`, { archived: true }],
  ["DELETE", `/api/accounts/${ofB.account}`],
  ["POST", "/api/categories", { name: "A's new cat", color: "gray", icon: "tag", iconFamily: "FontAwesome", isExpense: true }, MINE],
  ["POST", `/api/categories/${ofB.category}`, { name: "TAKEN", color: "gray", icon: "tag", iconFamily: "FontAwesome", isExpense: true }],
  ["POST", `/api/categories/${ofB.category}/archive`, { archived: true }],
  ["DELETE", `/api/categories/${ofB.category}`],
  ["GET", "/api/pillars", undefined, MINE],
  ["GET", "/api/holding-types", undefined, MINE],
  ["POST", "/api/holding-types", { name: `A's type ${Date.now()}`, color: "gray" }, MINE],
  ["DELETE", `/api/holding-types/${ofB.holdingType}`],
  ["GET", "/api/holdings/distinct/issuer", undefined, MINE],
  ["GET", "/api/holdings/distinct/country", undefined, MINE],
  ["GET", `/api/accounts/${ofB.account}/holdings`],
  ["POST", `/api/accounts/${ofB.account}/holdings/refresh`],
  ["POST", "/api/holdings/refresh-all", undefined, MINE],
  ["POST", `/api/holdings/${ofB.holding}/refresh`],
  ["POST", `/api/accounts/${ofB.account}/holdings`, { name: "Intruding holding", pillar_id: 1, amount: 1, auto_update: false }],
  ["POST", `/api/holdings/${ofB.holding}`, { name: "TAKEN", pillar_id: 1, amount: 1, auto_update: false }],
  ["DELETE", `/api/holdings/${ofB.holding}`],

  // transactions (5)
  ["GET", "/api/transactions", undefined, MINE],
  ["GET", "/api/transactions/form-data", undefined, MINE],
  ["POST", "/api/transactions", { from_id: mine.account, to_id: mine.category, amount: 1, type_id: 1, description: "A's mov", tx_date: new Date().toISOString() }, MINE],
  ["POST", `/api/transactions/${ofB.transaction}`, { from_id: mine.account, to_id: mine.category, amount: 999, type_id: 1, description: "TAKEN", tx_date: new Date().toISOString() }],
  ["DELETE", `/api/transactions/${ofB.transaction}`],

  // portfolio (5)
  ["GET", "/api/portfolio/allocation", undefined, MINE],
  ["GET", "/api/portfolio/history", undefined, MINE],
  ["GET", "/api/portfolio/allocation/issuer", undefined, MINE],
  ["GET", `/api/portfolio/snapshot/${new Date().getFullYear()}/${new Date().getMonth() + 1}`, undefined, MINE],
  ["POST", "/api/portfolio/snapshot", {}, MINE],

  // summary (3)
  ["GET", "/api/summary", undefined, MINE],
  ["GET", "/api/summary/month", undefined, MINE],
  ["GET", "/api/summary/year", undefined, MINE],

  // profile and wallet management (5)
  // The username call asks for the name A already has: the endpoint answers
  // 200 without writing, which exercises it without renaming the account the
  // rest of the test signs in as.
  ["POST", "/api/auth/username", { username: me.username, password: me.password }, MINE],
  // How A's banks write A's name: A's own setting, and nobody else's.
  ["POST", "/api/auth/bank-names", { names: ["A Person", "PERSON A"] }, MINE],
  ["POST", `/api/auth/wallets/${ofB.wallet}/name`, { name: "TAKEN" }],
  ["POST", `/api/auth/wallets/${ofB.wallet}/currency`, { currency: "USD" }],
  ["DELETE", `/api/auth/wallets/${ofB.wallet}`, { confirm: ofB.walletName }],

  // passkeys (3)
  // A passkey belongs to a person rather than a wallet, and B's is named with
  // the marker: A's list must not show it, and A's rename and delete must not
  // reach it. With passkeys off there is no real one, and ofB.passkey is an id
  // nobody has -- the endpoints are exercised all the same.
  ["GET", "/api/auth/passkeys", undefined, MINE],
  ["POST", `/api/auth/passkeys/${ofB.passkey}/name`, { name: "TAKEN" }],
  ["DELETE", `/api/auth/passkeys/${ofB.passkey}`],

  // Web Push (4)
  // A subscription belongs to a person's device. The test call comes first:
  // A has no device yet (409 NO_PUSH_SUBSCRIPTION, or 404 with push off), so
  // nothing is sent to a real push service from a test stack. B's endpoint is
  // aimed at (a stranger's is "not found"); A's own subscription goes last,
  // on an allow-listed host with made-up keys -- the server never contacts it
  // from here.
  ["POST", "/api/auth/push/test", {}, MINE],
  ["DELETE", "/api/auth/push/subscribe", { endpoint: ofB.pushEndpoint }],
  ["POST", "/api/auth/push/status", { endpoint: ofB.pushEndpoint }],
  ["POST", "/api/auth/push/subscribe", { subscription: pushSubscription(`https://fcm.googleapis.com/fcm/send/iso-a-${RUN}-endpoint-a`) }, MINE],

  // import and export (4)
  // The two exports are A's wallet as a spreadsheet and as an archive, and B's
  // marker must be in neither (the archive is searched unpacked: see
  // createClient). The import is A's own file naming A's own account; what an
  // import cannot reach is tested on its own, after this sweep.
  ["GET", "/api/data/export/transactions.csv", undefined, MINE],
  ["GET", "/api/data/export/wallet.zip", undefined, MINE],
  ["POST", "/api/data/import/preview", importRequest(OWN_IMPORT), MINE],
  ["POST", "/api/data/import/commit", importRequest(OWN_IMPORT, { selection: { lines: [2] } }), MINE],

  // inbox and personal tokens (6)
  // B's pending item and B's token are aimed at: A's session can neither
  // resolve the one nor revoke the other, and B's token's label carries the
  // marker, so a token list that showed it would be caught.
  ["GET", "/api/inbox", undefined, MINE],
  ["POST", `/api/inbox/${ofB.inbox}/accept`, { from_id: mine.account, to_id: mine.category, amount: 1, type_id: 1, description: "TAKEN", tx_date: new Date().toISOString() }],
  ["POST", `/api/inbox/${ofB.inbox}/dismiss`, {}],
  ["GET", "/api/auth/tokens", undefined, MINE],
  ["POST", "/api/auth/tokens", { label: "A's second phone", password: me.password }, MINE],
  ["DELETE", `/api/auth/tokens/${ofB.token}`],
];

const main = async () => {
  console.log(`Isolation test against ${BASE}\n`);

  const a = createClient();
  const b = createClient();
  const suffix = RUN;

  await registerUser(a, `iso-a-${suffix}`, "test-password-a");
  await registerUser(b, `iso-b-${suffix}`, "test-password-b");

  const ofB = await populateB(b);
  const mine = await populateA(a);

  // Both wallets are needed before the sweep below, which aims the wallet
  // rename and delete at B's: a wallet is one of B's belongings like any other.
  const walletA = await walletOf(a);
  const walletB = await walletOf(b);

  // B's wallet takes the marker as well, so that an endpoint echoing back the
  // wallet it has just refused to touch would show up as the leak it is. It is
  // also the rename endpoint answering on its happy path.
  const walletNameB = `Wallet ${MARK_B}`;
  const markedB = await b("POST", `/api/auth/wallets/${walletB.id}/name`, { name: walletNameB });
  record("B can rename their own wallet",
    markedB.status === 200 && markedB.json && markedB.json.name === walletNameB,
    `status ${markedB.status}: ${markedB.text.slice(0, 160)}`);

  ofB.wallet = walletB.id;
  ofB.walletName = walletNameB;

  // B's passkey, when the instance has passkeys on (BUSSOLA_PUBLIC_URL set):
  // the origin the software authenticator signs for is the one the server
  // announces, exactly as the login page compares it with its own.
  const instance = await b("GET", "/api/auth/status");
  const passkeysOn = Boolean(instance.json && instance.json.passkeys === true);
  const passkeyOrigin = instance.json && instance.json.passkeyOrigin;
  const passkeyNameB = `Passkey ${MARK_B}`;
  const authB = createAuthenticator();
  ofB.passkey = 2147483000;
  if (passkeysOn) {
    const reg = await registerPasskey(b, "test-password-b", passkeyNameB, passkeyOrigin, authB);
    record("B can add a passkey",
      Boolean(reg.verify && reg.verify.status === 201 && reg.verify.json.name === passkeyNameB),
      reg.verify ? `status ${reg.verify.status}: ${reg.verify.text.slice(0, 160)}`
        : `options ${reg.options.status}: ${reg.options.text.slice(0, 160)}`);
    if (reg.verify && reg.verify.json && reg.verify.json.id) ofB.passkey = reg.verify.json.id;
  }

  // B's Web Push subscription, when the instance has push on (it is on
  // wherever passkeys are: both follow BUSSOLA_PUBLIC_URL). The endpoint
  // carries the marker, though nothing is supposed to return it.
  const pushOn = Boolean(instance.json && instance.json.push === true);
  ofB.pushEndpoint = `https://fcm.googleapis.com/fcm/send/${MARK_B}-endpoint-b`;
  if (pushOn) {
    const sub = await b("POST", "/api/auth/push/subscribe", { subscription: pushSubscription(ofB.pushEndpoint) });
    record("B can subscribe a device to notifications", sub.status === 201, `status ${sub.status}: ${sub.text.slice(0, 160)}`);
  }
  console.log(`B's data ready: ${JSON.stringify(ofB)}\n`);

  const credentialsA = { username: `iso-a-${suffix}`, password: "test-password-a" };

  // --- 1. no response to A contains B's data -------------------------------
  for (const [method, path, body, isMine] of endpointsToExercise(mine, ofB, credentialsA)) {
    let r;
    try {
      r = await a(method, path, body);
    } catch (error) {
      record(`${method} ${path}`, false, `exception: ${error.message}`);
      continue;
    }

    const leaked = r.text.includes(MARK_B);
    record(
      `${method} ${path}`,
      !leaked,
      leaked ? `RESPONSE CONTAINS B'S DATA (${r.status}): ${r.text.slice(0, 200)}` : `${r.status}`,
    );

    // 2. an endpoint operating on A's own data must also work. Isolation that
    // holds because everything is broken is not isolation.
    if (isMine) {
      record(
        `${method} ${path} works on A's own data`,
        r.status < 500,
        `status ${r.status}: ${r.text.slice(0, 200)}`,
      );
    }
  }

  // With no quote service configured (the test stack sets none) the three
  // refresh endpoints refuse on A's own data too, with the code the interface
  // translates, and /me says so, which is what disables the buttons. With one
  // configured they were already exercised above, and a 5xx caught.
  const meA = await a("GET", "/api/auth/me");

  // The names a bank writes for its customer are a person's own setting: the
  // sweep set A's, and they are A's alone. The endpoint takes no id, so the
  // only way to reach B would be a leak through /me.
  await b("POST", "/api/auth/bank-names", { names: `B Person ${MARK_B}` });
  const meB = await b("GET", "/api/auth/me");
  const meA2 = await a("GET", "/api/auth/me");
  record("/api/auth/me shows one's own bank names, and only one's own",
    JSON.stringify(meA2.json && meA2.json.bankNames) === JSON.stringify(["A Person", "PERSON A"])
      && JSON.stringify(meB.json && meB.json.bankNames) === JSON.stringify([`B Person ${MARK_B}`])
      && !meA2.text.includes(MARK_B) && !meB.text.includes("A Person"),
    `A: ${meA2.text.slice(0, 200)} | B: ${meB.text.slice(0, 200)}`);
  const tooMany = await a("POST", "/api/auth/bank-names", { names: ["1", "2", "3", "4", "5", "6"] });
  record("more than five bank names is 400 INVALID_BANK_NAMES",
    tooMany.status === 400 && /INVALID_BANK_NAMES/.test(tooMany.text), `status ${tooMany.status}: ${tooMany.text.slice(0, 160)}`);
  record("/api/auth/me says whether a model reads the notifications",
    typeof (meA.json && meA.json.ai) === "boolean", meA.text.slice(0, 160));

  const quotesOn = Boolean(meA.json && meA.json.quotes);
  record("/api/auth/me says whether quotes are configured",
    meA.status === 200 && meA.json && typeof meA.json.quotes === "boolean",
    `status ${meA.status}: ${meA.text.slice(0, 160)}`);
  if (!quotesOn) {
    for (const path of [
      "/api/holdings/refresh-all",
      `/api/accounts/${mine.account}/holdings/refresh`,
      `/api/holdings/${mine.holding}/refresh`,
    ]) {
      const r = await a("POST", path);
      record(`POST ${path} with no quote service answers QUOTES_DISABLED`,
        r.status === 409 && r.json && r.json.code === "QUOTES_DISABLED",
        `status ${r.status}: ${r.text.slice(0, 160)}`);
    }
  }

  // --- 3. B's data is still intact -----------------------------------------
  // A tried to modify and delete it: nothing must have changed.
  const accountsB = await b("GET", "/api/accounts");
  const accountB = search(accountsB.json, (c) => c.id === ofB.account);
  record(
    "B's account survived A's attempts",
    Boolean(accountB) && accountB.name.includes(MARK_B) && accountB.archived === false,
    accountB ? `name="${accountB.name}" archived=${accountB.archived}` : "account gone",
  );

  const transactionsB = await b("GET", "/api/transactions");
  const transactionB = search(transactionsB.json, (m) => m.id === ofB.transaction);
  record(
    "B's transaction survived A's attempts",
    Boolean(transactionB) && String(transactionB.description).includes(MARK_B),
    transactionB ? `description="${transactionB.description}"` : "transaction gone",
  );

  // --- 3b. holding types: the seeded ones are shared, invented ones are not --
  // A tried to delete B's type in the sweep above; it has to be there still,
  // and B's holding still has to carry it.
  const typesB = await b("GET", "/api/holding-types");
  const holdingsOfB = await b("GET", `/api/accounts/${ofB.account}/holdings`);
  record("B's holding type survived A's attempts",
    Boolean(search(typesB.json, (t) => t.id === ofB.holdingType && t.name.includes(MARK_B) && t.custom === true))
      && Boolean(search(holdingsOfB.json, (h) => h.id === ofB.holding && h.type_id === ofB.holdingType)),
    typesB.text.slice(0, 160));

  // Nor may A borrow it: the foreign key alone would accept any existing id,
  // so the trigger trg_holdings_type_in_wallet has to refuse one from another wallet,
  // on a new holding and on an existing one alike.
  const borrowNew = await a("POST", `/api/accounts/${mine.account}/holdings`, {
    name: "A's borrowing holding", pillar_id: 4, amount: 1, type_id: ofB.holdingType, auto_update: false,
  });
  const borrowEdit = await a("POST", `/api/holdings/${mine.holding}`, {
    name: "A's holding", pillar_id: 4, amount: 500, issuer: "A's issuer", type_id: ofB.holdingType, auto_update: false,
  });
  const holdingsOfA = await a("GET", `/api/accounts/${mine.account}/holdings`);
  record("A cannot give a holding B's holding type",
    borrowNew.status >= 400 && borrowNew.status < 500
      && borrowEdit.status >= 400 && borrowEdit.status < 500
      && !search(holdingsOfA.json, (h) => h.name === "A's borrowing holding" || h.type_id === ofB.holdingType)
      && !holdingsOfA.text.includes(MARK_B),
    `create ${borrowNew.status}, edit ${borrowEdit.status}: ${holdingsOfA.text.slice(0, 160)}`);

  // A removes a type of A's own, and the holding using it is left without
  // one; a seeded type cannot be removed by anybody.
  const doomed = search((await a("POST", "/api/holding-types", { name: "A's doomed type" })).json,
    (t) => t.name === "A's doomed type");
  const typedA = await a("POST", `/api/accounts/${mine.account}/holdings`, {
    name: "A's typed holding", pillar_id: 4, amount: 2, type_id: doomed && doomed.id, auto_update: false,
  });
  const removedType = await a("DELETE", `/api/holding-types/${doomed && doomed.id}`);
  const afterRemoval = await a("GET", `/api/accounts/${mine.account}/holdings`);
  const orphan = search(afterRemoval.json, (h) => h.name === "A's typed holding");
  record("A can remove a holding type of A's own, and its holdings lose it",
    typedA.status < 300 && removedType.status === 200
      && !search(removedType.json, (t) => t.name === "A's doomed type")
      && Boolean(orphan) && orphan.type_id === null,
    `add ${typedA.status}, remove ${removedType.status}: ${removedType.text.slice(0, 160)}`);
  // The balance checks below count on A's investment account holding its one
  // 500 holding and nothing else.
  if (orphan) await a("DELETE", `/api/holdings/${orphan.id}`);

  const seeded = search(typesB.json, (t) => t.custom === false && t.code);
  const removeSeeded = await a("DELETE", `/api/holding-types/${seeded && seeded.id}`);
  const typesAfter = await a("GET", "/api/holding-types");
  record("a seeded holding type cannot be removed",
    removeSeeded.status === 404 && Boolean(search(typesAfter.json, (t) => seeded && t.id === seeded.id)),
    `status ${removeSeeded.status}: ${removeSeeded.text.slice(0, 160)}`);

  // --- 3a. the transaction list is paged, and paging reaches nothing of B's --
  // The list comes a page of whole days at a time, with an opaque cursor for
  // the next one. A cursor is only a day (or an amount and an id) used as a
  // bound inside a query RLS has already narrowed: it must not be able to
  // reach another wallet, whatever it contains -- not A's cursor in B's hands,
  // and not one written by hand.
  //
  // Twenty-five transactions of A's on twenty-five different days, so that a
  // page of twenty cannot hold them all.
  for (let i = 0; i < 25; i++) {
    const day = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
    await a("POST", "/api/transactions", {
      from_id: mine.account, to_id: mine.category, amount: 1 + i, type_id: 1,
      description: `A's paged ${i}`, tx_date: `${day}T12:00:00`,
    });
  }

  const firstPage = await a("GET", "/api/transactions?limit=20");
  const pagedIds = [];
  let pageLeak = false;
  let pageFailure = null;
  let pageCount = 0;
  for (let cursor = null, r = firstPage; ; ) {
    if (r.status !== 200 || !r.json) {
      pageFailure = `status ${r.status}: ${r.text.slice(0, 160)}`;
      break;
    }
    if (r.text.includes(MARK_B)) pageLeak = true;
    pageCount += 1;
    for (const group of r.json.data) for (const row of group.data) pagedIds.push(row.id);
    cursor = r.json.nextCursor;
    if (!cursor || pageCount >= 50) break;
    r = await a("GET", `/api/transactions?limit=20&cursor=${encodeURIComponent(cursor)}`);
  }
  record("the transaction list comes in pages", !pageFailure && pageCount >= 2,
    pageFailure || `${pageCount} page(s)`);
  record("paging through A's list never shows B's rows", !pageLeak, "B'S MARKER FOUND IN A PAGE");
  record("every one of A's transactions appears exactly once across the pages",
    new Set(pagedIds).size === pagedIds.length && firstPage.json && pagedIds.length === firstPage.json.count,
    `${pagedIds.length} rows (${new Set(pagedIds).size} distinct), count says ${firstPage.json && firstPage.json.count}`);

  const cursorA = firstPage.json && firstPage.json.nextCursor;
  const withAsCursor = await b("GET", `/api/transactions?limit=20&cursor=${encodeURIComponent(cursorA || "")}`);
  record("A's cursor in B's hands shows only B's wallet",
    withAsCursor.status === 200 && !withAsCursor.text.includes("A's paged"),
    `status ${withAsCursor.status}: ${withAsCursor.text.slice(0, 160)}`);

  const forge = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const cursorProbes = [
    // [what, path, expected status]
    ["a cursor that is not base64 JSON", "/api/transactions?cursor=%25%25not-a-cursor", 400],
    ["a cursor carrying SQL", `/api/transactions?cursor=${forge({ k: "d", v: "2020-01-10'; delete from transactions; --" })}`, 400],
    ["a date cursor for the far future", `/api/transactions?cursor=${forge({ k: "d", v: "2999-01-01" })}`, 200],
    ["a cursor naming B's wallet", `/api/transactions?cursor=${forge({ k: "d", v: "2999-01-01", wallet_id: ofB.wallet, walletId: ofB.wallet })}`, 200],
    ["an amount cursor at the edge of the range", `/api/transactions?sort=amount&cursor=${forge({ k: "a", a: 1e300, id: 2147483647 })}`, 200],
    ["a date cursor on the amount order", `/api/transactions?sort=amount&cursor=${forge({ k: "d", v: "2999-01-01" })}`, 400],
    ["a filter on B's account", `/api/transactions?fromId=${ofB.account}`, 200],
    ["a filter on B's category", `/api/transactions?toId=${ofB.category}`, 200],
    ["a search for B's marker", `/api/transactions?q=${encodeURIComponent(MARK_B)}`, 200],
  ];
  for (const [what, path, status] of cursorProbes) {
    const r = await a("GET", path);
    const bCount = r.json && typeof r.json.count === "number" ? r.json.count : null;
    record(`a forged request cannot reach B: ${what}`,
      r.status === status && !r.text.includes(MARK_B)
        && (status !== 400 || /INVALID_CURSOR|INVALID_REQUEST/.test(r.text))
        && (!/filter on B|search for B/.test(what) || bCount === 0),
      `status ${r.status}: ${r.text.slice(0, 160)}`);
  }

  // --- 3d. balances --------------------------------------------------------
  // Not isolation, but the same gate: what a wallet shows has to be right, and
  // these are the ways it used to go wrong without a word.
  const near = (x, y) => Math.abs(Number(x) - Number(y)) < 1e-6;
  const accountOfA = async () => search((await a("GET", "/api/accounts")).json, (c) => c.id === mine.account);
  const balanceOfA = async () => Number((await accountOfA()).amount);
  const createOfA = async (amount, description, txDate = new Date().toISOString()) => {
    await a("POST", "/api/transactions", {
      from_id: mine.account, to_id: mine.category, amount, type_id: 1, description, tx_date: txDate,
    });
    const found = await a("GET", `/api/transactions?q=${encodeURIComponent(description)}`);
    return search(found.json, (m) => m.description === description);
  };

  // A's account is an investment account holding one 500 holding. Money
  // moving through it does not change what the holding is worth; every
  // transaction used to reset that value, and the Accounts page then showed
  // the cash paid in instead.
  const investment = await accountOfA();
  record("transactions leave an investment account's holdings value alone",
    Boolean(investment) && near(investment.actual_amount, 500),
    `actual_amount=${investment && investment.actual_amount}`);

  // Two deletes of one transaction at the same moment -- a double click, or
  // two members. The second must find nothing to undo.
  const before = await balanceOfA();
  const twice = await createOfA(40, `double delete ${RUN}`);
  const afterCreate = await balanceOfA();
  const deletes = await Promise.all([
    a("DELETE", `/api/transactions/${twice && twice.id}`),
    a("DELETE", `/api/transactions/${twice && twice.id}`),
  ]);
  const afterDeletes = await balanceOfA();
  record("two concurrent deletes of one transaction undo it once",
    Boolean(twice) && near(afterCreate, before - 40) && near(afterDeletes, before)
      && deletes.map((r) => r.status).sort().join(",") === "200,404"
      && /TRANSACTION_NOT_FOUND/.test(deletes.map((r) => r.text).join(" ")),
    `balance ${before} -> ${afterCreate} -> ${afterDeletes}, statuses ${deletes.map((r) => r.status)}`);

  // A delete racing an edit: whichever wins, the balance has to match what is
  // left in the list.
  const raced = await createOfA(30, `delete update ${RUN}`);
  await Promise.all([
    a("DELETE", `/api/transactions/${raced && raced.id}`),
    a("POST", `/api/transactions/${raced && raced.id}`, {
      from_id: mine.account, to_id: mine.category, amount: 70, type_id: 1,
      description: `delete update ${RUN}`, tx_date: new Date().toISOString(),
    }),
  ]);
  const leftOver = search((await a("GET", `/api/transactions?q=${encodeURIComponent(`delete update ${RUN}`)}`)).json,
    (m) => raced && m.id === raced.id);
  const expected = before - (leftOver ? Number(leftOver.amount) : 0);
  const afterRace = await balanceOfA();
  record("a delete racing an edit leaves the balance matching what is left",
    Boolean(raced) && near(afterRace, expected),
    `balance ${afterRace}, expected ${expected} (${leftOver ? `row left with ${leftOver.amount}` : "row gone"})`);

  // Editing an account with a form opened before a transaction landed: saving
  // the name must not put the old balance back.
  const opened = await balanceOfA();
  await createOfA(5, `while editing ${RUN}`);
  const accountBody = { name: "A's account", color: "steelblue", icon: "bank", iconFamily: "FontAwesome", is_investment: true };
  const renamedOnly = await a("POST", `/api/accounts/${mine.account}`, { ...accountBody, amount: opened });
  record("saving an account without touching its balance keeps every transaction's effect",
    renamedOnly.status === 200 && near(await balanceOfA(), opened - 5),
    `status ${renamedOnly.status}, balance ${await balanceOfA()}, expected ${opened - 5}`);

  const staleBalance = await a("POST", `/api/accounts/${mine.account}`, {
    ...accountBody, amount: 1234, previous_amount: opened,
  });
  record("a balance typed over one that has moved meanwhile is refused",
    staleBalance.status === 409 && /BALANCE_CHANGED/.test(staleBalance.text) && near(await balanceOfA(), opened - 5),
    `status ${staleBalance.status}: ${staleBalance.text.slice(0, 160)}`);

  const current = opened - 5;
  const setBalance = await a("POST", `/api/accounts/${mine.account}`, {
    ...accountBody, amount: current + 100, previous_amount: current,
  });
  const afterSet = await balanceOfA();
  await a("POST", `/api/accounts/${mine.account}`, { ...accountBody, amount: current, previous_amount: current + 100 });
  record("a balance typed over the current one is applied",
    setBalance.status === 200 && near(afterSet, current + 100) && near(await balanceOfA(), current),
    `status ${setBalance.status}, balance ${afterSet}, expected ${current + 100}`);

  // tx_date carries a time of day. A period used to end at midnight *at the
  // start* of its last day, so a transaction recorded that evening was missing
  // from the list, the totals and every summary. February 2024 holds nothing
  // else of A's.
  const lastDay = `last day ${RUN}`;
  await createOfA(11, lastDay, "2024-02-29T18:30:00");
  const febList = await a("GET", "/api/transactions?from=20240201&to=20240229");
  const febMonth = await a("GET", "/api/summary/month?year=2024&month=2");
  const febCategories = await a("GET", "/api/categories/expenses?from=20240201&to=20240229");
  const year2024 = await a("GET", "/api/summary?from=20240101&to=20241231");
  const febChart = year2024.json && (year2024.json.expenses || []).find((m) => m.month === 2);
  record("a transaction late on the last day of a period is in the period's list",
    Boolean(search(febList.json, (m) => m.description === lastDay)) && febList.json.totOut === 11,
    `status ${febList.status}: ${febList.text.slice(0, 160)}`);
  record("and in the month's summary, the categories and the year chart",
    febMonth.json && febMonth.json.sums && near(febMonth.json.sums.expenses.total, 11)
      && febCategories.json && near(febCategories.json.totOutMonth, 11)
      && Boolean(febChart) && near(febChart.total, 11),
    `month ${febMonth.json && febMonth.json.sums && febMonth.json.sums.expenses.total}, ` +
      `categories ${febCategories.json && febCategories.json.totOutMonth}, chart ${febChart && febChart.total}`);

  // --- 3b. an import reaches no wallet but the one in context ---------------
  // Names are all an import goes by, so the attack is a file that names B's
  // account and category exactly. It runs in a scratch wallet of A's: the rows
  // it creates carry B's marker, and the wallet the checks below read has to
  // stay free of it.
  //
  // The scratch wallet first receives A's whole wallet, exported as an archive
  // and imported back. The round trip has to land on the same balances, which
  // is what the opening balances in accounts.csv are there for.
  const accountsBeforeCopy = await a("GET", "/api/accounts");
  const balanceA = (search(accountsBeforeCopy.json, (c) => c.name === "A's account") || {}).amount;
  const archiveA = await a("GET", "/api/data/export/wallet.zip");
  record("A can export the whole wallet",
    archiveA.status === 200 && archiveA.text.includes("A's transaction"),
    `status ${archiveA.status}: ${archiveA.text.slice(0, 160)}`);

  const scratchName = `A's scratch wallet ${RUN}`;
  const scratch = await a("POST", "/api/auth/wallets", { name: scratchName });
  record("A can open a scratch wallet for the import checks", scratch.status === 201,
    `status ${scratch.status}: ${scratch.text.slice(0, 160)}`);

  const archiveBody = { file: archiveA.bytes.toString("base64") };
  const archivePreview = await a("POST", "/api/data/import/preview", archiveBody);
  const archiveLines = archivePreview.json && Array.isArray(archivePreview.json.rows)
    ? archivePreview.json.rows.filter((r) => r.selected).map((r) => r.line)
    : [];
  const archiveCommit = await a("POST", "/api/data/import/commit", {
    ...archiveBody,
    selection: { lines: archiveLines },
  });
  const copied = await a("GET", "/api/accounts");
  const copiedA = search(copied.json, (c) => c.name === "A's account");
  record("a wallet archive imports back with the same balances",
    archiveCommit.status === 200 && Boolean(copiedA)
      && Math.abs(Number(copiedA.amount) - Number(balanceA)) < 1e-6,
    `status ${archiveCommit.status}: ${archiveCommit.text.slice(0, 160)} ` +
      `(balance ${copiedA && copiedA.amount}, expected ${balanceA})`);

  const stateOfB = async () =>
    (await b("GET", "/api/accounts")).text + (await b("GET", "/api/transactions")).text;
  const bBeforeImport = await stateOfB();
  const intruding = importRequest(
    "date,type,amount,from,to,note\r\n" +
      `2026-01-15,EXPENSE,777,Account ${MARK_B},Category ${MARK_B},intruding expense\r\n` +
      `2026-01-16,TRANSFER,1,Account ${MARK_B},A's account,intruding transfer\r\n`,
  );
  const intrudingPreview = await a("POST", "/api/data/import/preview", intruding);
  const toCreate = (intrudingPreview.json && intrudingPreview.json.create) || [];
  record("an import does not find another wallet's accounts by name",
    intrudingPreview.status === 200
      && toCreate.some((c) => c.kind === "ACCOUNT" && c.name === `Account ${MARK_B}`)
      && toCreate.some((c) => c.kind === "EXPENSE" && c.name === `Category ${MARK_B}`),
    `status ${intrudingPreview.status}: ${JSON.stringify(toCreate).slice(0, 200)}`);

  const intrudingCommit = await a("POST", "/api/data/import/commit", {
    ...intruding,
    selection: { lines: [2, 3] },
  });
  record("the import creates what it names in the wallet in context",
    intrudingCommit.status === 200 && Boolean(intrudingCommit.json)
      && intrudingCommit.json.transactions === 2
      && intrudingCommit.json.accounts === 1 && intrudingCommit.json.categories === 1,
    `status ${intrudingCommit.status}: ${intrudingCommit.text.slice(0, 200)}`);

  record("B's wallet is untouched by an import that names its accounts",
    (await stateOfB()) === bBeforeImport, "B's accounts or transactions changed");

  // Back to the first wallet, and the scratch one goes -- the rows carrying
  // the marker with it.
  const home = await a("POST", "/api/auth/wallet", { walletId: walletA.id });
  const dropped = await a("DELETE", `/api/auth/wallets/${scratch.json && scratch.json.id}`, {
    confirm: scratchName,
  });
  record("the scratch wallet is deleted and A is back on the first one",
    home.status === 200 && dropped.status === 200,
    `select ${home.status}, delete ${dropped.status}: ${dropped.text.slice(0, 160)}`);

  // --- 3b'. restoring an archive into a brand-new wallet --------------------
  // A new wallet comes with a starter account. An archive whose account has
  // the same name used to be matched to it and its opening balance dropped,
  // so the restored balance came out short by exactly the opening. A reused
  // account that was never used (balance 0, no transactions, no holdings)
  // now takes the file's opening; the preview says so (openingApplied), and
  // once it has transactions it is an ordinary reused account again.
  const restoreName = `A's restore wallet ${RUN}`;
  const restore = await a("POST", "/api/auth/wallets", { name: restoreName });
  const starterList = (await a("GET", "/api/accounts")).json;
  const starter = starterList && Array.isArray(starterList.data) && starterList.data.length === 1
    ? starterList.data[0]
    : null;
  record("a new wallet starts with one starter account at zero",
    restore.status === 201 && Boolean(starter) && Number(starter.amount) === 0,
    `status ${restore.status}: ${JSON.stringify(starterList).slice(0, 200)}`);
  if (starter) {
    const fflate = require("fflate");
    const csvField = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const restoreZip = Buffer.from(fflate.zipSync({
      "manifest.json": fflate.strToU8(JSON.stringify({ format: "bussola-wallet", formatVersion: 1 })),
      "accounts.csv": fflate.strToU8(`name,balance,opening_balance\r\n${csvField(starter.name)},150,100\r\n`),
      "categories.csv": fflate.strToU8(`name,kind\r\nRestored income,INCOME\r\n`),
      "transactions.csv": fflate.strToU8(
        `date,type,amount,from,to,note\r\n2026-01-10,INCOME,50,${csvField(starter.name)},Restored income,restored\r\n`,
      ),
    }));
    const restoreBody = { file: restoreZip.toString("base64") };
    const restorePreview = await a("POST", "/api/data/import/preview", restoreBody);
    const applied = (restorePreview.json && restorePreview.json.openingApplied) || [];
    record("the preview says the starter account takes the archive's opening balance",
      restorePreview.status === 200 && applied.length === 1
        && applied[0].name === starter.name && Number(applied[0].opening) === 100,
      `status ${restorePreview.status}: ${restorePreview.text.slice(0, 200)}`);
    const restoreCommit = await a("POST", "/api/data/import/commit", { ...restoreBody, selection: { lines: [2] } });
    const restored = search((await a("GET", "/api/accounts")).json, (c) => c.id === starter.id);
    record("restored into a fresh wallet, the account ends on the archive's balance (opening + transactions)",
      restoreCommit.status === 200 && Boolean(restored) && Math.abs(Number(restored.amount) - 150) < 1e-6
        && restoreCommit.json && restoreCommit.json.openingsApplied === 1,
      `status ${restoreCommit.status}: ${restoreCommit.text.slice(0, 160)} (balance ${restored && restored.amount})`);
    const again = await a("POST", "/api/data/import/preview", restoreBody);
    record("an account that now has transactions keeps its balance: no opening is applied again",
      again.status === 200 && Array.isArray(again.json && again.json.openingApplied) && again.json.openingApplied.length === 0,
      `status ${again.status}: ${again.text.slice(0, 200)}`);
  }
  const homeAgain = await a("POST", "/api/auth/wallet", { walletId: walletA.id });
  const restoreDropped = await a("DELETE", `/api/auth/wallets/${restore.json && restore.json.id}`, {
    confirm: restoreName,
  });
  record("the restore wallet is deleted and A is back on the first one",
    homeAgain.status === 200 && restoreDropped.status === 200,
    `select ${homeAgain.status}, delete ${restoreDropped.status}: ${restoreDropped.text.slice(0, 160)}`);

  // --- 3e. a name is unique in its wallet, and only there -------------------
  // Two accounts with one name would fold into one on an export and import
  // (hence a unique index). The index includes the wallet, so a name B uses is free
  // for A -- a global one would have answered "taken" and revealed B's name.
  const newAccount = (name) => ({ name, color: "gray", icon: "bank", iconFamily: "FontAwesome", amount: 0 });
  const newCategory = (name, isExpense) => ({ name, color: "gray", icon: "tag", iconFamily: "FontAwesome", isExpense });
  const refusedAsTaken = (r) => r.status === 409 && Boolean(r.json) && r.json.code === "NAME_TAKEN";
  const said = (r) => `status ${r.status}: ${r.text.slice(0, 160)}`;

  const twin = await a("POST", "/api/accounts", newAccount("A's account"));
  record("a second account with a name already in the wallet is refused", refusedAsTaken(twin), said(twin));
  const sloppyTwin = await a("POST", "/api/accounts", newAccount("  a's ACCOUNT "));
  record("and so is the same name with other capitals and spaces", refusedAsTaken(sloppyTwin), said(sloppyTwin));

  const otherName = `A's other account ${RUN}`;
  await a("POST", "/api/accounts", newAccount(otherName));
  const otherA = search((await a("GET", "/api/accounts")).json, (c) => c.name === otherName);
  const renamedOnto = await a("POST", `/api/accounts/${otherA && otherA.id}`, newAccount("A's account"));
  record("renaming an account onto a name already taken is refused", refusedAsTaken(renamedOnto), said(renamedOnto));

  const plainName = `Plain name ${RUN}`;
  const plainB = await b("POST", "/api/accounts", newAccount(plainName));
  const plainA = await a("POST", "/api/accounts", newAccount(plainName));
  record("a name used in another wallet is free in this one",
    plainB.status === 200 && plainA.status === 200, `B ${said(plainB)}; A ${said(plainA)}`);

  const bothWays = `Both ways ${RUN}`;
  const asExpense = await a("POST", "/api/categories", newCategory(bothWays, true));
  const asIncome = await a("POST", "/api/categories", newCategory(bothWays, false));
  record("an expense and an income category may share a name",
    asExpense.status === 200 && asIncome.status === 200, `expense ${said(asExpense)}; income ${said(asIncome)}`);
  const expenseTwin = await a("POST", "/api/categories", newCategory(bothWays.toUpperCase(), true));
  record("two expense categories may not", refusedAsTaken(expenseTwin), said(expenseTwin));

  // What this section added goes again; the categories have no transactions
  // and the accounts no balance, so nothing below would notice them anyway.
  const leftovers = (await a("GET", "/api/accounts")).json;
  for (const name of [otherName, plainName]) {
    const row = search(leftovers, (c) => c.name === name);
    if (row) await a("DELETE", `/api/accounts/${row.id}`);
  }
  const plainRowB = search((await b("GET", "/api/accounts")).json, (c) => c.name === plainName);
  if (plainRowB) await b("DELETE", `/api/accounts/${plainRowB.id}`);

  // --- 3e'. accounts and categories keep their kind -------------------------
  // One table holds both, so every endpoint names the kind it works on: an
  // account id sent to a categories endpoint (or the other way round) is a 404,
  // never a bank account turned into a category. And a category with
  // transactions cannot switch between expense and income, which would leave
  // them counted nowhere; an unused one still can.
  const notFoundAs = (r) => r.status === 404 && Boolean(r.json) && r.json.code === "ACCOUNT_NOT_FOUND";
  const catRow = search((await a("GET", "/api/categories/expenses")).json, (c) => c.id === mine.category);
  const catBody = (isExpense) => ({
    name: catRow && catRow.name,
    color: catRow && catRow.color,
    icon: catRow && catRow.icon,
    iconFamily: catRow && catRow.icon_family,
    description: catRow && catRow.description,
    isExpense,
  });
  const flipped = await a("POST", `/api/categories/${mine.category}`, catBody(false));
  const stillExpense = search((await a("GET", "/api/categories/expenses")).json, (c) => c.id === mine.category);
  record("a category with transactions cannot become an income category (409 CATEGORY_IN_USE)",
    flipped.status === 409 && flipped.json && flipped.json.code === "CATEGORY_IN_USE" && Boolean(stillExpense),
    said(flipped));
  const resaved = await a("POST", `/api/categories/${mine.category}`, catBody(true));
  record("but it can still be saved as what it is", resaved.status === 200, said(resaved));

  const switchName = `Switch ${RUN}`;
  await a("POST", "/api/categories", newCategory(switchName, true));
  const switchRow = search((await a("GET", "/api/categories/expenses")).json, (c) => c.name === switchName);
  const switched = await a("POST", `/api/categories/${switchRow && switchRow.id}`, newCategory(switchName, false));
  const nowIncome = search((await a("GET", "/api/categories/income")).json, (c) => c.name === switchName);
  record("an unused category may change kind", switched.status === 200 && Boolean(nowIncome), said(switched));
  if (nowIncome) await a("DELETE", `/api/categories/${nowIncome.id}`);

  for (const [method, path, body] of [
    ["POST", `/api/categories/${mine.account}`, newCategory(`Hijacked ${RUN}`, true)],
    ["DELETE", `/api/categories/${mine.account}`],
    ["POST", `/api/categories/${mine.account}/archive`, { archived: true }],
    ["DELETE", `/api/accounts/${mine.category}`],
    ["POST", `/api/accounts/${mine.category}`, newAccount(`Hijacked ${RUN}`)],
    ["POST", `/api/accounts/${mine.category}/archive`, { archived: true }],
    ["POST", `/api/accounts/${mine.category}/holdings`, { name: "on a category", pillar_id: 1, amount: 1 }],
  ]) {
    const r = await a(method, path, body);
    record(`${method} ${path.replace(/\d+/, ":id")} on the other kind is 404 ACCOUNT_NOT_FOUND`, notFoundAs(r), said(r));
  }
  const accountsAfterKind = (await a("GET", "/api/accounts")).json;
  const categoriesAfterKind = (await a("GET", "/api/categories/expenses")).json;
  record("and the account and the category are as they were",
    Boolean(search(accountsAfterKind, (c) => c.id === mine.account && c.name === "A's account"))
      && Boolean(search(categoriesAfterKind, (c) => c.id === mine.category && c.name === (catRow && catRow.name))),
    `${JSON.stringify(accountsAfterKind).slice(0, 120)} ${JSON.stringify(categoriesAfterKind).slice(0, 120)}`);

  // --- 3f. the inbox and personal tokens ------------------------------------
  // A phone posts notifications with a personal token; they wait as drafts
  // until somebody confirms them. A token belongs to one wallet, opens the two
  // inbox endpoints and nothing else, and every id it names is looked up in
  // its own wallet only.
  const tokenA = tokenSecrets.a;
  const posted = await tokenCall(tokenA, "POST", "/api/inbox", {
    source: "iso",
    text: "Pagamento di 12,40 € presso Inbox shop A il 01/02/2026",
    draft: { amount: 12.4, description: "Inbox shop A" },
  });
  record("a token posts a notification to its wallet's inbox",
    posted.status === 201 && posted.json && Number.isInteger(posted.json.id),
    `status ${posted.status}: ${posted.text.slice(0, 160)}`);

  // A notification that is only text needs a reading model: with one it is
  // queued for it; without one (the test stack has no BUSSOLA_AI_URL) it is
  // refused and nothing is kept. A draft with its text, posted above, is
  // taken as it is either way.
  const aiOn = Boolean((await a("GET", "/api/auth/me")).json?.ai);
  const postedItem = posted.json && search((await a("GET", "/api/inbox")).json, (i) => i.id === posted.json.id);
  record("a draft posted with its text is stored as it came (extraction off)",
    Boolean(postedItem) && postedItem.raw_text === "Pagamento di 12,40 € presso Inbox shop A il 01/02/2026"
      && postedItem.extraction === "off" && postedItem.amount === 12.4,
    JSON.stringify(postedItem).slice(0, 240));
  const countBeforeText = ((await a("GET", "/api/inbox")).json || []).length;
  const textOnly = await tokenCall(tokenA, "POST", "/api/inbox", { source: "iso", text: "Pagamento di 9,99 € presso Text only shop" });
  const afterText = (await a("GET", "/api/inbox")).json || [];
  record(aiOn ? "with a model, a notification that is only text is queued for it"
              : "without a model, a notification that is only text is refused (409 AI_DISABLED) and nothing is kept",
    aiOn ? textOnly.status === 201
         : textOnly.status === 409 && /AI_DISABLED/.test(textOnly.text) && afterText.length === countBeforeText
             && !JSON.stringify(afterText).includes("Text only shop"),
    `status ${textOnly.status}: ${textOnly.text.slice(0, 160)}`);

  const aimed = await tokenCall(tokenA, "POST", "/api/inbox", {
    source: "iso",
    draft: { amount: 5, description: "aimed at B", type: "EXPENSE", from_id: ofB.account, to_id: ofB.category },
  });
  record("a draft naming another wallet's account and category is accepted as a draft",
    aimed.status === 201 && aimed.json && Number.isInteger(aimed.json.id),
    `status ${aimed.status}: ${aimed.text.slice(0, 160)}`);

  const inboxListA = await a("GET", "/api/inbox");
  const aimedItem = aimed.json && search(inboxListA.json, (i) => i.id === aimed.json.id);
  record("but B's ids are dropped, never stored",
    Boolean(aimedItem) && aimedItem.from_id !== ofB.account && aimedItem.to_id !== ofB.category
      && aimedItem.to_id !== ofB.account && !inboxListA.text.includes(MARK_B),
    aimedItem ? JSON.stringify(aimedItem).slice(0, 200) : `not listed: ${inboxListA.text.slice(0, 160)}`);
  record("A's inbox does not list B's item",
    inboxListA.status === 200 && !search(inboxListA.json, (i) => i.id === ofB.inbox),
    inboxListA.text.slice(0, 160));

  const context = await tokenCall(tokenA, "GET", "/api/inbox/context");
  record("GET /api/inbox/context answers with A's wallet and nothing of B's",
    context.status === 200 && context.text.includes("A's account") && !context.text.includes(MARK_B),
    `status ${context.status}: ${context.text.slice(0, 160)}`);

  // Everywhere else a token is no credential at all.
  for (const [method, path, body] of [
    ["GET", "/api/transactions"],
    ["GET", "/api/accounts"],
    ["GET", "/api/auth/me"],
    ["GET", "/api/inbox"],
    ["GET", "/api/auth/tokens"],
    ["GET", "/api/data/export/transactions.csv"],
    ["POST", "/api/transactions", { from_id: mine.account, to_id: mine.category, amount: 1, type_id: 1, description: "by token", tx_date: new Date().toISOString() }],
    ["POST", `/api/inbox/${mine.inbox}/dismiss`, {}],
  ]) {
    const r = await tokenCall(tokenA, method, path, body);
    record(`a token does not authenticate ${method} ${path}`,
      r.status === 401 && !r.text.includes("A's account") && !r.text.includes("A's transaction") && !r.text.includes(MARK_B),
      `status ${r.status}: ${r.text.slice(0, 160)}`);
  }

  // B's side: A's session can resolve nothing of B's, and B sees nothing of A's.
  for (const action of ["accept", "dismiss"]) {
    const r = await a("POST", `/api/inbox/${ofB.inbox}/${action}`,
      action === "accept"
        ? { from_id: mine.account, to_id: mine.category, amount: 1, type_id: 1, description: "TAKEN", tx_date: new Date().toISOString() }
        : {});
    record(`A cannot ${action} B's inbox item (404)`,
      r.status === 404 && /INBOX_NOT_FOUND/.test(r.text), `status ${r.status}: ${r.text.slice(0, 160)}`);
  }
  const inboxListB = await b("GET", "/api/inbox");
  record("B's item is still pending, and B's inbox shows nothing of A's",
    inboxListB.status === 200 && Boolean(search(inboxListB.json, (i) => i.id === ofB.inbox))
      && !search(inboxListB.json, (i) => i.id === mine.inbox || (posted.json && i.id === posted.json.id))
      && !inboxListB.text.includes("Pending shop of A"),
    inboxListB.text.slice(0, 200));

  // A cannot revoke B's token (the sweep tried), and it still works.
  const stillB = await tokenCall(tokenSecrets.b, "GET", "/api/inbox/context");
  record("B's token survived A's attempt to revoke it",
    stillB.status === 200 && !stillB.text.includes("A's account"),
    `status ${stillB.status}: ${stillB.text.slice(0, 160)}`);

  // The list names A's tokens and never a secret.
  const tokenList = await a("GET", "/api/auth/tokens");
  record("the token list shows A's tokens, never a secret nor a hash",
    tokenList.status === 200 && Array.isArray(tokenList.json)
      && tokenList.json.some((t) => t.label === "A's phone")
      && !tokenList.text.includes(tokenA) && !/bpt_/.test(tokenList.text) && !/token_hash|"token"/.test(tokenList.text)
      && !tokenList.text.includes(MARK_B),
    tokenList.text.slice(0, 200));

  // Accepting: one transaction, the balance moved once, the text gone. Two
  // accepts at the same moment, as a double tap would send them: one wins.
  const inboxBalanceA = async () => {
    const r = await a("GET", "/api/accounts");
    const acc = search(r.json, (x) => x.id === mine.account);
    return acc ? Number(acc.amount) : NaN;
  };
  const countAccepted = async () => {
    const r = await a("GET", "/api/transactions?q=accepted%20from%20the%20inbox");
    return r.json ? r.json.count : NaN;
  };
  const balanceBefore = await inboxBalanceA();
  const countBefore = await countAccepted();
  const confirmed = {
    from_id: mine.account, to_id: mine.category, amount: 12.4, type_id: 1,
    description: "accepted from the inbox", tx_date: "20260201",
  };
  const acceptPath = `/api/inbox/${posted.json && posted.json.id}/accept`;
  const racing = await Promise.all([a("POST", acceptPath, confirmed), a("POST", acceptPath, confirmed)]);
  const won = racing.find((r) => r.status === 200);
  const lost = racing.find((r) => r !== won);
  record("two simultaneous accepts: one creates the transaction, the other is 409 INBOX_RESOLVED",
    Boolean(won) && Boolean(lost) && lost.status === 409 && /INBOX_RESOLVED/.test(lost.text)
      && Number.isInteger(won.json && won.json.transaction_id),
    racing.map((r) => `${r.status} ${r.text.slice(0, 100)}`).join(" | "));
  record("the accepted item keeps no text", Boolean(won) && won.json && won.json.has_text === false,
    won ? won.text.slice(0, 160) : "no accept succeeded");
  const balanceAfter = await inboxBalanceA();
  const countAfter = await countAccepted();
  record("accepting moved the balance exactly once",
    Math.abs(balanceBefore - 12.4 - balanceAfter) < 0.005, `before ${balanceBefore}, after ${balanceAfter}`);
  record("accepting created exactly one transaction", countAfter === countBefore + 1,
    `before ${countBefore}, after ${countAfter}`);
  const acceptAgain = await a("POST", acceptPath, confirmed);
  record("accepting it again is 409 INBOX_RESOLVED",
    acceptAgain.status === 409 && /INBOX_RESOLVED/.test(acceptAgain.text), `status ${acceptAgain.status}`);
  const balanceLater = await inboxBalanceA();
  const countLater = await countAccepted();
  record("and nothing more moved", Math.abs(balanceLater - balanceAfter) < 0.005 && countLater === countAfter,
    `balance ${balanceLater}, count ${countLater}`);

  // Dismissing: the text goes, the item goes, a second dismiss is 409.
  const toDismiss = await tokenCall(tokenA, "POST", "/api/inbox", { source: "iso", text: "Hai speso 3,00 € da Dismiss me", draft: { amount: 3, description: "Dismiss me" } });
  const dismissed = await a("POST", `/api/inbox/${toDismiss.json && toDismiss.json.id}/dismiss`, {});
  record("dismissing an item clears its text",
    dismissed.status === 200 && dismissed.json && dismissed.json.has_text === false,
    `status ${dismissed.status}: ${dismissed.text.slice(0, 160)}`);
  const dismissAgain = await a("POST", `/api/inbox/${toDismiss.json && toDismiss.json.id}/dismiss`, {});
  record("dismissing it again is 409 INBOX_RESOLVED",
    dismissAgain.status === 409 && /INBOX_RESOLVED/.test(dismissAgain.text), `status ${dismissAgain.status}`);
  const pendingNow = await a("GET", "/api/inbox");
  record("resolved items leave the pending list; the untouched one stays",
    !search(pendingNow.json, (i) => (posted.json && i.id === posted.json.id) || (toDismiss.json && i.id === toDismiss.json.id))
      && Boolean(search(pendingNow.json, (i) => i.id === mine.inbox)),
    pendingNow.text.slice(0, 200));

  // --- 4. a shared wallet: readable, and not writable -----------------------
  // Everything above is about people who must not meet. This is the other
  // half: two people on the same wallet, one of whom may only look.
  record("sign-up leaves a wallet selected", Boolean(walletA.id && walletA.role === "rw"),
    JSON.stringify(walletA));

  // The wallet sign-up created is the one that cannot be deleted, and the list
  // has to say so: the interface leaves the button out on the strength of this
  // field.
  record("the wallet sign-up created is marked as the first one",
    walletA.first_wallet === true, JSON.stringify(walletA));

  const reader = createClient();
  const readerName = `iso-r-${suffix}`;
  const readerProfile = await registerUser(reader, readerName, "test-password-r");

  const invited = await a("POST", `/api/auth/wallets/${walletA.id}/members`, {
    username: readerName,
    role: "r",
  });
  record("the wallet's creator can share it read-only", invited.status === 201,
    `status ${invited.status}: ${invited.text.slice(0, 160)}`);

  const selected = await reader("POST", "/api/auth/wallet", { walletId: walletA.id });
  record("the invited account can open the wallet",
    selected.status === 200 && selected.json && selected.json.role === "r",
    `status ${selected.status}: ${selected.text.slice(0, 160)}`);

  // Reading has to genuinely work: a share that shows nothing would pass every
  // "cannot write" check below for the wrong reason.
  const seen = await reader("GET", "/api/accounts");
  record("a read-only member sees the wallet's data",
    seen.status === 200 && seen.text.includes("A's account"),
    `status ${seen.status}: ${seen.text.slice(0, 160)}`);

  // Paging is reading: the second page has to come back as the first did.
  const readerFirst = await reader("GET", "/api/transactions?limit=20");
  const readerCursor = readerFirst.json && readerFirst.json.nextCursor;
  const readerSecond = readerCursor
    ? await reader("GET", `/api/transactions?limit=20&cursor=${encodeURIComponent(readerCursor)}`)
    : null;
  record("a read-only member can page through the transactions",
    readerFirst.status === 200 && Boolean(readerSecond) && readerSecond.status === 200
      && readerSecond.text.includes("A's paged") && !readerSecond.text.includes(MARK_B),
    `first ${readerFirst.status}, second ${readerSecond ? readerSecond.status : "none"}: ` +
      `${(readerSecond || readerFirst).text.slice(0, 160)}`);

  // Exporting is reading: a member who may look at every figure may take them
  // away in a file, and it has to be the wallet they were shown.
  const readerExport = await reader("GET", "/api/data/export/transactions.csv");
  record("a read-only member can export the wallet",
    readerExport.status === 200 && readerExport.text.includes("A's transaction"),
    `status ${readerExport.status}: ${readerExport.text.slice(0, 160)}`);

  const readerInbox = await reader("GET", "/api/inbox");
  record("a read-only member can read the inbox",
    readerInbox.status === 200 && Boolean(search(readerInbox.json, (i) => i.id === mine.inbox)),
    `status ${readerInbox.status}: ${readerInbox.text.slice(0, 160)}`);

  for (const [method, path, body, code] of writeEndpoints(mine, walletA)) {
    const r = await reader(method, path, body);
    record(`read-only: ${method} ${path} is refused`,
      r.status === 403 && new RegExp(code || "READ_ONLY").test(r.text),
      `status ${r.status}: ${r.text.slice(0, 160)}`);
  }

  // The wallet is still there, still called what it was called and still
  // counted in the currency it had: the refusals above have to be refusals,
  // not silent no-ops that happen to report 403.
  const stillThere = await a("GET", "/api/auth/wallets");
  record("the read-only member neither renamed nor deleted the wallet",
    Boolean(search(stillThere.json, (w) => w.id === walletA.id && w.name === walletA.name)),
    stillThere.text.slice(0, 160));

  const walletNow = search(stillThere.json, (w) => w.id === walletA.id);
  record("the read-only member did not change the wallet's currency",
    Boolean(walletNow) && walletNow.currency === walletA.currency,
    walletNow ? `currency=${walletNow.currency}` : "wallet gone");

  // And the manager can, which is what makes the refusal above a rule about
  // who is asking rather than an endpoint that never works.
  const curOk = await a("POST", `/api/auth/wallets/${walletA.id}/currency`, { currency: "USD" });
  record("the wallet's creator can change its currency",
    curOk.status === 200 && curOk.json && curOk.json.currency === "USD",
    `status ${curOk.status}: ${curOk.text.slice(0, 160)}`);

  // The unit every member reads the numbers in, so a member has to be told
  // about it without asking a second endpoint.
  const meAfter = await a("GET", "/api/auth/me");
  record("the session reports the wallet's new currency",
    meAfter.status === 200 && meAfter.json && meAfter.json.wallet
      && meAfter.json.wallet.currency === "USD",
    meAfter.text.slice(0, 200));

  const curBad = await a("POST", `/api/auth/wallets/${walletA.id}/currency`, { currency: "XyZ" });
  record("a currency this instance does not offer is refused",
    curBad.status === 400 && /INVALID_CURRENCY/.test(curBad.text),
    `status ${curBad.status}: ${curBad.text.slice(0, 160)}`);

  // Put it back, so nothing below reads amounts in a unit this section chose.
  await a("POST", `/api/auth/wallets/${walletA.id}/currency`, { currency: walletA.currency || "EUR" });

  const inboxAfterReader = await a("GET", "/api/inbox");
  record("the read-only member resolved nothing in the inbox",
    Boolean(search(inboxAfterReader.json, (i) => i.id === mine.inbox)), inboxAfterReader.text.slice(0, 160));

  // Refused with nothing changed, which is the part that matters.
  const afterAttempts = await a("GET", "/api/accounts");
  const accountA = search(afterAttempts.json, (c) => c.id === mine.account);
  record("nothing the read-only member tried had any effect",
    Boolean(accountA) && accountA.name === "A's account" && accountA.archived === false,
    accountA ? `name="${accountA.name}" archived=${accountA.archived}` : "account gone");

  // --- 5. a wallet you were not invited to cannot be selected ---------------
  const stolen = await reader("POST", "/api/auth/wallet", { walletId: walletB.id });
  record("selecting somebody else's wallet is refused",
    stolen.status === 403 && /NOT_A_MEMBER/.test(stolen.text),
    `status ${stolen.status}: ${stolen.text.slice(0, 160)}`);

  const afterStealing = await reader("GET", "/api/accounts");
  record("and it leaves the session on the wallet it had",
    !afterStealing.text.includes(MARK_B),
    `status ${afterStealing.status}: ${afterStealing.text.slice(0, 160)}`);

  // A member is not a manager: only the creator and the administrator are.
  const sneaky = await reader("POST", `/api/auth/wallets/${walletA.id}/members`, {
    username: `iso-b-${suffix}`,
    role: "rw",
  });
  record("a plain member cannot invite anyone",
    sneaky.status === 403 && /NOT_WALLET_MANAGER/.test(sneaky.text),
    `status ${sneaky.status}: ${sneaky.text.slice(0, 160)}`);

  // --- 6. promoted to rw, the same account can write ------------------------
  // The mirror of the checks above: if writes were refused for some reason
  // other than the role, this is where it shows.
  const promoted = await a("POST", `/api/auth/wallets/${walletA.id}/members/${readerProfile.id}`, {
    role: "rw",
  });
  record("the creator can promote a member to read-write", promoted.status === 200,
    `status ${promoted.status}: ${promoted.text.slice(0, 160)}`);

  const written = await reader("POST", "/api/accounts", {
    name: "written by the invited account",
    color: "gray",
    icon: "bank",
    iconFamily: "FontAwesome",
    amount: 7,
  });
  record("a read-write member can write", written.status === 200,
    `status ${written.status}: ${written.text.slice(0, 160)}`);

  const sharedView = await a("GET", "/api/accounts");
  record("and the owner sees what they wrote",
    sharedView.text.includes("written by the invited account"),
    sharedView.text.slice(0, 160));

  // A read-write member can make a token for the shared wallet, and the token
  // is only as good as the membership behind it, checked on every use.
  const readerToken = await reader("POST", "/api/auth/tokens", { label: "reader's phone", password: "test-password-r" });
  const readerSecret = readerToken.json && readerToken.json.token;
  record("a read-write member can make a token for the wallet",
    readerToken.status === 201 && typeof readerSecret === "string" && readerToken.json.wallet_id === walletA.id,
    `status ${readerToken.status}: ${readerToken.text.slice(0, 160)}`);
  const viaReader = await tokenCall(readerSecret, "POST", "/api/inbox", { source: "iso", text: "12,00 € presso Reader shop", draft: { amount: 12, description: "Reader shop" } });
  record("and the token posts to it", viaReader.status === 201, `status ${viaReader.status}: ${viaReader.text.slice(0, 160)}`);

  const demoted = await a("POST", `/api/auth/wallets/${walletA.id}/members/${readerProfile.id}`, { role: "r" });
  const afterDemotion = await tokenCall(readerSecret, "POST", "/api/inbox", { source: "iso", text: "13,00 € presso Reader shop" });
  record("made read-only, the member's token stops working at once (403 TOKEN_FORBIDDEN)",
    demoted.status === 200 && afterDemotion.status === 403 && /TOKEN_FORBIDDEN/.test(afterDemotion.text),
    `demotion ${demoted.status}; token ${afterDemotion.status}: ${afterDemotion.text.slice(0, 160)}`);
  const contextAfterDemotion = await tokenCall(readerSecret, "GET", "/api/inbox/context");
  record("and cannot read the context either",
    contextAfterDemotion.status === 403 && !contextAfterDemotion.text.includes("A's account"),
    `status ${contextAfterDemotion.status}: ${contextAfterDemotion.text.slice(0, 160)}`);

  const repromoted = await a("POST", `/api/auth/wallets/${walletA.id}/members/${readerProfile.id}`, { role: "rw" });
  const afterRepromotion = await tokenCall(readerSecret, "POST", "/api/inbox", { source: "iso", text: "14,00 € presso Reader shop", draft: { amount: 14, description: "Reader shop" } });
  record("read-write again, the same token works again: it was the role, not the token",
    repromoted.status === 200 && afterRepromotion.status === 201,
    `promotion ${repromoted.status}; token ${afterRepromotion.status}: ${afterRepromotion.text.slice(0, 160)}`);

  // --- 7. revoking a membership takes effect immediately --------------------
  // Without a fresh sign-in: the role is resolved on every request, exactly
  // the way users.active is.
  const revoked = await a("DELETE", `/api/auth/wallets/${walletA.id}/members/${readerProfile.id}`);
  record("the creator can revoke a membership", revoked.status === 200,
    `status ${revoked.status}: ${revoked.text.slice(0, 160)}`);

  const afterRevoke = await reader("GET", "/api/accounts");
  record("the revoked account loses the wallet at once, without signing in again",
    afterRevoke.status === 409 && /NO_WALLET_SELECTED/.test(afterRevoke.text),
    `status ${afterRevoke.status}: ${afterRevoke.text.slice(0, 160)}`);

  const tokenAfterRevoke = await tokenCall(readerSecret, "POST", "/api/inbox", { source: "iso", text: "15,00 € presso Reader shop" });
  record("and its token stops working at once (403 TOKEN_FORBIDDEN)",
    tokenAfterRevoke.status === 403 && /TOKEN_FORBIDDEN/.test(tokenAfterRevoke.text),
    `status ${tokenAfterRevoke.status}: ${tokenAfterRevoke.text.slice(0, 160)}`);

  // --- 8. renaming and deleting a wallet -----------------------------------
  // Managing a wallet is not a role but a fact about who created it, so a
  // stranger is turned away exactly like the read-only member above -- with the
  // difference that this one was never let in at all.
  const outsiderRename = await b("POST", `/api/auth/wallets/${walletA.id}/name`, { name: "mine now" });
  record("a stranger cannot rename somebody else's wallet",
    outsiderRename.status === 403 && /NOT_WALLET_MANAGER/.test(outsiderRename.text),
    `status ${outsiderRename.status}: ${outsiderRename.text.slice(0, 160)}`);

  const outsiderDelete = await b("DELETE", `/api/auth/wallets/${walletA.id}`, {
    confirm: walletA.name,
  });
  record("a stranger cannot delete somebody else's wallet",
    outsiderDelete.status === 403 && /NOT_WALLET_MANAGER/.test(outsiderDelete.text),
    `status ${outsiderDelete.status}: ${outsiderDelete.text.slice(0, 160)}`);

  const survived = await a("GET", "/api/auth/wallets");
  record("and the wallet is untouched after both attempts",
    Boolean(search(survived.json, (w) => w.id === walletA.id && w.name === walletA.name)),
    survived.text.slice(0, 160));

  // Even its owner cannot delete the wallet sign-up gave them: doing so would
  // leave an account with nowhere to put anything.
  const firstWallet = await a("DELETE", `/api/auth/wallets/${walletA.id}`, {
    confirm: walletA.name,
  });
  record("the first wallet of an account cannot be deleted",
    firstWallet.status === 409 && /FIRST_WALLET/.test(firstWallet.text),
    `status ${firstWallet.status}: ${firstWallet.text.slice(0, 160)}`);

  // A second wallet, which is deletable, is what the rest of this section
  // works on. Creating one also selects it, so A is looking at it from here.
  const created = await a("POST", "/api/auth/wallets", { name: "A's second wallet" });
  record("a second wallet can be created", created.status === 201 && Boolean(created.json.id),
    `status ${created.status}: ${created.text.slice(0, 160)}`);
  const second = created.json;

  const listed = await a("GET", "/api/auth/wallets");
  record("the second wallet is not marked as the first one",
    search(listed.json, (w) => w.id === second.id && w.first_wallet === false) !== null,
    listed.text.slice(0, 240));

  const renamed = await a("POST", `/api/auth/wallets/${second.id}/name`, { name: "A's renamed wallet" });
  record("the wallet's creator can rename it",
    renamed.status === 200 && renamed.json && renamed.json.name === "A's renamed wallet",
    `status ${renamed.status}: ${renamed.text.slice(0, 160)}`);

  const emptyName = await a("POST", `/api/auth/wallets/${second.id}/name`, { name: "   " });
  record("a wallet cannot be renamed to nothing",
    emptyName.status === 400 && /INVALID_WALLET_NAME/.test(emptyName.text),
    `status ${emptyName.status}: ${emptyName.text.slice(0, 160)}`);

  // The confirmation is the server's rule, not the dialog's: the old name is
  // no longer the right answer.
  const mistyped = await a("DELETE", `/api/auth/wallets/${second.id}`, { confirm: "A's second wallet" });
  record("deleting without the exact name is refused",
    mistyped.status === 400 && /CONFIRMATION_MISMATCH/.test(mistyped.text),
    `status ${mistyped.status}: ${mistyped.text.slice(0, 160)}`);

  const stillListed = await a("GET", "/api/auth/wallets");
  record("and the wallet is still there after the mistyped confirmation",
    search(stillListed.json, (w) => w.id === second.id) !== null,
    stillListed.text.slice(0, 240));

  const deleted = await a("DELETE", `/api/auth/wallets/${second.id}`, {
    confirm: "A's renamed wallet",
  });
  record("the wallet's creator can delete it", deleted.status === 200,
    `status ${deleted.status}: ${deleted.text.slice(0, 160)}`);

  const afterDelete = await a("GET", "/api/auth/wallets");
  record("the deleted wallet is gone from the list",
    search(afterDelete.json, (w) => w.id === second.id) === null,
    afterDelete.text.slice(0, 240));

  // Whoever was looking at it lands on the picker, not on the login screen:
  // the session is still valid, only its choice is gone.
  const orphaned = await a("GET", "/api/accounts");
  record("deleting the selected wallet leaves the session valid and unchosen",
    orphaned.status === 409 && /NO_WALLET_SELECTED/.test(orphaned.text),
    `status ${orphaned.status}: ${orphaned.text.slice(0, 160)}`);

  const backHome = await a("POST", "/api/auth/wallet", { walletId: walletA.id });
  record("and the first wallet can be picked up again", backHome.status === 200,
    `status ${backHome.status}: ${backHome.text.slice(0, 160)}`);

  // --- 9. changing the username --------------------------------------------
  // Tried on the revoked account rather than on A, whose name the checks
  // further down still sign in with.
  const newName = `iso-p-${suffix}`;

  const wrongPassword = await reader("POST", "/api/auth/username", {
    username: newName,
    password: "not-the-password",
  });
  record("changing the username needs the current password",
    wrongPassword.status === 401 && /WRONG_CURRENT_PASSWORD/.test(wrongPassword.text),
    `status ${wrongPassword.status}: ${wrongPassword.text.slice(0, 160)}`);

  const badName = await reader("POST", "/api/auth/username", {
    username: "a b",
    password: "test-password-r",
  });
  record("an unusable username is refused",
    badName.status === 400 && /INVALID_USERNAME/.test(badName.text),
    `status ${badName.status}: ${badName.text.slice(0, 160)}`);

  // Case-insensitively taken: the unique index is on lower(username), and the
  // endpoint has to answer with that and not with a constraint violation.
  const collision = await reader("POST", "/api/auth/username", {
    username: `iso-a-${suffix}`.toUpperCase(),
    password: "test-password-r",
  });
  record("a username somebody else already has is refused",
    collision.status === 409 && /USERNAME_TAKEN/.test(collision.text),
    `status ${collision.status}: ${collision.text.slice(0, 160)}`);

  const renamedUser = await reader("POST", "/api/auth/username", {
    username: newName,
    password: "test-password-r",
  });
  record("the username can be changed",
    renamedUser.status === 200 && renamedUser.json && renamedUser.json.username === newName,
    `status ${renamedUser.status}: ${renamedUser.text.slice(0, 160)}`);

  // Deliberate: a session resolves to a user_id, never to a username, and
  // nothing secret was rotated. Signing every device out would be theatre.
  const stillSignedIn = await reader("GET", "/api/auth/me");
  record("the session survives the rename and reports the new name",
    stillSignedIn.status === 200 && stillSignedIn.json && stillSignedIn.json.username === newName,
    `status ${stillSignedIn.status}: ${stillSignedIn.text.slice(0, 160)}`);

  const withNewName = createClient();
  const loginNew = await withNewName("POST", "/api/auth/login", {
    username: newName,
    password: "test-password-r",
  });
  record("the new username signs in", loginNew.status === 200,
    `status ${loginNew.status}: ${loginNew.text.slice(0, 160)}`);

  const withOldName = createClient();
  const loginOld = await withOldName("POST", "/api/auth/login", {
    username: readerName,
    password: "test-password-r",
  });
  record("the old username no longer signs in", loginOld.status === 401,
    `status ${loginOld.status}: ${loginOld.text.slice(0, 160)}`);

  // --- 10. with no session nothing is visible -------------------------------
  const anonymous = createClient();
  const noAuth = await anonymous("GET", "/api/accounts");
  record("with no session the API answers 401", noAuth.status === 401, `status ${noAuth.status}`);

  // --- 11. sessions do not survive a logout ---------------------------------
  const afterLogout = createClient();
  await afterLogout("POST", "/api/auth/login", {
    username: `iso-a-${suffix}`,
    password: "test-password-a",
  });
  await afterLogout("POST", "/api/auth/logout");
  const retry = await afterLogout("GET", "/api/accounts");
  record("after logout the session is no longer valid", retry.status === 401, `status ${retry.status}`);

  // --- 12. wrong passwords disable the account -----------------------------
  const victim = `iso-c-${suffix}`;
  const owner = createClient();
  await registerUser(owner, victim, "test-password-c");

  // A passkey for C before the lockout, so section 13 can check that it does
  // not open a door the lockout closed.
  const authC = createAuthenticator();
  if (passkeysOn) {
    const regC = await registerPasskey(owner, "test-password-c", "C's phone", passkeyOrigin, authC);
    record("C can add a passkey", Boolean(regC.verify && regC.verify.status === 201),
      regC.verify ? `status ${regC.verify.status}` : `options ${regC.options.status}`);
  }

  // A separate client, so the failures are counted against the account and not
  // against a session that is already valid.
  const guesser = createClient();
  let lastWrong;
  for (let i = 0; i < 5; i++) {
    lastWrong = await guesser("POST", "/api/auth/login", {
      username: victim,
      password: "wrong-password",
    });
  }

  // A wrong password must answer the same whether or not the account exists,
  // and must not leak that it has just been disabled.
  record(
    "a wrong password says nothing about the account",
    lastWrong.status === 401 && !/LOCKED|disabled/i.test(lastWrong.text),
    `status ${lastWrong.status}: ${lastWrong.text.slice(0, 140)}`,
  );

  const rightAfterLock = await guesser("POST", "/api/auth/login", {
    username: victim,
    password: "test-password-c",
  });
  record(
    "five wrong passwords lock the account",
    rightAfterLock.status === 403 && /ACCOUNT_LOCKED/.test(rightAfterLock.text),
    `status ${rightAfterLock.status}: ${rightAfterLock.text.slice(0, 160)}`,
  );

  // The lock is temporary and stops new sign-ins only: a
  // stranger's wrong guesses must not be able to throw the owner out of the
  // devices they are already signed in on. api/test/security.js covers the
  // doubling, the expiry and the administrator's unlock.
  const stale = await owner("GET", "/api/accounts");
  record(
    "the lock leaves the session the account already had open",
    stale.status === 200,
    `status ${stale.status}`,
  );

  // --- 13. passkeys ----------------------------------------------------------
  // What can be checked on any instance: the flag, that every endpoint wants a
  // session, and that one account cannot see or touch another's passkeys. With
  // BUSSOLA_PUBLIC_URL set, the ceremonies themselves as well.
  record("status says whether passkeys are available",
    typeof (instance.json && instance.json.passkeys) === "boolean",
    instance.text.slice(0, 160));

  const nobody = createClient();
  for (const [method, path, body] of [
    ["GET", "/api/auth/passkeys"],
    ["POST", "/api/auth/passkeys/register/options", { password: "x" }],
    ["POST", "/api/auth/passkeys/register/verify", { response: {} }],
    ["POST", `/api/auth/passkeys/${ofB.passkey}/name`, { name: "mine now" }],
    ["DELETE", `/api/auth/passkeys/${ofB.passkey}`],
  ]) {
    const r = await nobody(method, path, body);
    record(`passkeys: ${method} ${path} needs a session`, r.status === 401, `status ${r.status}`);
  }

  const listA = await a("GET", "/api/auth/passkeys");
  record("A's passkey list holds nothing of B's",
    listA.status === 200 && Array.isArray(listA.json) && !listA.text.includes(MARK_B)
      && !search(listA.json, (p) => p.id === ofB.passkey),
    `status ${listA.status}: ${listA.text.slice(0, 160)}`);

  const renameOthers = await a("POST", `/api/auth/passkeys/${ofB.passkey}/name`, { name: "TAKEN" });
  record("A cannot rename B's passkey",
    renameOthers.status === 404 && /PASSKEY_NOT_FOUND/.test(renameOthers.text),
    `status ${renameOthers.status}: ${renameOthers.text.slice(0, 160)}`);

  const deleteOthers = await a("DELETE", `/api/auth/passkeys/${ofB.passkey}`);
  record("A cannot delete B's passkey",
    deleteOthers.status === 404 && /PASSKEY_NOT_FOUND/.test(deleteOthers.text),
    `status ${deleteOthers.status}: ${deleteOthers.text.slice(0, 160)}`);

  const noPassword = await a("POST", "/api/auth/passkeys/register/options", { password: "not-the-password" });
  if (passkeysOn) {
    record("adding a passkey needs the current password",
      noPassword.status === 401 && /WRONG_CURRENT_PASSWORD/.test(noPassword.text),
      `status ${noPassword.status}: ${noPassword.text.slice(0, 160)}`);
  } else {
    record("with passkeys off, adding one is refused",
      noPassword.status === 404 && /PASSKEYS_DISABLED/.test(noPassword.text),
      `status ${noPassword.status}: ${noPassword.text.slice(0, 160)}`);
    const offLogin = await nobody("POST", "/api/auth/passkeys/login/options");
    record("with passkeys off, signing in with one is refused",
      offLogin.status === 404 && /PASSKEYS_DISABLED/.test(offLogin.text),
      `status ${offLogin.status}: ${offLogin.text.slice(0, 160)}`);
    console.log("\nPasskeys are off on this instance (no BUSSOLA_PUBLIC_URL): the ceremonies were skipped.");
  }

  if (passkeysOn) {
    const listB = await b("GET", "/api/auth/passkeys");
    record("B's passkey survived A's attempts",
      Boolean(search(listB.json, (p) => p.id === ofB.passkey && p.name === passkeyNameB)),
      listB.text.slice(0, 200));

    // Signing in: no username, and the session is the ordinary one -- with
    // one wallet it is already chosen, exactly as after a password.
    const viaPasskey = createClient();
    const signedIn = await passkeySignIn(viaPasskey, authB, passkeyOrigin);
    record("a passkey signs its owner in, with no username",
      signedIn.status === 200 && signedIn.json && signedIn.json.username === `iso-b-${suffix}`,
      `status ${signedIn.status}: ${signedIn.text.slice(0, 160)}`);

    const meViaPasskey = await viaPasskey("GET", "/api/auth/me");
    record("and opens an ordinary session, wallet chosen as after a password",
      meViaPasskey.status === 200 && meViaPasskey.json.wallet && meViaPasskey.json.wallet.id === ofB.wallet,
      `status ${meViaPasskey.status}: ${meViaPasskey.text.slice(0, 160)}`);

    const usedNow = await b("GET", "/api/auth/passkeys");
    record("the passkey's last use is recorded",
      Boolean(search(usedNow.json, (p) => p.id === ofB.passkey && p.lastUsedAt)),
      usedNow.text.slice(0, 200));

    // A signed response is good once.
    const once = await nobody("POST", "/api/auth/passkeys/login/options");
    const assertion = authB.assert(once.json, passkeyOrigin);
    const first = await createClient()("POST", "/api/auth/passkeys/login/verify", { response: assertion });
    const replay = await createClient()("POST", "/api/auth/passkeys/login/verify", { response: assertion });
    record("a signed challenge cannot be used twice",
      first.status === 200 && replay.status === 401 && /PASSKEY_FAILED/.test(replay.text),
      `first ${first.status}, replay ${replay.status}: ${replay.text.slice(0, 120)}`);

    // Two different failures, one answer.
    const unknown = await passkeySignIn(createClient(), createAuthenticator(), passkeyOrigin);
    const forged = await passkeySignIn(createClient(), authB, passkeyOrigin, { forge: true });
    record("an unknown passkey is refused", unknown.status === 401 && /PASSKEY_FAILED/.test(unknown.text),
      `status ${unknown.status}: ${unknown.text.slice(0, 160)}`);
    record("a bad signature is refused", forged.status === 401 && /PASSKEY_FAILED/.test(forged.text),
      `status ${forged.status}: ${forged.text.slice(0, 160)}`);
    record("and the two refusals cannot be told apart", unknown.text === forged.text,
      `${unknown.text} vs ${forged.text}`);

    const phished = await passkeySignIn(createClient(), authB, "https://bussola.evil.example");
    record("a signature made for another site is refused", phished.status === 401,
      `status ${phished.status}: ${phished.text.slice(0, 160)}`);

    // The lockout guards the password. Failed passkey attempts must not feed
    // it: otherwise anyone could switch an account off without even knowing
    // its username.
    for (let i = 0; i < 5; i++) {
      await passkeySignIn(createClient(), authB, passkeyOrigin, { forge: true });
    }
    const stillOpen = await createClient()("POST", "/api/auth/login", {
      username: `iso-b-${suffix}`,
      password: "test-password-b",
    });
    record("failed passkey sign-ins do not count toward the lockout", stillOpen.status === 200,
      `status ${stillOpen.status}: ${stillOpen.text.slice(0, 160)}`);

    // A registration challenge belongs to the account that typed its password
    // for it; somebody else's session cannot redeem it.
    const optionsA = await a("POST", "/api/auth/passkeys/register/options", { password: "test-password-a" });
    const hijack = await b("POST", "/api/auth/passkeys/register/verify", {
      response: createAuthenticator().register(optionsA.json, passkeyOrigin),
      name: "hijack",
    });
    record("a registration challenge works only for the account it was issued to",
      optionsA.status === 200 && hijack.status === 400 && /PASSKEY_CHALLENGE_EXPIRED/.test(hijack.text),
      `options ${optionsA.status}, verify ${hijack.status}: ${hijack.text.slice(0, 160)}`);

    // A passkey is not a way around the lockout.
    const locked = await passkeySignIn(createClient(), authC, passkeyOrigin);
    record("a locked account cannot sign in with a passkey either",
      locked.status === 403 && /ACCOUNT_LOCKED/.test(locked.text),
      `status ${locked.status}: ${locked.text.slice(0, 160)}`);

    const renamedOwn = await b("POST", `/api/auth/passkeys/${ofB.passkey}/name`, { name: `Phone ${MARK_B}` });
    record("the owner can rename their passkey",
      renamedOwn.status === 200 && renamedOwn.json.name === `Phone ${MARK_B}`,
      `status ${renamedOwn.status}: ${renamedOwn.text.slice(0, 160)}`);

    const blankName = await b("POST", `/api/auth/passkeys/${ofB.passkey}/name`, { name: "   " });
    record("a passkey cannot be renamed to nothing",
      blankName.status === 400 && /INVALID_PASSKEY_NAME/.test(blankName.text),
      `status ${blankName.status}: ${blankName.text.slice(0, 160)}`);

    const removed = await b("DELETE", `/api/auth/passkeys/${ofB.passkey}`);
    record("the owner can remove their passkey", removed.status === 200,
      `status ${removed.status}: ${removed.text.slice(0, 160)}`);

    const afterRemoval = await passkeySignIn(createClient(), authB, passkeyOrigin);
    record("a removed passkey no longer signs in", afterRemoval.status === 401,
      `status ${afterRemoval.status}: ${afterRemoval.text.slice(0, 160)}`);
  }

  // --- 14. Web Push ----------------------------------------------------------
  // Subscriptions belong to a person: every endpoint wants a session, one
  // account cannot remove another's, and the server refuses to be pointed at
  // anything but a real push service.
  record("status says whether notifications are available",
    typeof (instance.json && instance.json.push) === "boolean"
      && (instance.json.push
        ? typeof instance.json.pushPublicKey === "string" && instance.json.pushPublicKey.length > 40
        : instance.json.pushPublicKey === null)
      && !/private/i.test(instance.text),
    instance.text.slice(0, 200));

  for (const [method, path, body] of [
    ["POST", "/api/auth/push/subscribe", { subscription: pushSubscription(ofB.pushEndpoint) }],
    ["DELETE", "/api/auth/push/subscribe", { endpoint: ofB.pushEndpoint }],
    ["POST", "/api/auth/push/status", { endpoint: ofB.pushEndpoint }],
    ["POST", "/api/auth/push/test", {}],
  ]) {
    const r = await nobody(method, path, body);
    record(`push: ${method} ${path} needs a session`, r.status === 401, `status ${r.status}`);
  }

  const deleteOthersPush = await a("DELETE", "/api/auth/push/subscribe", { endpoint: ofB.pushEndpoint });
  record("A cannot remove B's subscription (a stranger's endpoint is not found)",
    deleteOthersPush.status === 404 && /PUSH_SUBSCRIPTION_NOT_FOUND/.test(deleteOthersPush.text),
    `status ${deleteOthersPush.status}: ${deleteOthersPush.text.slice(0, 160)}`);
  const othersStatus = await a("POST", "/api/auth/push/status", { endpoint: ofB.pushEndpoint });
  record("A asking about B's subscription is told it is not subscribed",
    othersStatus.status === 200 && othersStatus.json && othersStatus.json.subscribed === false,
    `status ${othersStatus.status}: ${othersStatus.text.slice(0, 160)}`);

  if (pushOn) {
    for (const [what, endpoint, code] of [
      ["a plain-http endpoint", "http://fcm.googleapis.com/fcm/send/abcdefghijklmnop", "PUSH_ENDPOINT_NOT_ALLOWED"],
      ["an IP literal", "https://169.254.169.254/latest/meta-data/abcdefghij", "PUSH_ENDPOINT_NOT_ALLOWED"],
      ["the API's own address", "https://api:3001/api/health/abcdefghijklmnop", "PUSH_ENDPOINT_NOT_ALLOWED"],
      ["a host that is not a push service", "https://example.com/push/abcdefghijklmnopqrst", "PUSH_ENDPOINT_NOT_ALLOWED"],
      ["a look-alike host", "https://fcm.googleapis.com.evil.example/fcm/send/abcdefg", "PUSH_ENDPOINT_NOT_ALLOWED"],
      ["keys of the wrong shape", null, "INVALID_PUSH_SUBSCRIPTION"],
    ]) {
      const sub = endpoint
        ? pushSubscription(endpoint)
        : { endpoint: "https://fcm.googleapis.com/fcm/send/abcdefghijklmnop", keys: { p256dh: "x", auth: "y" } };
      const r = await a("POST", "/api/auth/push/subscribe", { subscription: sub });
      record(`subscribe refuses ${what}`, r.status === 400 && r.text.includes(code), `status ${r.status}: ${r.text.slice(0, 160)}`);
    }

    // B's own subscription is still there: the owner removes it once, and then
    // it is gone.
    const ownStatus = await b("POST", "/api/auth/push/status", { endpoint: ofB.pushEndpoint });
    record("B's own session sees its subscription", ownStatus.status === 200 && ownStatus.json && ownStatus.json.subscribed === true,
      `status ${ownStatus.status}: ${ownStatus.text.slice(0, 160)}`);
    const ownRemoval = await b("DELETE", "/api/auth/push/subscribe", { endpoint: ofB.pushEndpoint });
    record("B's subscription survived A's attempt, and B can remove it", ownRemoval.status === 200,
      `status ${ownRemoval.status}: ${ownRemoval.text.slice(0, 160)}`);
    const again = await b("DELETE", "/api/auth/push/subscribe", { endpoint: ofB.pushEndpoint });
    record("removing it twice finds nothing", again.status === 404, `status ${again.status}`);

    const ownA = await a("DELETE", "/api/auth/push/subscribe", { endpoint: `https://fcm.googleapis.com/fcm/send/iso-a-${RUN}-endpoint-a` });
    record("A can remove the subscription the sweep made", ownA.status === 200, `status ${ownA.status}: ${ownA.text.slice(0, 160)}`);
  } else {
    const off = await a("POST", "/api/auth/push/subscribe", { subscription: pushSubscription(ofB.pushEndpoint) });
    record("with push off, subscribing is refused (404 PUSH_DISABLED)", off.status === 404 && /PUSH_DISABLED/.test(off.text),
      `status ${off.status}: ${off.text.slice(0, 160)}`);
    console.log("\nNotifications are off on this instance (no BUSSOLA_PUBLIC_URL): only the session checks ran.");
  }

  // --- outcome --------------------------------------------------------------
  console.log("");
  for (const e of results) {
    console.log(`${e.ok ? "  ok  " : "  FAIL"}  ${e.name}${e.ok ? "" : "\n        " + e.detail}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed.`);

  if (failures > 0) {
    console.error(`\n${failures} checks failed: isolation between users is NOT guaranteed.`);
    process.exit(1);
  }
  console.log("Isolation verified.");
};

main().catch((error) => {
  console.error("The test did not run to completion:", error.message);
  process.exit(2);
});
