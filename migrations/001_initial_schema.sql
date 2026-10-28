-- Initial ledger schema. All amounts are BIGINT paise (100 paise = ₹1), INR only.

CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  balance     BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT accounts_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  -- Safety net: even buggy application code can never overdraw an account.
  CONSTRAINT accounts_balance_non_negative CHECK (balance >= 0),
  -- Keep balances inside JavaScript's exact-integer range (2^53 - 1).
  CONSTRAINT accounts_balance_max CHECK (balance <= 9007199254740991)
);

CREATE TABLE transfers (
  id               TEXT PRIMARY KEY,
  from_account_id  TEXT NOT NULL REFERENCES accounts (id),
  to_account_id    TEXT NOT NULL REFERENCES accounts (id),
  amount           BIGINT NOT NULL,
  description      TEXT,
  reference_id     TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT transfers_amount_positive CHECK (amount > 0),
  CONSTRAINT transfers_distinct_accounts CHECK (from_account_id <> to_account_id),
  CONSTRAINT transfers_description_length CHECK (description IS NULL OR char_length(description) <= 255),
  -- A retried transfer (same source, same reference) must never move money twice.
  CONSTRAINT transfers_from_reference_unique UNIQUE (from_account_id, reference_id)
);

CREATE TABLE transactions (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts (id),
  type           TEXT NOT NULL,
  amount         BIGINT NOT NULL,
  description    TEXT,
  reference_id   TEXT NOT NULL,
  -- Running balance right after this transaction, like a bank statement.
  balance_after  BIGINT NOT NULL,
  transfer_id    TEXT REFERENCES transfers (id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT transactions_type_valid CHECK (type IN ('credit', 'debit')),
  CONSTRAINT transactions_amount_positive CHECK (amount > 0),
  CONSTRAINT transactions_balance_after_non_negative CHECK (balance_after >= 0),
  CONSTRAINT transactions_description_length CHECK (description IS NULL OR char_length(description) <= 255),
  -- Idempotency: one reference_id per account; the same reference may appear on other accounts.
  CONSTRAINT transactions_account_reference_unique UNIQUE (account_id, reference_id)
);

-- History is always read per account, newest first, with id as the tie-breaker.
CREATE INDEX transactions_account_history_idx ON transactions (account_id, created_at DESC, id DESC);
CREATE INDEX transactions_account_type_history_idx ON transactions (account_id, type, created_at DESC, id DESC);

-- Audit log of money movements the ledger rules refused (e.g. insufficient balance).
-- Never part of the balance or transaction history.
CREATE TABLE transaction_attempts (
  id                        TEXT PRIMARY KEY,
  account_id                TEXT NOT NULL REFERENCES accounts (id),
  type                      TEXT NOT NULL,
  amount                    BIGINT NOT NULL,
  description               TEXT,
  reference_id              TEXT NOT NULL,
  reason_code               TEXT NOT NULL,
  balance_at_attempt        BIGINT NOT NULL,
  transfer_to_account_id    TEXT REFERENCES accounts (id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT attempts_type_valid CHECK (type IN ('credit', 'debit'))
);

CREATE INDEX transaction_attempts_account_idx ON transaction_attempts (account_id, created_at DESC, id DESC);

-- Transactions are immutable: the database itself refuses edits and deletes,
-- so the guarantee holds even for someone connected directly to Postgres.
CREATE FUNCTION reject_transaction_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'transactions are immutable: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_immutable
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION reject_transaction_change();
