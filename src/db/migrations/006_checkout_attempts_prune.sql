-- The rate limiter prunes rows that have fallen out of its window on every
-- request, and it prunes GLOBALLY rather than for the requesting address: an
-- address-scoped prune only ever cleans up after addresses that come back, so
-- a flood from rotating addresses -- the traffic that produces the most rows --
-- would leave every one of them behind forever.
--
-- That delete predicates on `created_at` alone, which the (ip, created_at)
-- index cannot serve: its leading column isn't in the predicate.
CREATE INDEX checkout_attempts_created_at ON checkout_attempts (created_at);
