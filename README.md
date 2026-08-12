# JBProcessor

JBProcessor lets someone pay a Juicebox V6 project with a credit card or a US bank debit.
Stripe collects the fiat charge, a backend worker converts it to USDC and pays the project
onchain, and the resulting project tokens sit in an onchain escrow for the length of the
dispute window before being released to the payer — so a chargeback claws the tokens back
instead of leaving the project (or JBProcessor) holding the loss. The payer needs no wallet,
no seed phrase and no second visit: a wallet is pregenerated for their email address, and a
keeper delivers the tokens when the hold expires.

Base only. USDC only.

---

## How it fits together

A payment is a row in `payments` walking a state machine, and everything else in the service
is either something that moves it along or something that checks it hasn't got stuck.
`created` → `paid` (Stripe took the money) → `paying` (a single-row compare-and-set, so only
one runner can ever start a send) → `held` (tokens are in escrow) → `unlocked` (the hold
expired) → `claimed` (tokens delivered). `refunded`, `canceled` and `forfeited` are the exits.

| Component | Where | What it does |
| --- | --- | --- |
| Escrow contract | `contracts/src/JBProcessorEscrow.sol` | Pays the project's terminal, holds the tokens it receives against a `paymentId`, releases them after `unlockAt` (permissionless), or forfeits them to the owner before it. |
| Web service | `app/`, `src/http/` | The donor pages, `POST /api/checkout`, `POST /api/stripe-webhook`, magic-link sign-in and the account page. Holds no signing key. |
| Worker service | `src/worker/` | The only process with `WORKER_PRIVATE_KEY`. Runs the job queue: the payer, the release keeper, the redirect sender, forfeits, the ruleset watcher, daily reconciliation and all mail. |
| Job queue | `src/db/jobs.ts` | Postgres. `claimNext` is a single-row lock, retries back off, an exhausted job is marked `FATAL:` and reported by reconciliation. Recurring cranks are self-scheduling chains, re-seeded on every worker boot. |
| Chain layer | `src/chain/` | viem clients, the `previewPayFor` quote, and the escrow writes (simulate → send → confirm the receipt). |
| Accounts | `src/auth/`, `src/wallets/` | Magic links (HMAC tokens, single-use via `used_tokens`) and Para pregenerated wallets, memoized one-per-email. |

### Quoting

What a donation buys is normally `previewPayFor`'s `beneficiaryTokenCount`. But that reports
only what the *terminal mints*, and a revnet's data hook hands the whole payment to the buyback
hook, which acquires tokens by swapping on an AMM instead — so for those projects the preview
is zero while the payer in fact receives plenty.

Taken at face value that zero is corrosive: the payer is quoted nothing, the drift gate
compares zero against zero and never refunds, and `minTokensForQuote(0)` is 0, so the on-chain
send carries no slippage floor. So when the preview is zero *because* a pay hook claimed the
entire payment, `src/chain/quote.ts` falls back to the **mint-path floor** — what the terminal
would have minted had no hook intervened, mirroring `JBTerminalStore._computePayFrom` and
`JBController._splitTokenCount`:

```
weightRatio = amountCurrency == baseCurrency ? 10**decimals
                                             : JBPrices.pricePerUnitOf(...)
tokenCount  = amountUsdc * weight / weightRatio
floor       = tokenCount * (10000 - reservedPercent) / 10000
```

It is a true lower bound because the buyback hook only routes to the AMM when the swap beats
minting; when it doesn't, it mints, and the payer receives exactly this number.

Two details that are easy to get wrong, and are wrong in the obvious implementation. The
accounting context's currency is `uint32(uint160(token))` while a ruleset's `baseCurrency` is a
`JBCurrencyIds` value (USD = 2) — they are different namespaces and almost never equal, so the
price read is the normal path, not the exception. And that price is genuinely not 1:
`pricePerUnitOf(6, USDC, USD, 6)` returns `1000189` on Base, a live Chainlink USDC/USD feed.
Assuming `10**6` inflates the floor by ~0.02% and breaks the lower-bound property outright.

A quote of zero from *both* paths is refused at checkout (`project_unquotable`): a project
whose issuance cannot be described is a project this service will not sell.

Two facts worth holding onto:

- **The web process never signs anything.** `setBeneficiary` and `forfeit` are operator-only
  on the escrow, so a redirect request from the account page is a queued job and a 202, not a
  transaction hash.
- **`release` is permissionless onchain.** The keeper is a convenience, not a dependency. If
  the worker is down, anyone can crank an unlocked entry and the tokens reach the payer.

---

## Environment

Every variable, what it does, and which service needs it, is documented in
[`.env.example`](.env.example) — copy it to `.env` for local development. In short:

