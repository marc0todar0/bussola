const express = require("express");
const { withWallet, withWalletWrite } = require("../auth/middleware");
const export_controller = require("../controllers/export_controller");
const import_controller = require("../controllers/import_controller");
const DataError = require("../services/dataError");

const router = express.Router();

// ---------------------------------------------------------------------------
// Import and export, mounted at /api/data
// ---------------------------------------------------------------------------
// The same two wrappers as every other data endpoint, and the same rule for
// choosing between them: exporting reads, so a read-only member may do it;
// importing writes, so withWalletWrite turns that member away with a 403
// before anything is parsed -- and the RLS policies would refuse the INSERTs
// even if it did not.
//
// `coded` is the one addition: an unexpected error gets an import- or
// export-specific code (IMPORT_FAILED, EXPORT_FAILED) instead of the wrappers'
// generic REQUEST_FAILED. A DataError carries its own status and code and is
// answered with them -- but here it is caught INSIDE the transaction, which
// therefore commits. That is harmless only because the import and export
// controllers throw a DataError before their first write (parsing, options,
// selection, validation); keep it so. Anything else is answered with the
// fallback code and re-thrown, so that withTenant rolls the transaction back:
// an import that failed halfway must leave nothing behind.
const coded = (fn, fallbackCode) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (error) {
    if (res.headersSent) throw error;
    if (error instanceof DataError) {
      res.status(error.status).json({ code: error.code, error: error.message, ...error.extra });
      return undefined;
    }
    // The message stays in the log: an unexpected error's text is the
    // database's own, and it describes the schema, not the file.
    console.error(`[data] ${fallbackCode}:`, error);
    res.status(500).json({ code: fallbackCode, error: "The request failed" });
    throw error;
  }
};

router.get(
  "/export/transactions.csv",
  withWallet(coded((req, res) => export_controller.transactionsCsv(req, res), "EXPORT_FAILED")),
);
router.get(
  "/export/wallet.zip",
  withWallet(coded((req, res) => export_controller.walletZip(req, res), "EXPORT_FAILED")),
);

// The file travels inside the JSON body, base64-encoded, so these two routes
// get a parser of their own with room for it: 5 MB of file is about 6.7 MB of
// base64. index.js leaves /api/data/import/ out of the application-wide
// parser, whose 100 kB limit would refuse every real file, and this one runs
// only after the session has been checked -- a stranger cannot make the API
// parse megabytes of JSON.
const importBody = express.json({ limit: "8mb" });

router.post(
  "/import/preview",
  importBody,
  withWalletWrite(coded((req) => import_controller.preview(req), "IMPORT_FAILED")),
);
router.post(
  "/import/commit",
  importBody,
  withWalletWrite(coded((req) => import_controller.commit(req), "IMPORT_FAILED")),
);

// A body over the limit, or one that is not JSON, never reaches the routes:
// body-parser fails first and Express would answer with an HTML error page.
// Answered here with a code, like everything else.
// eslint-disable-next-line no-unused-vars
router.use((error, req, res, next) => {
  if (error && error.type === "entity.too.large") {
    const { MB } = import_controller.limits;
    return res
      .status(413)
      .json({ code: "IMPORT_TOO_LARGE", error: `The file is larger than ${MB} MB`, max: MB });
  }
  if (error && error.type === "entity.parse.failed") {
    return res.status(400).json({ code: "IMPORT_BAD_OPTIONS", error: "The request body is not valid JSON" });
  }
  console.error("[data] REQUEST_FAILED:", error);
  return res.status(500).json({ code: "REQUEST_FAILED", error: "The request failed" });
});

module.exports = router;
