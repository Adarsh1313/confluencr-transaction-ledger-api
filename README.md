# Transaction Ledger API

A backend for a money ledger: create accounts, post credits and debits, read balances, page through transaction history, and transfer money between accounts. The balance stays correct even when requests arrive at the same moment, are retried, or fail halfway.

**Stack:** Node.js + TypeScript, Fastify, Zod, PostgreSQL, Vitest.

## Run it locally

Needs **Node.js 18+** and **Docker** (for the database).

```bash
git clone https://github.com/Adarsh1313/confluencr-transaction-ledger-api.git
cd confluencr-transaction-ledger-api
docker compose up -d
npm install
cp .env.example .env
npm run dev
```

The API runs at `http://localhost:3020` and creates its tables on first start. Open **http://localhost:3020/docs** to try every endpoint in the browser.

No Docker? Put any Postgres connection string in `.env` as `DATABASE_URL` and skip `docker compose up -d`.

## Check it against the brief

With the server running, in a second terminal:

```bash
npm run verify
```

This walks through every section of the assessment (create account, transactions, duplicates, balance, history with filtering, pagination and sorting, data integrity, validations, error handling, transfers) against the live API and prints a pass or fail for each check.

## Tests

```bash
npm test
```

84 automated tests run against a real Postgres, in a separate `ledger_test` schema that is rebuilt on every run, so they never touch app data. They call the API exactly as a client would. There is one test per rule in the brief, plus concurrency tests: 20 simultaneous debits, a retry storm, opposite transfers, and a transfer that fails halfway and rolls back.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/v1/accounts` | Create an account (balance starts at 0) |
| `GET` | `/api/v1/accounts/:id/balance` | Current balance |
| `POST` | `/api/v1/accounts/:id/transactions` | Credit or debit |
| `GET` | `/api/v1/accounts/:id/transactions` | History: `?type=credit\|debit&page=&limit=` |
| `GET` | `/api/v1/accounts/:id/attempts` | Rejected debits (audit log) |
| `POST` | `/api/v1/transfers` | Move money between two accounts (bonus) |
| `GET` | `/api/v1/transfers/:id` | One transfer |

Full request and response examples, and every error code: **[docs/API.md](docs/API.md)**. All amounts are integers in paise: `15050` = ₹150.50.

## How correctness is guaranteed

| Requirement | How |
|---|---|
| A debit never overdraws | The account row is locked (`SELECT … FOR UPDATE`) for the whole operation, so concurrent requests on one account queue up. `CHECK (balance >= 0)` is the safety net. |
| Atomicity | The transaction row and the balance update are written in one database transaction: both commit or neither does. |
| Duplicate `reference_id` | Checked under the lock, backed by `UNIQUE (account_id, reference_id)`. Returns `409` with the original. |
| Immutability | No edit or delete endpoints, **and** a Postgres trigger rejects any `UPDATE`/`DELETE` on `transactions`. |
| Balance consistency | The balance is updated in the same database transaction as each Transaction. Tests recompute it from the ledger after concurrent bursts. |
| Transfers | Transfer row + debit + credit in one database transaction, accounts locked in sorted order so opposite transfers can't deadlock. |
| Validation and errors | Every request is checked against a Zod schema. Every error has one shape: `{ "error": { "code", "message", "details" } }`. |

## Project structure

```
migrations/          SQL: tables, constraints, indexes, immutability trigger
scripts/verify.ts    brief-by-brief check against a running server
src/
  server.ts          starts the server (applies migrations first)
  app.ts             builds the app; shared by the server and the tests
  config.ts          environment variables
  db.ts              connection pool + "run inside a database transaction" helper
  migrate.ts         applies pending migrations
  errors.ts          error types and the single error response shape
  schemas.ts         shared validation rules (amount, pagination, errors)
  ids.ts             prefixed IDs
  modules/           one file per resource: its routes, validation and SQL
    accounts.ts      create account, balance, row locking
    transactions.ts  credit, debit, history
    attempts.ts      audit log of rejected debits
    transfers.ts     atomic transfers
test/                API-level tests against a real database
```

## Assumptions

Amounts are integers in paise, INR only, and there is no authentication. `reference_id` is unique per account, and a duplicate returns `409` with the original. Rejected debits never touch the ledger; they are logged separately as attempts.

Full list: **[ASSUMPTIONS.md](ASSUMPTIONS.md)**. Design decisions and trade-offs: [docs/decisions.md](docs/decisions.md).

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | (required) | Postgres connection string |
| `PORT` | `3020` | HTTP port |
| `DB_SCHEMA` | `ledger` | Postgres schema the tables live in |
| `LOG_LEVEL` | `info` | `silent`, `info`, `debug`, … |
