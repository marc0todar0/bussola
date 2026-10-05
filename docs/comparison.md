# Comparison

[← README](../README.md)

| | **Bussola** | Firefly III | Actual Budget | Ghostfolio | Sure |
|---|:---:|:---:|:---:|:---:|:---:|
| Self-hosted, open source | ✅ MIT | ✅ AGPL-3.0 | ✅ MIT | ✅ AGPL-3.0 | ✅ AGPL-3.0 |
| Sharing with read / read-write | ✅ per wallet | ❌ | Partial (needs OpenID) | Partial (view-only) | ✅ per account |
| Spending: transactions, categories | ✅ | ✅ | ✅ | ❌ | ✅ |
| Investments with automatic prices | ✅ optional | ❌ | ❌ | ✅ | ✅ |
| Budgets | ❌ | ✅ | ✅ envelope | ❌ | ✅ |
| Transaction rules | ❌ | ✅ | ✅ | ❌ | ✅ |
| Bank sync (open banking) | ❌ by design | ✅ | ✅ | ❌ | ✅ |
| Bank CSV import | ✅ | ✅ | ✅ | Partial | ✅ |
| Transactions from phone notifications | ✅ | ❌ | ❌ | ❌ | ❌ |
| Passkeys | ✅ | ❌ | ❌ | ✅ | ✅ |
| On a phone | ✅ PWA + push | Community apps | ✅ PWA | ✅ PWA | ✅ PWA + app |
| Interface languages | 6 | Many | Many | Many | Many |

<sub>As of October 2026, from each project's docs. ❌ = we found no such feature. Bussola is not affiliated with any of them. Spotted a mistake? [Open an issue](https://github.com/marc0todar0/bussola/issues).</sub>

**In short:** for budgets, rules and bank sync use Firefly III or Actual. For investments only, use Ghostfolio. For an all-in-one with bank sync, use Sure. Bussola is for keeping many accounts, your spending and your wealth together, without giving a bank login to anyone.

## Not for you if…

- **You have one bank account and no cash.** Your bank's app is enough.
- **You want automatic bank sync.** Bussola never holds a bank login. Transactions come from notifications or CSV files, and you confirm each one.
- **You budget with envelopes.** Bussola has no budgets, rules or recurring transactions.
- **You trade actively.** A holding has one purchase price: there is no trade history and no dividend tracking.
- **You run a business.** It has no invoicing and no double-entry accounting.
- **You can't run Docker.** There is no hosted version.
