# The reading model

[← Bank notifications](notifications.md)

## What it does

For each notification, the model gets the text, the app name, your account and category names, up to 5 similar past transactions, and [your name as your banks write it](notifications.md#optional).

1. It decides **whether it is a movement at all**. Offers, codes, statements and alerts are dropped and their text deleted. When in doubt, it keeps it.
2. It fills in the amount, day, merchant, type, account and category. It can **only pick your own names**.
3. Bussola checks the answer. The amount must be positive with at most 2 decimals, the day can't be in the future, and every name must exist in the wallet.

Accuracy: `qwen3.5:4b` read 40 real notifications with the right amount, merchant, accounts and category every time, and the right type 39 times ([`tools/ai-eval/`](../tools/ai-eval/)).

## Local model

- Any OpenAI-compatible server: Ollama, llama.cpp, LM Studio, vLLM.
- Run `ollama pull qwen3.5:4b` first. From Bussola's containers, the host is `http://host.docker.internal:11434/v1`.
- `qwen3.5:4b` needs 4–5 GB of RAM and takes 10–15 s per notification on a desktop CPU. `qwen3.5:2b` is lighter.
- Avoid "thinking" models: they are slower.

## Hosted model: what leaves your machine

For each notification, Bussola sends:

- the notification text
- your account and category names
- your name variants
- up to 5 lines of past descriptions
- the date, the currency and the app name

It **never** sends balances, other transactions, credentials or your token. The text is never written to Bussola's logs.

⚠️ Many free tiers **train on your prompts**. Bank notifications are financial data, so check the terms.

**Example: Groq** (free, supports JSON schema; turn on *Zero Data Retention* in Data Controls):

```bash
BUSSOLA_AI_URL=https://api.groq.com/openai/v1
BUSSOLA_AI_MODEL=openai/gpt-oss-20b
BUSSOLA_AI_API_KEY=gsk_...
```

The 8,000 tokens a minute cover 3–4 notifications a minute. Extra ones are retried a minute later.

| Provider | Free-tier data use |
|---|---|
| Google Gemini | Outside the EEA, CH and UK: **used for training**. Don't use it there. |
| Mistral (Experiment) | Training unless you opt out |
| OpenRouter `:free` | Depends on the model's provider |
| Cloudflare Workers AI | No training (JSON schema support not verified) |

Use `https://` addresses: the key goes to whatever `BUSSOLA_AI_URL` says.

## When a reading fails

- **Temporary failures** (429, 5xx, timeout, server down) are retried after 1 min, 5 min, 30 min and 2 h. The item shows *Reading…* meanwhile.
- **Permanent failures** (401/403, 404, invalid answer) aren't retried.
- After the last try, the item waits in the inbox with its text for you to fill in, and your phone is notified.