| Variable | Service | Required | Default |
| --- | --- | --- | --- |
| `DATABASE_URL` | both | yes | — |
| `BASE_RPC_URL` | both | yes | — |
| `BASE_URL` | both | yes | — |
| `ESCROW_ADDRESS` | both | yes | — |
| `WORKER_ADDRESS` | both | yes | — |
| `WORKER_PRIVATE_KEY` | worker | yes | — |
| `JB_CONTROLLER_ADDRESS` | both | yes | — |
| `STRIPE_SECRET_KEY` | both | yes | — |
| `STRIPE_WEBHOOK_SECRET` | web | yes | — |
| `RESEND_API_KEY` | worker | yes | — |
| `EMAIL_FROM` | worker | yes | — |
| `ALERT_EMAIL` | worker | yes | — |
| `AUTH_SECRET` | both | yes | — |
| `PARA_API_KEY` | web | yes | — |
| `PARA_ENVIRONMENT` | web | no | `PROD` |
| `COOKIE_SECURE` | both | no | secure unless `false` |
| `INSTANT_POOL_ADDRESS` | both | instant rail only | — |
| `PREMIUM_BPS` | web | no | `150` |
| `PROCESSOR_PROJECT_ID` / `PROCESSOR_TOKEN_ADDRESS` / `PROCESSOR_TERMINAL_ADDRESS` | worker | no (all three or none) | premium accrues in the settlement wallet |
| `CARD_CEILING_USD_CENTS` | web | no | `50000` |
| `BANK_HOLD_DAYS` | web | no | `7` |
| `DRIFT_TOLERANCE_BPS` | worker | no | `200` |
| `RESTING_BALANCE_ALERT_USDC` | worker | no | `100000000` |

The card hold is 120 days and is not configurable: it is a property of the card networks, not
of this deployment.

---

## Local development

```bash
npm install
createdb jbprocessor && createdb jbprocessor_test
cp .env.example .env            # then fill it in

npm run build:worker && npm run migrate     # apply migrations
npm test                                     # 269 tests, needs jbprocessor_test
npm run dev                                  # web, on :3000
npm run worker                               # worker, in a second shell
```

`npm run dev` and `npm run build` both pass `--webpack`. Everything under `src/` uses explicit
`.js` import specifiers because it also runs outside Next as plain Node ESM, and only webpack
honours the `extensionAlias` that maps them back to the `.ts` files (see `next.config.ts`).

Stripe locally:

```bash
stripe login
stripe listen --forward-to localhost:3000/api/stripe-webhook
# copy the whsec_... it prints into STRIPE_WEBHOOK_SECRET -- it is NOT the
# dashboard's signing secret
stripe trigger checkout.session.completed     # or drive a real test-mode checkout
```

The tests create and drop their own throwaway schemas in `TEST_DATABASE_URL`
(default `postgres://localhost:5432/jbprocessor_test`), so they need a running Postgres but
never touch development data.

### Fork testing

The fork suites run the real escrow against a real anvil fork of Base. They are skipped unless
`FORK_RPC_URL` is set, so `npm test` never touches the network.

```bash
cd contracts && forge build && cd ..
FORK_RPC_URL=https://mainnet.base.org npm run test:fork
```

`test:fork` passes `--no-file-parallelism` deliberately: two anvils lazily fetching Base state
through one public RPC starve each other, and the loser sees a transaction that simulated and
then reverted.

Verified Base mainnet (chainId 8453) addresses, read back off Base on 2026-08-11. All are
defaults in `test/fork-addresses.ts` and all are overridable by environment variable.

| What | Address | Verified by |
| --- | --- | --- |
| JBController | `0x3Fcec3572e84b624477BcfF4E2CF1f7dEAb648F1` | `JBDirectory.controllerOf(6)`; `JBController.DIRECTORY()` round-trips |
| JBDirectory | `0x5AfF29060E023e6FB87BE5596652B33c65Af535B` | `JBMultiTerminal`/`JBController` cross-reads |
| JBMultiTerminal | `0x130f5Dd2bD8805443Cf41755253D778a75a67f53` | `JBDirectory.primaryTerminalOf(6, USDC)` |
| JBTokens | `0x1f80d8f057eE36b4C2656D107E4e4558B71bA7D9` | `JBController.TOKENS()` |
| Test project | V6 **#6**, "Artizen" (ART) | `accountingContextForTokenOf(6, USDC)` → `(USDC, 6, 3181390099)`; `currentRulesetOf(6).pausePay == false` |
| Test project token | `0x44c4516768e47cd97cfF2561B81a74699F23f8Ec` | `JBTokens.tokenOf(6)` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | canonical Base USDC |
| USDC whale | `0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB` | Aave v3 `aBasUSDC`, ~17.9M USDC; `USDC.isBlacklisted` false |

