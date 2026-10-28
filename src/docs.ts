// Content for the API reference at /docs. The introduction is Markdown and is
// rendered as the first page, before the endpoint reference.

export const API_INTRODUCTION = `
A ledger for accounts, credits, debits and transfers. Every balance is always exact: two requests can never spend the same money, retries never double-charge, and recorded transactions can never be changed.

## Quick start

Three calls take you from nothing to a balance. The server runs at \`http://localhost:3020\`.

**1. Create an account.** It starts with a balance of 0.

\`\`\`bash
curl -X POST http://localhost:3020/api/v1/accounts \\
  -H 'content-type: application/json' \\
  -d '{"name": "Asha Rao"}'
\`\`\`

**2. Credit it ₹150.50.** Amounts are in paise, so that is \`15050\`.

\`\`\`bash
curl -X POST http://localhost:3020/api/v1/accounts/ACCOUNT_ID/transactions \\
  -H 'content-type: application/json' \\
  -d '{"type": "credit", "amount": 15050, "reference_id": "salary-oct"}'
\`\`\`

**3. Read the balance.**

\`\`\`bash
curl http://localhost:3020/api/v1/accounts/ACCOUNT_ID/balance
\`\`\`

## Amounts are in paise

Every amount is a whole number in paise: \`100\` is ₹1 and \`15050\` is ₹150.50. Whole numbers avoid the rounding errors of decimals (in floating point, 0.1 + 0.2 is 0.30000000000000004). INR is the only currency. One transaction can move between 1 and 1,000,000,000,000 paise.

## Safe retries with reference_id

Every transaction carries a \`reference_id\` that you choose, such as an order or invoice number. If a request times out, send it again with the same \`reference_id\`: the ledger records it once and answers the repeat with \`409 DUPLICATE_TRANSACTION\` and the original transaction. Reference IDs are unique per account, so different accounts can reuse the same one.

A debit refused for insufficient balance does not use up its \`reference_id\`. Add money and retry with the same one.

## Rejected debits

A debit larger than the balance is refused with \`422 INSUFFICIENT_BALANCE\` and the balance does not change. The refusal is kept in the account's **attempts** log for auditing, and never appears in transaction history.

## Errors

Every error has the same shape. Branch on \`code\`; show \`message\` to people.

\`\`\`json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Balance 10000 is less than debit 15000",
    "details": { "account_id": "acc_4fK2pQ9xTb1LmZ7cR3sV", "balance": 10000, "amount": 15000 }
  }
}
\`\`\`

| Status | Code | Meaning |
|---|---|---|
| 400 | \`VALIDATION_ERROR\` | A field is missing, has the wrong type, or is out of range. \`details.issues\` lists each problem. |
| 400 | \`INVALID_PAGINATION\` | \`page\` or \`limit\` is not a positive whole number, or \`limit\` is over 100. |
| 400 | \`INVALID_REQUEST_BODY\` | The body is not valid JSON. |
| 404 | \`ACCOUNT_NOT_FOUND\` | No account has that ID. |
| 404 | \`TRANSFER_NOT_FOUND\` | No transfer has that ID. |
| 404 | \`ROUTE_NOT_FOUND\` | No such endpoint. Transactions have no edit or delete endpoint. |
| 409 | \`DUPLICATE_TRANSACTION\` | This \`reference_id\` is already used on this account. |
| 409 | \`DUPLICATE_TRANSFER\` | This \`reference_id\` is already used for a transfer from this account. |
| 422 | \`INSUFFICIENT_BALANCE\` | The debit or transfer is larger than the balance. |
| 422 | \`SAME_ACCOUNT_TRANSFER\` | A transfer's source and destination are the same account. |
| 422 | \`BALANCE_LIMIT_EXCEEDED\` | A credit would push the balance over the maximum. |
| 500 | \`INTERNAL_ERROR\` | Something unexpected went wrong. No internal details are exposed. |

## Pagination

List endpoints take \`page\` (default 1) and \`limit\` (default 20, max 100) and return a \`pagination\` object with \`page\`, \`limit\`, \`total_records\` and \`total_pages\`. Results are newest first. A page past the end returns an empty list with the correct totals.

## IDs

IDs say what they point to: \`acc_\` for accounts, \`txn_\` for transactions, \`trf_\` for transfers and \`att_\` for attempts.
`;

export const API_TAGS = [
  { name: 'Accounts', description: 'An account holds a balance in paise. It starts at 0 and changes only through transactions.' },
  {
    name: 'Transactions',
    description:
      'A transaction is one credit or debit on one account. Once recorded it can never be edited or deleted; to correct a mistake, record a new transaction.',
  },
  {
    name: 'Transfers',
    description:
      'A transfer moves money between two accounts. The debit on the source and the credit on the destination are recorded together or not at all.',
  },
  {
    name: 'Attempts',
    description:
      'Attempts are debits and transfers the ledger refused, kept as an audit log. They never affect a balance and never appear in transaction history.',
  },
  { name: 'Health', description: 'Service status.' },
];
