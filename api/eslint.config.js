// ESLint for the API: CommonJS on Node, the recommended rules and little else.
// The point is to catch what a missing test suite would — an undefined name, a
// variable nobody reads, an unreachable branch — not to impose a style.
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules", "api"] },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      // `_`-prefixed arguments are the ones Express's signature forces on us
      // (`(err, req, res, _next)`), and a caught error is often deliberately
      // ignored.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
];
