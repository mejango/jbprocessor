-- When an instant payment's USDC was swept back to the instant pool.
--
-- The instant rail fronts a payment out of the pool's standing allowance and
-- is repaid days later, when the payer's own Stripe money settles into the
-- settlement wallet. That repayment is a manual transfer today (see "Instant
-- pool operations" in the README): nothing in this service moves USDC back to
-- the pool Safe, and the allowance only ever depletes until someone does.
--
-- This column is what makes the omission loud instead of silent. Reconciliation
-- reports every settled instant payment that drew from the pool and has not
-- been marked swept, so the outstanding balance is a line in the daily email
-- rather than a number an operator has to think to go and compute.
ALTER TABLE payments ADD COLUMN pool_swept_at timestamptz;

-- The reconciliation query is exactly this predicate.
CREATE INDEX payments_pool_unswept
  ON payments (state)
  WHERE instant AND pool_draw_tx IS NOT NULL AND pool_swept_at IS NULL;
