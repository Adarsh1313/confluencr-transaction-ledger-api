# API reference

Base URL: `http://localhost:3020/api/v1`. Interactive docs (generated from the same schemas that validate requests): `http://localhost:3020/docs`.

- All amounts are **integers in paise** (`15050` = ₹150.50). INR only.
- Request bodies are JSON. Unknown fields are rejected.
- IDs are prefixed by type: `acc_…` account, `txn_…` transaction, `trf_…` transfer, `att_…` attempt.

## Errors

Every error has the same shape:

```json
{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "Balance 100 is less than debit 150", "details": { "account_id": "acc_…", "balance": 100, "amount": 150 } } }
```

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing/invalid field, unknown field, amount ≤ 0 or not an integer, invalid type |
| 400 | `INVALID_PAGINATION` | `page` or `limit` not a positive integer, or `limit` > 100 |
| 400 | `INVALID_REQUEST_BODY` | Malformed or empty JSON |
| 404 | `ACCOUNT_NOT_FOUND` | Account ID does not exist |
| 404 | `TRANSFER_NOT_FOUND` | Transfer ID does not exist |
| 404 | `ROUTE_NOT_FOUND` | No such endpoint (including any attempt to edit or delete a transaction) |
| 409 | `DUPLICATE_TRANSACTION` | `reference_id` already used on this account. `details.transaction` is the original |
| 409 | `DUPLICATE_TRANSFER` | `reference_id` already used for a transfer from this account. `details.transfer` is the original |
| 422 | `INSUFFICIENT_BALANCE` | Debit or transfer larger than the balance. Recorded as an attempt |
| 422 | `SAME_ACCOUNT_TRANSFER` | Source and destination are the same |
| 422 | `BALANCE_LIMIT_EXCEEDED` | A credit (or the credit half of a transfer) would push the balance above 9,007,199,254,740,991 paise. Everything rolls back |
| 500 | `INTERNAL_ERROR` | Unexpected error (no internals leaked) |

---

## Create account

`POST /accounts`

```bash
curl -X POST http://localhost:3020/api/v1/accounts \
  -H 'content-type: application/json' \
  -d '{"name": "Asha Rao"}'
```

`201 Created`
```json
{ "id": "acc_ljR21khQ7j3jWLLPmo8C", "name": "Asha Rao", "balance": 0, "created_at": "2026-10-28T10:06:50.106Z" }
```

`name` is required, trimmed, 1–100 characters. Sending `balance` (or any other field) returns `400`.

## Get balance

`GET /accounts/:id/balance`

```bash
curl http://localhost:3020/api/v1/accounts/acc_ljR21khQ7j3jWLLPmo8C/balance
```

`200 OK`
```json
{ "account_id": "acc_ljR21khQ7j3jWLLPmo8C", "balance": 15050 }
```

## Add transaction (credit or debit)

`POST /accounts/:id/transactions`

| Field | Type | Rules |
|---|---|---|
| `type` | `"credit"` \| `"debit"` | required |
| `amount` | integer (paise) | required, 1 to 1,000,000,000,000 |
| `reference_id` | string | required, 1–100 chars, unique per account, must not start with `transfer:` |
| `description` | string | optional, ≤ 255 chars |

```bash
curl -X POST http://localhost:3020/api/v1/accounts/acc_ljR21khQ7j3jWLLPmo8C/transactions \
  -H 'content-type: application/json' \
  -d '{"type": "credit", "amount": 15050, "reference_id": "salary-oct", "description": "October salary"}'
```

`201 Created`
```json
{
  "id": "txn_zrkjdLsdO4oVCeMdKb1y",
  "account_id": "acc_ljR21khQ7j3jWLLPmo8C",
  "type": "credit",
  "amount": 15050,
  "description": "October salary",
  "reference_id": "salary-oct",
  "balance_after": 15050,
  "transfer_id": null,
  "created_at": "2026-10-28T10:06:50.781Z"
}
```

- `balance_after` is the account balance right after this transaction (a running balance, like a bank statement).
- Re-sending the same `reference_id` returns `409 DUPLICATE_TRANSACTION` with the original transaction; nothing changes.
- A debit larger than the balance returns `422 INSUFFICIENT_BALANCE`; the balance is unchanged and the attempt is logged. The same `reference_id` can be retried later.

## Transaction history

`GET /accounts/:id/transactions?type=&page=&limit=`

| Query | Default | Rules |
|---|---|---|
| `type` | both | `credit` or `debit` |
| `page` | 1 | integer ≥ 1 |
| `limit` | 20 | integer 1–100 |

```bash
curl 'http://localhost:3020/api/v1/accounts/acc_ljR21khQ7j3jWLLPmo8C/transactions?type=debit&page=1&limit=10'
```

`200 OK`
```json
{
  "data": [ { "id": "txn_…", "type": "debit", "amount": 3000, "balance_after": 12050, "...": "..." } ],
  "pagination": { "page": 1, "limit": 10, "total_records": 1, "total_pages": 1 }
}
```

Sorted newest first by `created_at`, ties broken by `id`. A page past the end returns `data: []` with correct totals.

## Attempts (rejected money movements)

`GET /accounts/:id/attempts?page=&limit=`

The audit log of debits and transfers the ledger refused. Attempts never affect the balance and never appear in transaction history.

```json
{
  "data": [
    {
      "id": "att_…", "account_id": "acc_…", "type": "debit", "amount": 15000,
      "description": null, "reference_id": "rent-nov", "reason_code": "INSUFFICIENT_BALANCE",
      "balance_at_attempt": 10000, "transfer_to_account_id": null, "created_at": "…"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total_records": 1, "total_pages": 1 }
}
```

## Transfer (bonus)

`POST /transfers`

| Field | Rules |
|---|---|
| `from_account_id`, `to_account_id` | required, must exist, must differ |
| `amount` | integer paise, 1 to 1,000,000,000,000 |
| `reference_id` | required, unique per source account |
| `description` | optional, ≤ 255 chars |

```bash
curl -X POST http://localhost:3020/api/v1/transfers \
  -H 'content-type: application/json' \
  -d '{"from_account_id": "acc_A…", "to_account_id": "acc_B…", "amount": 3000, "reference_id": "split-dinner"}'
```

`201 Created`
```json
{
  "id": "trf_…",
  "from_account_id": "acc_A…",
  "to_account_id": "acc_B…",
  "amount": 3000,
  "description": null,
  "reference_id": "split-dinner",
  "debit_transaction_id": "txn_…",
  "credit_transaction_id": "txn_…",
  "created_at": "…"
}
```

The transfer row, the debit on the source and the credit on the destination are written in one database transaction: all or nothing. Both halves appear in each account's history with `transfer_id` set.

`GET /transfers/:id` returns the same object.

## Health

`GET /health` → `200 {"status":"ok"}` when the database answers.
