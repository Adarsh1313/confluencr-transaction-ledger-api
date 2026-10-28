# Transaction Ledger API

A backend for a simple money ledger: create accounts, post credits and debits, read balances, page through transaction history, and transfer money between accounts. It is built so the balance is always correct, even when requests arrive at the same moment, are retried, or fail halfway.

**Stack:** Node.js + TypeScript, Fastify, Zod, PostgreSQL (plain SQL via `pg`), Vitest.

- [API reference](docs/API.md), plus interactive Swagger docs at `/docs` once running
- [Decision log](docs/decisions.md): every design choice, the alternatives and why
- [Glossary](GLOSSARY.md): the domain terms used in code and docs

## Run it locally

Requirements: Node.js 18+ and a PostgreSQL database (any of the options below).

```bash
git clone https://github.com/Adarsh1313/confluencr-transaction-ledger-api.git
cd confluencr-transaction-ledger-api
npm install
cp .env.example .env        # then set DATABASE_URL (see below)
npm run migrate             # creates the tables
npm run dev                 # http://localhost:3020, docs at http://localhost:3020/docs
```

**Choose a database for `DATABASE_URL`:**

| Option | `DATABASE_URL` |
|---|---|
| Docker (`docker compose up -d`) | `postgresql://postgres:postgres@localhost:5432/ledger` |
| Your own Postgres | `postgresql://USER:PASSWORD@HOST:5432/DBNAME` |
| Supabase (free) | Project → Connect → **Session pooler** connection string |

Tables are created in a dedicated `ledger` schema (override with `DB_SCHEMA`). Other settings: `PORT` (default 3020), `LOG_LEVEL` (default `info`).

### Tests

```bash
npm test
```

The tests run against a real Postgres, in a separate `ledger_test` schema that is wiped on every run, so they never touch app data. They call the API exactly as a client would. There is one test per rule in the brief, plus concurrency tests (20 simultaneous debits, a retry storm, opposite transfers).

Other scripts: `npm run typecheck`, `npm run build && npm start` (production build).

## How correctness is guaranteed

| Requirement | How |
|---|---|
| Debit never overdraws | The account row is locked (`SELECT … FOR UPDATE`) for the whole operation, so concurrent requests on one account queue up. A `CHECK (balance >= 0)` constraint is the safety net. |
| Atomicity | Writing the transaction and updating the balance happen inside one database transaction: both commit or neither does. |
| Duplicate `reference_id` | Checked under the lock and backed by `UNIQUE (account_id, reference_id)`. Returns `409` with the original. |
| Immutability | No edit or delete endpoints, **and** a Postgres trigger rejects any `UPDATE`/`DELETE` on `transactions`, even from a direct database connection. |
| Balance consistency | The stored balance is updated in the same database transaction as each entry. Tests recompute the balance from the ledger after concurrent bursts and compare. |
| Transfers | Transfer row + debit + credit in one database transaction. Both accounts are locked in sorted ID order so opposite transfers can't deadlock. |
| Rejected debits | Never touch the ledger. Logged separately in an audit table (`/attempts`), like a bank's internal log versus its official statement. |
| Money precision | Integers in paise, never floating point. |

## Project structure

```
migrations/          versioned SQL: tables, constraints, indexes, immutability trigger
src/
  app.ts             builds the Fastify app (shared by server and tests)
  server.ts          starts the HTTP server
  migrate.ts         applies pending migrations
  config.ts          environment variables
  db.ts              connection pool + "run inside a database transaction" helper
  errors.ts          error types and the single error response shape
  ids.ts             prefixed IDs (acc_, txn_, trf_, att_)
  schemas.ts         shared Zod schemas (amount, pagination, errors)
  modules/
    accounts.ts      create account, get balance, row locking
    transactions.ts  credit/debit, history
    attempts.ts      audit log of rejected money movements
    transfers.ts     atomic transfers
test/                API-level tests against a real database
```

## Assumptions

- **Amounts are integers in paise** (100 paise = ₹1). Integers avoid floating-point rounding errors. The brief's examples (100, 50, 30) work as written.
- **INR only, no currency field.** Walnut Folks Group is India-based, but Confluencr runs campaigns in 15+ countries, so multi-currency is a likely next step. It would mean a `currency` column on accounts, rejecting or converting cross-currency transfers, and per-currency minor units.
- **No authentication.** The brief doesn't mention users. In production every route would sit behind auth, and accounts would belong to users.
- **`description` is optional.** The brief lists it as a field but not as a required validation. Max 255 characters.
- **`reference_id` is scoped per account.** The same reference can be used on different accounts. Only a *successful* transaction claims a reference, so a debit rejected for insufficient balance can be retried with the same `reference_id`.
- **A duplicate `reference_id` returns `409`** with the original transaction, even if the new amount differs, so the client can see what was actually recorded.
- **Rejected debits are not transactions.** They are stored as *attempts* for auditing, never in history, and never affect the balance. Malformed requests (`400`) are not logged.
- **Transfers** are recorded as one transfer plus a debit and a credit, each tagged with `transfer_id`. Their internal reference is `transfer:<transfer id>`, so client `reference_id`s may not start with `transfer:`. A transfer's own `reference_id` is unique per source account.
- **Limits:** name 1–100 chars, `reference_id` 1–100 chars, amount 1 to 10¹² paise (₹1,000 crore), `limit` max 100 per page.
- **Ordering:** newest first by `created_at`, ties broken by `id` so pages never shuffle.
- **Every transaction stores `balance_after`** (the running balance, like a bank statement). It's not required by the brief, but it makes history self-explanatory.

## Possible next steps

Authentication and account ownership · multi-currency · email/SMS alerts on failed attempts · reversals as compensating transactions · cursor pagination for very long histories · rate limiting.
