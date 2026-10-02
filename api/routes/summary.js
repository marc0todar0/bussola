const router = require("express").Router();
const { withWallet } = require("../auth/middleware");
const summary_controller = require("../controllers/summary_controller");

router.get("/", withWallet((req) => summary_controller.getChartData(req)));

// The monthly summary's totals by category, under `sums` as they have always
// been. The response used to carry the month's whole transaction list as well,
// as `movements`; nothing read it, and it cost a second full query per visit.
router.get(
  "/month",
  withWallet(async (req) => ({ sums: await summary_controller.getMonthlyData(req) })),
);

router.get("/year", withWallet((req) => summary_controller.getYearlyData(req)));

module.exports = router;
