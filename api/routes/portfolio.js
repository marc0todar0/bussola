const router = require("express").Router();
const { withWallet, withWalletWrite } = require("../auth/middleware");
const portfolio_controller = require("../controllers/portfolio_controller");

router.get("/allocation", withWallet(() => portfolio_controller.getAllocation()));
router.get("/history", withWallet(() => portfolio_controller.getHistory()));

// Allocation by diversification dimension (type, issuer, country, currency,
// broker, asset). Optional ?pillar= and ?types=csv filters.
router.get(
  "/allocation/:dim",
  withWallet((req) =>
    portfolio_controller.allocationByDimension({
      dim: req.params.dim,
      pillar: req.query.pillar,
      types: req.query.types,
    }),
  ),
);

// A snapshot's frozen detail (donut plus accounts/holdings as of that date).
router.get(
  "/snapshot/:year/:month",
  withWallet(async (req, res) => {
    const detail = await portfolio_controller.getSnapshotDetail(req.params.year, req.params.month);
    if (!detail) {
      res.status(404).json({ code: "SNAPSHOT_NOT_FOUND", error: "Snapshot not found" });
      return;
    }
    return detail;
  }),
);

// Idempotent upsert of this month's snapshot (callable from cron/crontab).
router.post("/snapshot", withWalletWrite((req) => portfolio_controller.createSnapshot(req.body || {})));

module.exports = router;
