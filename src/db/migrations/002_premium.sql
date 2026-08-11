-- The instant premium is a service fee charged on top of the donation. It's
-- stored, not re-derived from PREMIUM_BPS at read time: the rate can change
-- between when a payment was taken and when reconciliation compares our
-- ledger against Stripe's, and the charged amount must stay reproducible.
ALTER TABLE payments
  ADD COLUMN premium_usd_cents bigint NOT NULL DEFAULT 0
    CHECK (premium_usd_cents >= 0);