Project #6 was chosen from the ten V6 projects on Base because its primary USDC terminal is
`JBMultiTerminal` directly rather than the router registry (projects 1, 5 and 7 route through
the registry, and calling the multi-terminal for them reverts), and because its ruleset does
not pause pay.

**What this project exercises.** #6 is a revnet with `useDataHookForPay`, so the terminal hands
the whole payment to a pay hook (the buyback hook) which acquires tokens by swapping rather
than minting. `previewPayFor` reports what the *terminal* mints, so it returns **zero**
beneficiary tokens for such a project — which is why the quote falls back to the mint-path
floor (see "Quoting" below). The fork suite asserts the floor really is a lower bound on what
the payer receives.

---

## Deploying

### 1. The escrow

```bash
cd contracts
OWNER=<treasury Safe> OPERATOR=<fresh worker EOA> \
  forge script script/Deploy.s.sol:DeployScript \
  --rpc-url $BASE_RPC_URL --broadcast --verify
```

`OWNER` receives forfeited tokens and is the only address that can rotate the operator; it
should be the multisig, never an EOA. `OPERATOR` is a freshly generated EOA whose key exists
only in the worker's environment. They must differ — an owner that is also the operator has no
recovery path if the worker key leaks.

Then fund the operator with a little ETH for gas, and record the deployed address as
`ESCROW_ADDRESS` on both services.

### 2. Railway

Provision a Postgres database and two services from this repository:

- **web** — uses `railway.json` (the default config path). Start command `npm run start`.
- **worker** — set its *Config as code* path to `railway.worker.json`. Start command
  `npm run migrate && npm run worker`, and **one replica**. Migrations run here because it is
  the service that is single-instance by design.

Set `DATABASE_URL` on both to `${{Postgres.DATABASE_URL}}` rather than pasting a URL. Set the
rest from the table above, and keep `WORKER_PRIVATE_KEY` off the web service.

**Order matters on every deploy, first and subsequent.** Deploy the worker first and let its
`npm run migrate` finish before the web service starts: the web service never migrates, so a
web instance that boots against a schema older than its code queries columns that do not exist
yet. On Railway, deploy the worker service, wait for its log line, then deploy web.

### 3. Stripe

Create the webhook endpoint at `https://<your-domain>/api/stripe-webhook`, subscribed to:
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `charge.dispute.created`, `charge.refunded`. Copy its
signing secret into `STRIPE_WEBHOOK_SECRET`.

Live mode additionally needs the USDC-settlement conversation with Stripe resolved — until it
is, the account stays in test mode and no real donation can be taken.

### 4. Para and Resend

Para: create a project, take the server API key, set `PARA_ENVIRONMENT=PROD`. Resend: verify
the sending domain and point `EMAIL_FROM` at it.

### 5. End-to-end check, in Stripe test mode

Not yet run — it needs Stripe credentials this build had none of. After onboarding, with
`stripe listen` forwarding to the deployed webhook:

1. `POST /api/checkout` with a small amount → open the returned `url`.
2. Pay with `4000 0027 6000 3184` (forces a 3DS challenge; every card here requests one).
3. Watch the worker log the pay job, and `/done?payment_id=...` move to *Held in escrow*.
4. For a short loop, insert the project row with a small `BANK_HOLD_DAYS` on a bank-debit
   payment, or wait out the hold; the release scan runs every ten minutes.
5. Confirm the delivery email and the `release_tx` on Basescan.

---

## Runbooks

### Rotating the worker key

The escrow's operator is the only thing that can `setBeneficiary` or `forfeit`, so a leaked
`WORKER_PRIVATE_KEY` is rotated at the contract, not just in the environment.

1. Generate a new EOA. Fund it with gas.
2. From the owner Safe: `escrow.setOperator(<new operator>)`. The old operator loses access in
   that transaction.
3. Update `WORKER_PRIVATE_KEY` (worker) and `WORKER_ADDRESS` (both) and redeploy.
4. If the instant rail is in use, re-point the pool Safe's USDC allowance at the new address
   and set the old one's to zero.
5. Sweep any USDC left in the old settlement wallet to the new one. Reconciliation's resting
   balance check will otherwise report it every day, which is the correct behaviour.

`release` is permissionless, so deliveries continue throughout.

### A dispute arrives

The webhook handles what it safely can on `charge.dispute.created`: a payment still `paid` or
`settled` is `canceled` before anything is spent, and a payment already `held` is moved to
`forfeited` with a forfeit job queued. Two cases need a human.

- **The payment was `paying`.** Mid-send and owned by the worker, so the webhook leaves it
  alone rather than racing an onchain transaction. It becomes `held`, and the next
  reconciliation reports it by id. Decide whether to forfeit: if the entry is still unsettled,
  queue a forfeit with `INSERT INTO jobs (kind, payload, dedupe_key) VALUES ('forfeit',
  jsonb_build_object('paymentId', '<uuid>'), 'forfeit:<uuid>:manual');`
