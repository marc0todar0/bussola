const express = require("express");
const router = express.Router();

router.use("/transactions", require("./transactions"));
router.use("/summary", require("./summary"));
router.use("/portfolio", require("./portfolio"));
// CSV and ZIP export, and the import with its preview.
router.use("/data", require("./data"));
// Drafts from bank notifications, the session half (routes/inbox.js).
router.use("/inbox", require("./inbox").sessionRouter);

// Accounts, categories, holdings and the lookup tables sit at the top level
// rather than under a shared prefix: they are siblings of transactions, not a
// sub-resource of anything.
router.use("/", require("./accounts"));

module.exports = router;
