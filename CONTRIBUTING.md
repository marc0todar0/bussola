# Contributing to Bussola

Thanks for helping. Bug reports and ideas go in the issue tracker; code goes in a pull request. Back to the [README](README.md).

## Running it in development

The database runs in Docker; the API and the frontend run locally with hot reload (Node 22 or newer). Vite forwards `/api` to the local API, so the browser still talks to a single origin. In `.env`, uncomment `PGHOST=localhost` and `PGPORT=5432`, then:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
cd api && yarn install && yarn dev        # terminal 1: API on :3001
cd frontend && yarn install && yarn dev   # terminal 2: Vite on :5173
```

## Checks a pull request must pass

CI runs all of these; run them yourself first.

- `yarn lint` in `api/` and in `frontend/`, and `yarn test:quotes`, `yarn test:ai` and `yarn test:notify` in `api/`, plus `node test/service.js` in `quotes/`.
- The API tests, against a throwaway stack on port 3100 (its own containers and volume, never your real data):

  ```bash
  docker compose -p bussola-test -f docker-compose.yml -f docker-compose.test.yml up -d --build --wait
  node frontend/scripts/demo-check.mjs compare
  BASE_URL=http://localhost:3100 node api/test/isolation.js
  BASE_URL=http://localhost:3100 ADMIN_USER=bussola ADMIN_PASS=test-admin-pass node api/test/security.js
  docker compose -p bussola-test -f docker-compose.yml -f docker-compose.test.yml down -v
  ```

  Run them in this order, on a fresh stack: `security.js` sends dozens of
  invalid tokens from one address on purpose, so `isolation.js` run after it
  would be throttled. `DELETE FROM throttle_hits` on the test instance starts
  the counts over.

## Ground rules

- One change per pull request.
- Code, comments and commit messages in English; only the interface is translated (`frontend/src/i18n/`).
- The schema changes only by adding a file to `api/migrations/`; never edit a released one.
- The demo in `frontend/src/demo/` is a second implementation of the API — if you change what an endpoint answers, change it there too.