- **The tokens were already released.** `forfeit` reverts once an entry is settled
  (`AlreadySettled`) and after `unlockAt` (`UnlockPassed`), by design. The tokens are gone;
  the loss is the processor's, and the only remaining action is to contest the dispute at
  Stripe.

Forfeited tokens land with the **owner Safe**, not the operator. Cashing them out is manual and
deliberately so: cash out through the project's terminal from the Safe, at a time and size
someone has chosen.

### Reconciliation alerts

One email a day, `[JBProcessor] Reconciliation found N discrepancies`, listing everything at
once. Nothing is ever auto-corrected (bar cancelling checkouts nobody completed). By line:

- *no escrow entry onchain* — the ledger thinks tokens are held and the chain disagrees. Check
  `pay_tx` on Basescan first; a reverted send with a row that moved anyway is a bug worth
  finding.
- *BENEFICIARY MISMATCH* — an entry points somewhere this service never asked for. Treat as a
  compromised operator key until proven otherwise: rotate first, investigate second.
- *tokens_held … but the escrow entry amount is …* — the ledger and the chain disagree about
  the amount. The chain is right; the row is what needs explaining.
- *stuck in 'paying'* — a worker died mid-send. The payment resumes on its own when a `pay`
  job runs again, and the escrow's own entry is what tells it whether the send landed. If no
  job is scheduled, enqueue one (same SQL shape as the forfeit above, `kind` = `'pay'`).
- *still 'held' though its unlock passed* — the unlock-note job probably went FATAL; the same
  run will say so on its own line.
- *settlement wallet holds N USDC base units* — money that arrived for a payment whose onchain
  send never happened. Cross-reference against `paying`/`FATAL` lines in the same email.
- *Stripe cross-check* — a "look at the day" signal, not a ledger equality: it counts every
  succeeded charge on the account, including another integration's, and a checkout that
  straddles midnight lands on either side.
- *disputed but still '<state>'* — see the dispute runbook. Never auto-forfeited.

### Adding an eligible project

There is no admin UI. Onboarding is a reviewed `INSERT`, and the review is the point.

Check, in order:

1. `JBDirectory.primaryTerminalOf(<id>, USDC)` returns a terminal, and
   `<terminal>.accountingContextForTokenOf(<id>, USDC)` returns a USDC context with 6
   decimals. A project whose USDC terminal is the router registry may revert here.
2. `JBTokens.tokenOf(<id>)` is non-zero — the escrow holds an ERC-20, not credits.
3. `JBController.currentRulesetOf(<id>)`: `pausePay` false. Read `reservedPercent` (how much of
   the payer's issuance is skimmed), `cashOutTaxRate`, `allowOwnerMinting` and
   `allowSetCustomToken` and decide whether the deal is one worth selling.
4. The project can be quoted. `previewPayFor(<id>, USDC, <amount>, <beneficiary>, 0x)`
   returning a non-zero `beneficiaryTokenCount` is the easy case. A **zero** with the pay-hook
   specifications claiming the full amount is the revnet/buyback case, which the mint-path
   floor handles (see "Quoting") — check that the ruleset's `weight` is non-zero and its
   `reservedPercent` is under 10000, or the floor is zero too. A zero with **no** hook claiming
   the payment means the project genuinely issues nothing; checkout will refuse it with
   `project_unquotable`, and it cannot be onboarded.
5. Read the project's onchain terms as a human. The ruleset watcher will suspend the project if
   they change, so what is being recorded here is the deal as it stands today.

Then:

```sql
INSERT INTO projects (project_id, name, token_address, terminal_address, status)
VALUES (6, 'Artizen', '0x44c4516768e47cd97cfF2561B81a74699F23f8Ec',
        '0x130f5Dd2bD8805443Cf41755253D778a75a67f53', 'active');
```

`ruleset_fingerprint` is left null on purpose: the watcher records the first fingerprint it
reads and treats that as enrollment, not as a change.

### Re-activating a suspended project

The ruleset watcher suspends a project whose onchain terms move, and stores the new
fingerprint alongside the suspension so it does not re-alert. Suspension is one-way by design:
clearing it is a human saying the new terms are still acceptable.

Read the alert's *Current ruleset* against its *Previous fingerprint*, decide, and then:

```sql
UPDATE projects SET status = 'active' WHERE project_id = <id>;
```

Do **not** clear `ruleset_fingerprint` — it already holds the new terms, which is exactly what
the next scan should compare against. Payments already in flight are unaffected either way:
they were quoted and bought under the old terms.

---

## Testing

```bash
npm test                                          # unit + integration, needs Postgres
FORK_RPC_URL=https://mainnet.base.org npm run test:fork   # against real Base state
cd contracts && forge test                        # the escrow contract
```
