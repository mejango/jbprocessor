import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  basescanTx,
  formatTokens,
  formatUsdCents,
} from "../../src/account/format.js";
import {
  listAccountPayments,
  pregenAddressFor,
  type AccountPaymentView,
} from "../../src/account/payments.js";
import { readSession, SESSION_COOKIE_NAME } from "../../src/auth/magic.js";
import { getPool } from "../../src/db/index.js";

export const dynamic = "force-dynamic";

interface AccountPageProps {
  searchParams: Promise<{ redirected?: string; error?: string }>;
}

const REDIRECT_ERRORS: Record<string, string> = {
  invalid_address: "That is not a valid wallet address.",
  forbidden: "That donation belongs to a different account.",
  not_found: "We could not find that donation.",
  not_redirectable: "That donation can no longer be redirected.",
  redirect_pending: "That donation already has a destination change on its way onchain.",
  rate_limited: "That donation has already been redirected three times today. Try tomorrow.",
  unauthorized: "Your session expired. Sign in again.",
};

export default async function AccountPage({ searchParams }: AccountPageProps) {
  const { redirected, error } = await searchParams;

  const cookieStore = await cookies();
  const email = readSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  if (!email) redirect("/login");

  const pool = getPool();
  const [payments, pregenAddress] = await Promise.all([
    listAccountPayments(pool, email),
    pregenAddressFor(pool, email),
  ]);

  return (
    <>
      <h1>Your donations</h1>
      <p className="lede">Signed in as {email}.</p>

      {redirected ? (
        <p className="notice">
          Destination change queued. We send it onchain within a few minutes, and it takes
          effect 48 hours after that -- your tokens are delivered to the new address once the
          wait is over.
        </p>
      ) : null}
      {error ? (
        <p className="notice problem">{REDIRECT_ERRORS[error] ?? "Something went wrong."}</p>
      ) : null}

      {payments.length === 0 ? (
        <p>No donations yet for this address.</p>
      ) : (
        payments.map((payment) => (
          <PaymentCard key={payment.id} payment={payment} pregenAddress={pregenAddress} />
        ))
      )}
    </>
  );
}

function PaymentCard({
  payment,
  pregenAddress,
}: {
  payment: AccountPaymentView;
  pregenAddress: string | null;
}) {
  const heldOrExpected = payment.tokensHeld ?? payment.quoteTokens;
  const tokensLabel = payment.tokensHeld ? "Tokens held" : "Tokens expected";
  const goesToPregenWallet =
    pregenAddress !== null &&
    payment.destination !== null &&
    payment.destination.toLowerCase() === pregenAddress.toLowerCase();

  return (
    <section className="card">
      <h2>{payment.projectName}</h2>
      <span className="status">{payment.stateLabel}</span>

      <div className="row">
        <span className="field">
          <span className="label">Donation</span>
          <span className="value">{formatUsdCents(payment.amountUsdCents)}</span>
        </span>
        {payment.premiumUsdCents !== "0" ? (
          <span className="field">
            <span className="label">Service fee</span>
            <span className="value">{formatUsdCents(payment.premiumUsdCents)}</span>
          </span>
        ) : null}
        <span className="field">
          <span className="label">{tokensLabel}</span>
          <span className="value">{formatTokens(heldOrExpected)}</span>
        </span>
        {payment.unlockInDays !== null ? (
          <span className="field">
            <span className="label">Unlocks in</span>
            <span className="value">
              {payment.unlockInDays === 0
                ? "Any moment"
                : `${payment.unlockInDays} ${payment.unlockInDays === 1 ? "day" : "days"}`}
            </span>
          </span>
        ) : null}
      </div>

      <div className="row">
        <span className="field">
          <span className="label">Destination</span>
          <span className="value mono">{payment.destination ?? "--"}</span>
        </span>
        {payment.pendingDestination ? (
          <span className="field">
            <span className="label">Change queued</span>
            <span className="value mono">{payment.pendingDestination}</span>
          </span>
        ) : null}
      </div>

      {payment.pendingDestination ? (
        <p className="muted">
          This change is on its way onchain. It takes effect 48 hours after we send it, and
          you can queue another change once it has gone through.
        </p>
      ) : null}

      {goesToPregenWallet ? (
        <p className="muted">
          This is a wallet we created for you. Claim it with this email address to take full
          control of the tokens -- you can do that before or after they arrive.
        </p>
      ) : null}

      {payment.payTx || payment.releaseTx ? (
        <p className="muted">
          {payment.payTx ? (
            <a href={basescanTx(payment.payTx)} rel="noreferrer noopener" target="_blank">
              Escrow transaction
            </a>
          ) : null}
          {payment.payTx && payment.releaseTx ? " -- " : null}
          {payment.releaseTx ? (
            <a href={basescanTx(payment.releaseTx)} rel="noreferrer noopener" target="_blank">
              Delivery transaction
            </a>
          ) : null}
        </p>
      ) : null}

      {payment.canRedirect ? (
        <form className="stack" method="post" action="/api/redirect">
          <input type="hidden" name="paymentId" value={payment.id} />
          <input
            type="text"
            name="address"
            required
            placeholder="0x..."
            aria-label="New destination address"
          />
          <button type="submit">Change destination</button>
        </form>
      ) : null}
    </section>
  );
}
