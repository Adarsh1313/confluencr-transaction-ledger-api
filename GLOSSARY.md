# Glossary

**Account**: A named holder of money in the ledger. Its balance starts at 0 and changes only through Transactions.

**Balance**: The amount currently held by an Account, in paise. Always equals the sum of its credits minus the sum of its debits.

**Transaction**: One immutable ledger entry against one Account: either a Credit or a Debit. Once written it is never edited or deleted.
_Avoid_: entry, record, payment.

**Credit**: A Transaction that increases an Account's Balance.

**Debit**: A Transaction that decreases an Account's Balance. Rejected if the Balance is insufficient.

**Reference ID**: A client-supplied key that identifies a Transaction within one Account. Resubmitting the same Reference ID to the same Account does not create a second Transaction.

**Paise**: The unit of every amount in the system. 100 paise = ₹1.

**Database transaction**: The all-or-nothing wrapper around a group of database writes. Always say "database transaction" for this, never just "transaction".
