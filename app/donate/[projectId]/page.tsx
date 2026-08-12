export const dynamic = "force-dynamic";

import { getPool } from "../../../src/db/index.js";

interface DonatePageProps {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ error?: string; amount?: string }>;
}

/** Friendly copy for the error codes the checkout handler can bounce back with. */
const ERROR_COPY: Record<string, string> = {
  invalid_request: "Something about that submission did not look right. Check the amount and email and try again.",
  project_not_found: "That project is not available for donations.",
  project_suspended: "Donations to this project are paused right now.",
  project_unquotable: "This project cannot be quoted right now. Try again later.",
  insufficient_pool_headroom:
    "Instant processing is at capacity right now. Uncheck instant and your donation will process on the normal schedule.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  not_configured:
    "Payments are not configured in this environment yet, so checkout cannot start. Everything before this point worked.",
};

/**
 * The hosted donate form: the front door for projects that do not embed the
 * API themselves. Amount and email are all a donor has to give; the payment
 * itself happens on Stripe's page, and the tokens land per the escrow
 * schedule. Works without JavaScript -- the form posts straight to
 * /api/checkout, which answers a form with a redirect to Stripe.
 */
export default async function DonatePage({ params, searchParams }: DonatePageProps) {
  const { projectId } = await params;
  const { error, amount } = await searchParams;

  if (!/^\d{1,15}$/.test(projectId)) {
    return <h1>Project not found</h1>;
  }

  const pool = getPool();
  const { rows } = await pool.query<{ name: string; status: string }>(
    `SELECT name, status FROM projects WHERE project_id = $1`,
    [projectId],
  );
  const project = rows[0];

  if (!project) {
    return (
      <>
        <h1>Project not found</h1>
        <p className="lede">This project is not set up to receive donations here.</p>
      </>
    );
  }

  if (project.status !== "active") {
    return (
      <>
        <h1>{project.name}</h1>
        <p className="notice problem">Donations to this project are paused right now.</p>
      </>
    );
  }

  return (
    <>
      <h1>Donate to {project.name}</h1>
      <p className="lede">
        Pay by card or bank transfer. Your donation buys {project.name} tokens onchain, held
        for you through the payment dispute window -- 120 days for cards, about a week for
        bank transfers. We email you a receipt and a note when they unlock.
      </p>

      {error ? (
        <p className="notice problem">{ERROR_COPY[error] ?? ERROR_COPY.invalid_request}</p>
      ) : null}

      <form className="stack donate" method="post" action="/api/checkout">
        <input type="hidden" name="projectId" value={projectId} />
        <label className="field grow">
          <span className="label">Amount (USD)</span>
          <input
            type="text"
            name="amountUsd"
            required
            inputMode="decimal"
            placeholder="25"
            defaultValue={amount ?? ""}
            aria-label="Donation amount in US dollars"
          />
        </label>
        <label className="field grow">
          <span className="label">Email</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            aria-label="Email address"
          />
        </label>
        <details className="advanced">
          <summary>Advanced</summary>
          <label className="field grow">
            <span className="label">Deliver tokens to a wallet you already have (optional)</span>
            <input
              type="text"
              name="walletAddress"
              placeholder="0x..."
              autoComplete="off"
              spellCheck={false}
              aria-label="Wallet address, optional"
            />
          </label>
          <label className="check">
            <input type="checkbox" name="instant" value="true" />
            <span>
              Process instantly (1.5% premium). The onchain payment executes right away instead
              of when your payment settles; the token hold is the same either way.
            </span>
          </label>
        </details>
        <button type="submit">Continue to payment</button>
      </form>

      <p className="muted">
        Cards work up to $500; larger donations continue by bank transfer. No wallet needed --
        one is created for you, and you can point your tokens anywhere later from{" "}
        <a href="/login">your donations page</a>.
      </p>
    </>
  );
}
