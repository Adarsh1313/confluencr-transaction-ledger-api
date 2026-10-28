# Decision log

Plain-language record of every engineering decision, the options considered and why. Source material for the interview-prep artifact.

| # | Decision | Chosen | Alternatives | Why (one line) |
|---|----------|--------|--------------|----------------|
| Q2 | Database | Postgres (Supabase) | MongoDB, SQLite | Real constraints, row locks and all-or-nothing writes; same DB as Round 2. |
| Q3 | DB access | Plain SQL via `pg` + `.sql` migrations | Prisma/Drizzle (ORM), Kysely (query builder) | Every query and lock is visible and explainable line by line. |
| Q4 | Money | Integers in paise (`15050` = ₹150.50) | Decimal rupees (NUMERIC), floats | Integer maths never drifts; floats give 0.1+0.2=0.30000000000000004. |
| Q5 | Currency | INR only, no currency field | Multi-currency | Multi-currency needs FX rates and mixing rules; out of scope. |
| Q6 | IDs | Prefixed IDs: `acc_…`, `txn_…` | UUIDs, auto-increment | Readable at a glance in logs, support tickets and URLs. See note below. |
| Q7 | Auth | None (out of scope) | API keys, JWT login | Not in the brief; in production every route sits behind auth. |
| Q8 | API style | REST, nested, versioned `/api/v1` | GraphQL, RPC, gRPC | Resources map cleanly to URLs; `v1` lets us change later without breaking clients. |
| Q9 | Terms | "Transaction" = ledger entry; "database transaction" = all-or-nothing wrapper | | Avoids the most common confusion in ledger interviews. |

## Notes

**Q6: why prefixed IDs (the Stripe pattern).** Stripe uses `cus_…`, `ch_…`, `pi_…` so anyone reading an ID (a developer in logs, a support agent, a customer pasting it) knows instantly what kind of object it is, and passing an account ID where a transaction ID is expected is obvious and can be rejected. We keep the random part (not 1, 2, 3) so IDs stay unguessable and don't reveal how many accounts exist.

**Q8: other API styles** (for the artifact). GraphQL: one endpoint, the client asks for exactly the fields it wants; great for complex UIs, overkill here. RPC-style (`POST /createAccount`): simple, but URLs don't describe resources. gRPC: binary and very fast between internal services, not browser-friendly.
