# Transaction Ledger API

Create accounts, record credits and debits, read balances and history, and move money between accounts. Balances are always exact: two requests can never spend the same money, retries never double-charge, and recorded transactions can never be changed.

> **Prefer to click around?** Run the server (`npm run dev`) and open **http://localhost:3020/docs** for the interactive reference: every endpoint, with examples and a *Test Request* button.

**Contents:** [Quick start](#quick-start) · [Concepts](#concepts) · [Accounts](#accounts) · [Transactions](#transactions) · [Transfers](#transfers) · [Attempts](#attempts) · [Errors](#errors)

## Quick start

Base URL: `http://localhost:3020/api/v1`

**1. Create an account.** It starts with a balance of 0.

```bash
curl -X POST http://localhost:3020/api/v1/accounts \
  -H 'content-type: application/json' \
  -d '{"name": "Asha Rao"}'
```

```json
{ "id": "acc_4fK2pQ9xTb1LmZ7cR3sV", "name": "Asha Rao", "balance": 0, "created_at": "2026-10-28T10:06:50.106Z" }
```

**2. Credit it ₹150.50.** Amounts are in paise, so that is `15050`.

```bash
curl -X POST http://localhost:3020/api/v1/accounts/acc_4fK2pQ9xTb1LmZ7cR3sV/transactions \
  -H 'content-type: application/json' \
  -d '{"type": "credit", "amount": 15050, "reference_id": "salary-oct"}'
```

**3. Read the balance.**

```bash
curl http://localhost:3020/api/v1/accounts/acc_4fK2pQ9xTb1LmZ7cR3sV/balance
```

```json
{ "account_id": "acc_4fK2pQ9xTb1LmZ7cR3sV", "balance": 15050 }
```

## Concepts

### Amounts are in paise

Every amount is a whole number in paise: `100` is ₹1 and `15050` is ₹150.50. Whole numbers avoid the rounding errors of decimals. INR is the only currency. One transaction moves between 1 and 1,000,000,000,000 paise.

### Safe retries with `reference_id`

Every transaction carries a `reference_id` that you choose, such as an order or invoice number. If a request times out, send it again with the same `reference_id`. The ledger records it once and answers the repeat with `409 DUPLICATE_TRANSACTION` and the original transaction. Reference IDs are unique per account, so different accounts can reuse the same one.

A debit refused for insufficient balance does not use up its `reference_id`: add money and retry with the same one.

### Transactions are permanent

There is no endpoint to edit or delete a transaction, and the database itself refuses to change one. To correct a mistake, record a new transaction.

### Rejected debits

A debit larger than the balance returns `422 INSUFFICIENT_BALANCE`, and the balance does not change. The refusal is kept in the account's [attempts](#attempts) log and never appears in transaction history.

### Pagination

List endpoints take `page` (default `1`) and `limit` (default `20`, max `100`) and return newest first:

```json
"pagination": { "page": 2, "limit": 20, "total_records": 45, "total_pages": 3 }
```

A page past the end returns an empty `data` list with the correct totals.

### IDs

IDs say what they point to: `acc_` accounts, `txn_` transactions, `trf_` transfers, `att_` attempts.

## Accounts

### Create an account

```
POST /accounts
```

Opens an account with a balance of `0`. The server sets `id` and `created_at`. Any field other than `name`, including `balance`, is rejected.

| Field | Type | |
|---|---|---|
| `name` | string | **Required.** Account holder name, 1–100 characters. |

```bash
curl -X POST http://localhost:3020/api/v1/accounts \
  -H 'content-type: application/json' \
  -d '{"name": "Asha Rao"}'
```

**`201 Created`**

```json
{
  "id": "acc_4fK2pQ9xTb1LmZ7cR3sV",
  "name": "Asha Rao",
  "balance": 0,
  "created_at": "2026-10-28T10:06:50.106Z"
}
```

Errors: `400 VALIDATION_ERROR` (name missing, blank or too long; extra fields sent).

### Get an account balance

```
GET /accounts/:id/balance
```

```bash
curl http://localhost:3020/api/v1/accounts/acc_4fK2pQ9xTb1LmZ7cR3sV/balance
```

**`200 OK`**

```json
{ "account_id": "acc_4fK2pQ9xTb1LmZ7cR3sV", "balance": 15050 }
```

Errors: `404 ACCOUNT_NOT_FOUND`.

## Transactions

### Record a credit or debit

```
POST /accounts/:id/transactions
```

A **credit** adds the amount to the balance; a **debit** subtracts it. The transaction and the new balance are saved together, or not at all. Simultaneous requests on one account are processed one at a time, so two debits can never spend the same money.

| Field | Type | |
|---|---|---|
| `type` | `"credit"` or `"debit"` | **Required.** |
| `amount` | integer | **Required.** Paise, from 1 to 1,000,000,000,000. |
| `reference_id` | string | **Required.** Your idempotency key, 1–100 characters, unique per account. Can't start with `transfer:`. |
| `description` | string | Optional note, up to 255 characters. |

```bash
curl -X POST http://localhost:3020/api/v1/accounts/acc_4fK2pQ9xTb1LmZ7cR3sV/transactions \
  -H 'content-type: application/json' \
  -d '{"type": "debit", "amount": 3000, "reference_id": "groceries-1", "description": "Groceries"}'
```

**`201 Created`**: the transaction, with the new balance in `balance_after`.

```json
{
  "id": "txn_Qm2Lr7Vx0Ny4Tz8Bc1Ks",
  "account_id": "acc_4fK2pQ9xTb1LmZ7cR3sV",
  "type": "debit",
  "amount": 3000,
  "description": "Groceries",
  "reference_id": "groceries-1",
  "balance_after": 12050,
  "transfer_id": null,
  "created_at": "2026-10-28T11:20:04.310Z"
}
```

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | A field is missing or out of range |
| 404 | `ACCOUNT_NOT_FOUND` | The account doesn't exist |
| 409 | `DUPLICATE_TRANSACTION` | `reference_id` already used on this account. `error.details.transaction` is the original. Nothing changed. |
| 422 | `INSUFFICIENT_BALANCE` | The debit is larger than the balance. Nothing changed. |
| 422 | `BALANCE_LIMIT_EXCEEDED` | The credit would push the balance over the maximum |

### List an account's transactions

```
GET /accounts/:id/transactions
```

Newest first, one page at a time. Refused debits are not included.

| Query | Default | |
|---|---|---|
| `type` | both | `credit` or `debit` |
| `page` | `1` | Whole number ≥ 1 |
| `limit` | `20` | Whole number from 1 to 100 |

```bash
curl 'http://localhost:3020/api/v1/accounts/acc_4fK2pQ9xTb1LmZ7cR3sV/transactions?type=debit&page=1&limit=10'
```

**`200 OK`**

```json
{
  "data": [
    {
      "id": "txn_Qm2Lr7Vx0Ny4Tz8Bc1Ks",
      "account_id": "acc_4fK2pQ9xTb1LmZ7cR3sV",
      "type": "debit",
      "amount": 3000,
      "description": "Groceries",
      "reference_id": "groceries-1",
      "balance_after": 12050,
      "transfer_id": null,
      "created_at": "2026-10-28T11:20:04.310Z"
    }
  ],
  "pagination": { "page": 1, "limit": 10, "total_records": 1, "total_pages": 1 }
}
```

Errors: `400 INVALID_PAGINATION`, `400 VALIDATION_ERROR` (unknown `type`), `404 ACCOUNT_NOT_FOUND`.

## Transfers

### Transfer money between accounts

```
POST /transfers
```

Moves `amount` from one account to another. The debit on the source and the credit on the destination are recorded **together or not at all**, so a half-finished transfer is impossible. Both appear in each account's history with the same `transfer_id`.

| Field | Type | |
|---|---|---|
| `from_account_id` | string | **Required.** The account to take money from. |
| `to_account_id` | string | **Required.** The account to send money to. Must be different. |
| `amount` | integer | **Required.** Paise, from 1 to 1,000,000,000,000. |
| `reference_id` | string | **Required.** Your idempotency key, unique per source account. |
| `description` | string | Optional note, up to 255 characters. |

```bash
curl -X POST http://localhost:3020/api/v1/transfers \
  -H 'content-type: application/json' \
  -d '{"from_account_id": "acc_4fK2pQ9xTb1LmZ7cR3sV", "to_account_id": "acc_9Tn6Bq2Wy8Lc4Mx1Pz7G", "amount": 3000, "reference_id": "split-dinner"}'
```

**`201 Created`**

```json
{
  "id": "trf_2Vk8Ns5Qa1Hd9Jy3Rw6E",
  "from_account_id": "acc_4fK2pQ9xTb1LmZ7cR3sV",
  "to_account_id": "acc_9Tn6Bq2Wy8Lc4Mx1Pz7G",
  "amount": 3000,
  "description": null,
  "reference_id": "split-dinner",
  "debit_transaction_id": "txn_5Gm1Xc8Rt3Vb0Lp6Qz9W",
  "credit_transaction_id": "txn_7Kd4Yh2Ns9Fq1Wm5Tc8B",
  "created_at": "2026-10-28T13:02:44.517Z"
}
```

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | A field is missing or out of range |
| 404 | `ACCOUNT_NOT_FOUND` | Either account doesn't exist |
| 409 | `DUPLICATE_TRANSFER` | `reference_id` already used for a transfer from this account. `error.details.transfer` is the original. |
| 422 | `INSUFFICIENT_BALANCE` | The source has too little money. Nothing changed. |
| 422 | `SAME_ACCOUNT_TRANSFER` | Source and destination are the same |

### Get a transfer

```
GET /transfers/:id
```

Returns the same object as above. Errors: `404 TRANSFER_NOT_FOUND`.

## Attempts

### List an account's refused debits

```
GET /accounts/:id/attempts
```

The audit log of debits and transfers that were refused, newest first. Takes `page` and `limit`. Use it to show customers a "Failed" item, or for support and fraud checks.

**`200 OK`**

```json
{
  "data": [
    {
      "id": "att_Xp5Cw9Rk2Dm7Hs0Fv3Jn",
      "account_id": "acc_4fK2pQ9xTb1LmZ7cR3sV",
      "type": "debit",
      "amount": 15000,
      "description": "November rent",
      "reference_id": "rent-nov",
      "reason_code": "INSUFFICIENT_BALANCE",
      "balance_at_attempt": 10000,
      "transfer_to_account_id": null,
      "created_at": "2026-10-28T12:41:09.002Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total_records": 1, "total_pages": 1 }
}
```

## Errors

Every error has the same shape. Branch on `code`; show `message` to people; read specifics from `details`.

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Balance 10000 is less than debit 15000",
    "details": { "account_id": "acc_4fK2pQ9xTb1LmZ7cR3sV", "balance": 10000, "amount": 15000 }
  }
}
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | A field is missing, has the wrong type, or is out of range. `details.issues` lists each problem. |
| 400 | `INVALID_PAGINATION` | `page` or `limit` isn't a positive whole number, or `limit` is over 100 |
| 400 | `INVALID_REQUEST_BODY` | The body isn't valid JSON |
| 404 | `ACCOUNT_NOT_FOUND` | No account has that ID |
| 404 | `TRANSFER_NOT_FOUND` | No transfer has that ID |
| 404 | `ROUTE_NOT_FOUND` | No such endpoint (transactions have no edit or delete endpoint) |
| 409 | `DUPLICATE_TRANSACTION` | `reference_id` already used on this account |
| 409 | `DUPLICATE_TRANSFER` | `reference_id` already used for a transfer from this account |
| 422 | `INSUFFICIENT_BALANCE` | The debit or transfer is larger than the balance |
| 422 | `SAME_ACCOUNT_TRANSFER` | A transfer's source and destination are the same |
| 422 | `BALANCE_LIMIT_EXCEEDED` | A credit would push the balance over the maximum |
| 500 | `INTERNAL_ERROR` | Something unexpected went wrong; no internal details are exposed |

`GET /health` returns `200 {"status": "ok"}` when the API can reach its database.
