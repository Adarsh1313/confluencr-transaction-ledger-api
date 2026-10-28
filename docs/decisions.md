# Decision log

Plain-language record of every engineering decision, the options considered and why. Source material for the interview-prep artifact.

| # | Decision | Chosen | Alternatives | Why (one line) |
|---|----------|--------|--------------|----------------|
| Q1 | Framework | Fastify + TypeScript + Zod | Express, Python FastAPI | One schema per route gives validation, types and Swagger docs; speed gain is real but small next to DB round-trip time. |
| Q2 | Database | Postgres (Supabase) | MongoDB, SQLite | Real constraints, row locks and all-or-nothing writes; same DB as Round 2. |
| Q3 | DB access | Plain SQL via `pg` + `.sql` migrations | Prisma/Drizzle (ORM), Kysely (query builder) | Every query and lock is visible and explainable line by line. |
| Q4 | Money | Integers in paise (`15050` = ₹150.50) | Decimal rupees (NUMERIC), floats | Integer maths never drifts; floats give 0.1+0.2=0.30000000000000004. |
| Q5 | Currency | INR only, no currency field | Multi-currency | Multi-currency needs FX rates and mixing rules; out of scope. |
| Q6 | IDs | Prefixed IDs: `acc_…`, `txn_…` | UUIDs, auto-increment | Readable at a glance in logs, support tickets and URLs. See note below. |
| Q7 | Auth | None (out of scope) | API keys, JWT login | Not in the brief; in production every route sits behind auth. |
| Q8 | API style | REST, nested, versioned `/api/v1` | GraphQL, RPC, gRPC | Resources map cleanly to URLs; `v1` lets us change later without breaking clients. |
| Q10 | Concurrent debits | Lock the account row (`SELECT … FOR UPDATE`) + `CHECK (balance >= 0)` | Conditional UPDATE, SERIALIZABLE + retries | "One teller per account": second request waits, then sees the new balance. DB rule is the safety net. |
| Q11 | Duplicate reference_id | `409 Conflict` with the original transaction in the body | `200` silent replay | Brief asks to indicate it already exists; client can see the original. |
| Q12a | Rejected transactions | Separate `transaction_attempts` audit table; ledger holds only money that moved | `status` column on transactions | Bank model: statement vs internal log. Balance safety is structural, not a filter. |
| Q12b | What gets logged | Business rejections only (insufficient balance, incl. transfers) | Also log 400s | Malformed requests aren't money attempts; logging them floods the audit trail. |
| Q12c | Retrying a failed reference_id | Allowed; only a successful transaction claims a reference_id | Burn the reference | Matches user intent: the payment never happened. |
| Q12d | Exposing attempts | `GET /api/v1/accounts/:id/attempts`; API keeps exact codes; "Failed" is a frontend label; email/SMS is future | | Lets the Round 2 UI show failed items like UPI apps. |
| Q13 | Balance storage | Stored `balance` column, updated in the same database transaction | Sum on every read | Instant reads; a test proves stored balance = sum of transactions. |
| Q14 | Immutability | No edit/delete routes + Postgres trigger blocking UPDATE/DELETE | Routes only | Enforced by the database, not just by convention. |
| Q15 | Transfers | `transfers` row + debit on A + credit on B, one database transaction, locks taken in ID order, own reference_id | | No partial transfers, no deadlocks, no double-moves on retry. |
| Q16 | Pagination | page (default 1) / limit (default 20, max 100); bad values → 400; past end → empty list | Cursor pagination | Brief asks for page/limit; cursor wins only at very large scale. |
| Q17 | Errors | `{ error: { code, message, details } }`; 400/404/409/422/500 | | `code` for programs, `message` for people. |
| Q18 | Tests | Integration tests on real Postgres (`ledger_test` schema), incl. 20-parallel-debit concurrency test, Vitest | Unit tests with fake DB | Only a real DB can prove locks and constraints work. |
| Q19 | Limits | name 1–100 (trimmed); description optional ≤255; reference_id 1–100; amount integer 1–10¹² paise | | Keeps amounts inside JS's exact-integer range. |
| Q20 | Hosting region | Supabase in Mumbai (ap-south-1) | US/EU regions | DB distance dominates latency for Indian users. |
| B1 | Running balance | Each transaction stores `balance_after` | Compute on read | Made during build: history reads like a bank statement at no cost. |
| B2 | Table location | Dedicated `ledger` schema, not Supabase `public` | `public` | Made during build: Supabase exposes `public` through an auto-generated REST API; a private schema keeps the ledger reachable only via our API. |
| B3 | created_at | `clock_timestamp()` (time of the insert) | `now()` (time the database transaction started) | Made during build: a request that waited for a lock gets the time it actually wrote, so newest-first stays truthful. |
| Q9 | Terms | "Transaction" = ledger entry; "database transaction" = all-or-nothing wrapper | | Avoids the most common confusion in ledger interviews. |

## Notes

**Q6: why prefixed IDs (the Stripe pattern).** Stripe uses `cus_…`, `ch_…`, `pi_…` so anyone reading an ID (a developer in logs, a support agent, a customer pasting it) knows instantly what kind of object it is, and passing an account ID where a transaction ID is expected is obvious and can be rejected. We keep the random part (not 1, 2, 3) so IDs stay unguessable and don't reveal how many accounts exist.

**Q8: other API styles** (for the artifact). GraphQL: one endpoint, the client asks for exactly the fields it wants; great for complex UIs, overkill here. RPC-style (`POST /createAccount`): simple, but URLs don't describe resources. gRPC: binary and very fast between internal services, not browser-friendly.

**Q12: how banks do it.** UPI apps (GPay, PhonePe) show a failed payment in history with a "Failed" badge and a plain reason; the official account statement lists only money that actually moved; internally every attempt is logged with a reason code; SMS/email alerts come from a separate notification system.

## Assumptions

- **INR only.** All amounts are integers in paise; there is no currency field. Walnut Folks Group is India-based (Bengaluru/Mumbai), but Confluencr runs campaigns across 15+ countries and Intent Farm has served overseas clients (e.g. Scalapay), so multi-currency is a likely future need. Adding it later means a `currency` column on accounts, rejecting transfers across currencies (or adding FX conversion), and per-currency minor units (e.g. JPY has none).
- **No authentication.** In production every route sits behind auth and accounts belong to a user.
- **Rejected attempts are not transactions.** They live in an audit log and never appear in transaction history or affect balance.
- **Description is optional.** The brief lists it as a field but not as a required validation.
