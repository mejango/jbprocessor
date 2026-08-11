CREATE TYPE payment_state AS ENUM (
  'created','paid','settled','paying','held','unlocked','claimed',
  'refunded','forfeited','canceled');

CREATE TABLE projects (
  project_id bigint PRIMARY KEY,
  name text NOT NULL,
  token_address text NOT NULL,
  terminal_address text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  ruleset_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id bigint NOT NULL REFERENCES projects,
  email text NOT NULL,
  amount_usd_cents bigint NOT NULL CHECK (amount_usd_cents > 0),
  instant boolean NOT NULL DEFAULT false,
  method text CHECK (method IN ('card','bank')),
  state payment_state NOT NULL DEFAULT 'created',
  stripe_session_id text UNIQUE,
  stripe_payment_intent text UNIQUE,
  quote_tokens numeric,
  tokens_held numeric,
  pay_tx text,
  unlock_at timestamptz,
  claim_address text,
  release_tx text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_email ON payments (email);
CREATE INDEX payments_state ON payments (state);

CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 8,
  locked_at timestamptz,
  done_at timestamptz,
  last_error text,
  dedupe_key text UNIQUE
);
CREATE INDEX jobs_ready ON jobs (run_at) WHERE done_at IS NULL;

CREATE TABLE stripe_events (id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
