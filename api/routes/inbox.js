// The inbox (controllers/inbox_controller.js), in two halves that never share
// a route:
//
//   tokenRouter    POST /api/inbox, GET /api/inbox/context -- a personal
//                  token (auth/tokens.js), nothing else. Mounted in index.js
//                  ahead of the session-only /api tree, and the only place a
//                  token is accepted at all.
//   sessionRouter  GET /api/inbox, POST /api/inbox/:id/accept|dismiss -- the
//                  session cookie, like every other endpoint. Mounted in
//                  routes/index.js.
const express = require("express");
const { withToken } = require("../auth/tokens");
const { withWallet, withWalletWrite } = require("../auth/middleware");
const inbox = require("../controllers/inbox_controller");

// An automation app on a phone builds its JSON by pasting the notification's
// text between quotes, without escaping it: a quotation mark or a line break
// in a bank's message makes the body invalid, and the notification is lost.
// So the text can also come as it is, as a text/plain body, with the app's name
// in ?source= (or an X-Bussola-Source header): nothing to escape. JSON stays
// as it was, and a draft can only be sent as JSON.
const plainText = express.text({ type: "text/plain", limit: "16kb" });
const fromPlainText = (req, res, next) => {
  if (typeof req.body === "string") {
    const asked = req.query.source ?? req.get("x-bussola-source");
    req.body = { text: req.body, source: typeof asked === "string" ? asked : undefined };
  }
  next();
};

const tokenRouter = express.Router();
tokenRouter.post("/", plainText, fromPlainText, withToken((req, res) => inbox.createItem(req, res)));
tokenRouter.get("/context", withToken((req) => inbox.getContext(req)));

const sessionRouter = express.Router();
sessionRouter.get("/", withWallet(() => inbox.getPending()));
sessionRouter.post("/:id/accept", withWalletWrite((req) => inbox.accept(req)));
sessionRouter.post("/:id/dismiss", withWalletWrite((req) => inbox.dismiss(req)));

module.exports = { tokenRouter, sessionRouter };
