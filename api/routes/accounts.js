const router = require("express").Router();
const { withWallet, withWalletWrite, withWalletPhased } = require("../auth/middleware");
const accounts_controller = require("../controllers/accounts_controller");
const holdings_controller = require("../controllers/holdings_controller");

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
router.get("/accounts", withWallet((req) => accounts_controller.getAccounts(req)));
router.post("/accounts", withWalletWrite((req) => accounts_controller.createAccount(req)));
router.post("/accounts/:id", withWalletWrite((req) => accounts_controller.updateAccount(req)));
router.delete("/accounts/:id", withWalletWrite((req) => accounts_controller.deleteAccount(req.params.id)));
router.post(
  "/accounts/:id/archive",
  withWalletWrite((req) => accounts_controller.setAccountArchived(req.params.id, req.body.archived === true)),
);

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
router.get("/categories/:kind", withWallet((req) => accounts_controller.getCategories(req, req.params.kind)));
router.post("/categories", withWalletWrite((req) => accounts_controller.createCategory(req)));
router.post("/categories/:id", withWalletWrite((req) => accounts_controller.updateCategory(req)));
router.delete("/categories/:id", withWalletWrite((req) => accounts_controller.deleteCategory(req.params.id)));
router.post(
  "/categories/:id/archive",
  withWalletWrite((req) => accounts_controller.setCategoryArchived(req.params.id, req.body.archived === true)),
);

// ---------------------------------------------------------------------------
// Lookup tables
// ---------------------------------------------------------------------------
// Pillars and the seeded holding types are shared by the whole instance: they
// are a taxonomy, not personal data. A type somebody adds belongs to their
// wallet (under RLS like the accounts), and adding or removing
// one is a write like any other: a read-only member does not get to do it.
// They stay behind the wallet wrappers because they need a connection anyway,
// and because an endpoint outside the common pattern is an endpoint somebody
// eventually forgets to protect.
router.get("/pillars", withWallet(() => holdings_controller.getPillars()));
router.get("/holding-types", withWallet(() => holdings_controller.getHoldingTypes()));
router.post("/holding-types", withWalletWrite((req) => holdings_controller.createHoldingType(req.body)));
router.delete("/holding-types/:id", withWalletWrite((req) => holdings_controller.deleteHoldingType(req.params.id)));

// ---------------------------------------------------------------------------
// Holdings
// ---------------------------------------------------------------------------
router.get(
  "/holdings/distinct/:field",
  withWallet((req) => holdings_controller.getDistinctValues(req.params.field)),
);
router.get("/accounts/:id/holdings", withWallet((req) => holdings_controller.getHoldings(req.params.id)));
router.post(
  "/accounts/:id/holdings",
  withWalletWrite((req) => holdings_controller.createHolding(req.params.id, req.body)),
);

// This literal route must be declared before "/holdings/:hid", or Express
// matches the parameterised one first and hands "refresh-all" over as an id.
// "All" means "all in this wallet": RLS narrows the query to the wallet in
// context. Refreshing stores the fetched prices, so it counts as a write.
//
// The three refresh routes are phased (withWalletPhased in auth/middleware.js): they wait
// on external quote providers, and must not hold a database transaction open
// while they do. Same refusals as withWalletWrite, read-only member included.
router.post("/holdings/refresh-all", withWalletPhased((req, tx) => holdings_controller.refreshAll(req, tx)));

router.post("/holdings/:hid", withWalletWrite((req) => holdings_controller.updateHolding(req.params.hid, req.body)));
router.delete("/holdings/:hid", withWalletWrite((req) => holdings_controller.deleteHolding(req.params.hid)));

router.post(
  "/accounts/:id/holdings/refresh",
  withWalletPhased((req, tx) => holdings_controller.refreshAccount(req, tx)),
);
router.post("/holdings/:hid/refresh", withWalletPhased((req, tx) => holdings_controller.refreshHolding(req, tx)));

module.exports = router;
