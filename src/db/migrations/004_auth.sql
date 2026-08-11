-- Magic-link tokens are single-use, and the proof of use has to survive
-- outside the token itself (the token is a self-contained MAC, so nothing in
-- it can record that it was already spent). The row is keyed by the token's
-- sha256, never the token: a leaked database dump must not hand out live
-- links.
CREATE TABLE used_tokens (
  hash text PRIMARY KEY,
  used_at timestamptz NOT NULL DEFAULT now()
);

-- One email always maps to one pregenerated wallet. The primary key is what
-- enforces it: two concurrent checkouts for the same payer both insert, one
-- wins, and the loser reads the winner's address rather than minting a second
-- wallet the payer would then have to find.
CREATE TABLE pregen_wallets (
  email text PRIMARY KEY,
  address text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Every accepted redirect, kept as an audit trail rather than derived from
-- `payments.claim_address` (which only remembers the latest one). The rate
-- limit counts rows here, so a payer who loses access to a destination can
-- still move it a few times, but a compromised session can't walk the tokens
-- through an unbounded chain of addresses.
CREATE TABLE redirects (
  id bigserial PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments,
  to_address text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX redirects_payment ON redirects (payment_id, created_at);
