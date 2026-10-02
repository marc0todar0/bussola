const router = require("express").Router();
const { withWallet, withWalletWrite } = require("../auth/middleware");
const transactions_controller = require("../controllers/transactions_controller");

// withWallet opens the transaction with app.user_id and app.wallet_id set,
// serialises the result and handles errors: what used to be a dozen lines per
// endpoint. It is not only brevity -- it is that no route exists that skips
// isolation. withWalletWrite is the same thing for the endpoints that write,
// and it is what a read-only member is turned away by.
router.get("/", withWallet((req) => transactions_controller.getTransactions(req)));
router.get("/form-data", withWallet((req) => transactions_controller.getNewTransactionData(req)));
router.post("/", withWalletWrite((req) => transactions_controller.createTransaction(req)));
router.post("/:id", withWalletWrite((req) => transactions_controller.updateTransaction(req)));
router.delete("/:id", withWalletWrite((req) => transactions_controller.deleteTransaction(req.params.id)));

module.exports = router;
