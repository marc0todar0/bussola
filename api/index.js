//! Importing packages
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const dotenv = require("dotenv");
const path = require("path");
dotenv.config({ path: path.resolve(__dirname, "../.env") });

//!import routes
const { unknownEndpoint } = require("./routes/default");
const apiRoutes = require("./routes");
const authRoutes = require("./auth/routes");
const { identifyUser, requireAuth, sameOrigin, publicError } = require("./auth/middleware");
const { bootstrapFirstUser } = require("./auth/bootstrap");
const { purgeExpired } = require("./auth/sessions");
const { startSnapshotCron } = require("./cron");
const { runMigrations, configureAppRole, verifyIsolation } = require("./migrate");
const db = require("./dbConn");

//!configuration
const app = express();

// Behind nginx: without this req.ip is always the proxy's, and the login
// throttle would count every user as one.
//
// A number of hops, never `true`. `true` believes the left-most address in
// X-Forwarded-For, which is whatever the client wrote there -- a fresh address,
// and a fresh throttle bucket, on every request. With a count, Express reads
// the header from the right and stops after that many proxies, each of which
// appended the address it saw: what the client wrote sits further left and is
// never reached.
//
//   1  (default) nginx only -- the standard deployment
//   2  nginx behind one more reverse proxy that terminates HTTPS (Caddy,
//      Traefik...), which appends the real client address
//   0  the API is reached directly, with no proxy in front: X-Forwarded-For
//      is ignored altogether
const trustedProxies = Number.parseInt(process.env.BUSSOLA_TRUSTED_PROXIES ?? "1", 10);
app.set("trust proxy", Number.isInteger(trustedProxies) && trustedProxies >= 0 ? trustedProxies : 1);

// In production the frontend goes through nginx, which proxies /api: same
// origin, no CORS headers needed. CORS_ORIGINS is only for people keeping the
// frontend and the API on different domains (or developing without the Vite
// proxy).
const corsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
if (corsOrigins.length > 0) {
  app.use(cors({ origin: corsOrigins, credentials: true }));
  console.log(`CORS enabled for: ${corsOrigins.join(", ")}`);
}

// Before auth: the container healthcheck needs it, and it has no credentials.
// /health is what the healthcheck calls inside the container; /api/health is
// the same answer from outside, through nginx's /api proxy -- for a dashboard
// or an uptime monitor. It says "ok" or "degraded" and nothing else.
app.get(["/health", "/api/health"], async (req, res) => {
  try {
    await db.adminPool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch (e) {
    res.status(503).json({ status: "degraded", error: "database unreachable" });
  }
});

app.use(cookieParser());

// The import endpoints carry a whole file in their body and parse it with a
// larger limit of their own (routes/data.js), after the session has been
// checked. The default parser has to leave them alone: it would read the body
// first and refuse anything over 100 kB.
const jsonBody = express.json();
app.use((req, res, next) => (req.path.startsWith("/api/data/import/") ? next() : jsonBody(req, res, next)));

// Anything that changes something has to come from this application's own
// pages (auth/middleware.js explains why SameSite=Lax is not enough). Ahead of
// every /api route, sign-in included: a login form posted from another port
// would otherwise sign the victim into the attacker's account.
app.use("/api", sameOrigin);

// Login, logout and sign-up cannot require you to already be inside.
app.use("/api/auth", identifyUser, authRoutes);

// The two inbox endpoints an app or automation posts to with a personal token
// (auth/tokens.js): they take no session, so they sit ahead of requireAuth.
// Any other path falls through to the session-only tree below, where a
// Bearer header counts for nothing.
app.use("/api/inbox", require("./routes/inbox").tokenRouter);

// Everything else does. requireAuth lives here rather than on the individual
// routes: a new endpoint is born protected, and forgetting is not an option.
app.use("/api", identifyUser, requireAuth, apiRoutes);
app.use(unknownEndpoint);

// The last word on anything thrown outside withWallet's own catch: a body that
// is not JSON, a body over the limit, a bug in a middleware. Express' default
// answer is an HTML page with a stack trace in it; this one is a code and a
// sentence, and the detail goes to the log.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error && error.type === "entity.parse.failed") {
    return res.status(400).json({ code: "INVALID_REQUEST", error: "The request body is not valid JSON" });
  }
  if (error && error.type === "entity.too.large") {
    return res.status(413).json({ code: "PAYLOAD_TOO_LARGE", error: "The request body is too large" });
  }
  console.error(`Unhandled error in ${req.method} ${req.originalUrl}:`, error);
  const { status, body } = publicError(error || {});
  res.status(status).json(body);
});

//!Server listening
const port = process.env.PORT || 3001;

// The model that reads bank notifications (services/inbox/extract.js), when
// BUSSOLA_AI_URL and BUSSOLA_AI_MODEL name one. Notifications left waiting by
// a restart are queued again, and readings that failed for a passing reason
// (a quota, the endpoint down) are tried again when their time comes.
const startNotificationReader = () => {
  const { aiEnabled, aiCloud, aiModel, aiHost } = require("./services/inbox/extract");
  const { resumePending, startRetryScheduler } = require("./controllers/inbox_controller");
  if (aiEnabled()) {
    // Host only, never the key.
    console.log(
      `[ai] bank notifications are read by ${aiModel()} at ${aiHost()}${aiCloud() ? " (not on your network: their text is sent there)" : ""}.`,
    );
  } else if (process.env.BUSSOLA_AI_URL) {
    console.log("[ai] BUSSOLA_AI_URL needs BUSSOLA_AI_MODEL too: notifications are not read.");
  }
  resumePending()
    .catch((error) => console.error("[ai] could not resume pending notifications:", error.message))
    .finally(() => startRetryScheduler());
  // Is the quotes service there? (It is opt-in: its container may not run.)
  require("./services/quotes").probeQuotes().catch(() => {});
};

const start = async () => {
  // Migrations run as the table owner: they have to be able to touch every
  // user's rows, which is exactly what RLS denies the application role.
  await runMigrations(db.adminPool);

  const password = await configureAppRole(db.adminPool);
  const appPool = db.initAppPool(password);

  // If isolation were not filtering, the API must not start: better a
  // container that stays down than one serving one user's data to another.
  await verifyIsolation(appPool);

  await bootstrapFirstUser();

  // Web Push: the server's VAPID key pair, when BUSSOLA_PUBLIC_URL enables it.
  await require("./services/push").init();

  const expired = await purgeExpired();
  if (expired > 0) console.log(`[auth] removed ${expired} expired sessions.`);

  app.listen(port, "0.0.0.0", () => {
    console.log(`App running on port ${port}.`);
    startSnapshotCron();
    startNotificationReader();
  });
};

start().catch((e) => {
  console.error("Startup failed:", e.message);
  process.exit(1);
});
