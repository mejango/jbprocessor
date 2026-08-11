-- One row per checkout attempt, kept only so the public checkout endpoint can
-- rate-limit by source address. It is an abuse dampener, not an audit trail:
-- every attempt that gets far enough to matter also writes a `payments` row,
-- which is the record that counts.
--
-- The insert is the gate (see `src/http/checkout.ts`), so this table is written
-- on every attempt including the ones that are refused -- otherwise a caller
-- who only ever sends invalid requests would never consume their own budget.
CREATE TABLE checkout_attempts (
  id bigserial PRIMARY KEY,
  ip text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checkout_attempts_ip ON checkout_attempts (ip, created_at);
