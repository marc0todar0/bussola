# How well a model reads bank notifications

`run.js` scores a model on `samples.json`: 40 bank notifications, as they
really look, from Revolut, Fineco, N26, Nexo and OKX, in Italian, English and
German, each with the transaction it should become. It asks the model exactly
what the API asks, using the prompt and JSON schema from
[`api/services/inbox/extract.js`](../../api/services/inbox/extract.js): the
wallet's accounts and categories as enums, the user's own names, and
optionally one line of history per payment.

```sh
node tools/ai-eval/run.js --history     # as the API asks, when there is history
node tools/ai-eval/run.js               # no history at all
BUSSOLA_AI_MODEL=qwen3.5:2b node tools/ai-eval/run.js --history
```

It needs only Node and an OpenAI-compatible endpoint (an Ollama with the model
pulled, for instance). Environment variables: `BUSSOLA_AI_URL` (default
`http://127.0.0.1:11434/v1`), `BUSSOLA_AI_MODEL` (default `qwen3.5:4b`),
`BUSSOLA_AI_API_KEY` (if the endpoint wants one), and `BANK_NAMES` (default `Marco Todaro, TODARO MARCO`;
set it empty to leave the names out).

What is scored: the amount; the type (expense, income or transfer); the
account; the merchant, when the notification names one; the category, for
expenses and incomes; and for transfers, the other account and the direction
(which account the money left and which it reached, checked on the draft the
API would store).

## Results

`qwen3.5:4b` (Q4_K_M) on a CPU, Ollama 0.32 through its own API, `think: false`, `temperature: 0`:

| Field | Score |
|---|---|
| amount | 40/40 (100%) |
| type | 39/40 (97.5%) |
| account | 40/40 (100%) |
| merchant | 30/30 (100%) |
| category | 33/33 (100%) |
| other account (transfers) | 7/7 (100%) |
| direction (transfers) | 6/7 (86%) |
| time per notification | median 13 s, max 15.5 s |

With history and bank names. The one miss: *"Deposit successful: 500.00 EUR
has been credited to your account via SEPA from Revolut"* (OKX) read as an
income rather than a transfer from Revolut, so the draft had no transfer
direction either.

An earlier run of the same model, before the prompt gained the direction
field and the user's names, got 100% for amount, merchant and accounts, 97%
for the category and 92.5% for the type. All three type misses were transfers
where only the user's own name appeared, which is why the prompt now names
them (Profile → *Your name as your banks write it*).
