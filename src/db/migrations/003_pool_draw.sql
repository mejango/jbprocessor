-- The instant pool draw is a real money movement that happens between two
-- durable states, so it needs its own record: without one, every retry of a
-- payment whose on-chain send keeps reverting draws the pool again, and the
-- over-draw is invisible to checkout's headroom math (which counts payment
-- states, not draws).
ALTER TABLE payments ADD COLUMN pool_draw_tx text;
