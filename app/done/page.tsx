import { basescanTx, formatTokens, formatUsdCents } from "../../src/account/format.js";
import { publicPaymentView, stateLabel } from "../../src/account/payments.js";
import { getPool } from "../../src/db/index.js";

export const dynamic = "force-dynamic";

interface DonePageProps {
  searchParams: Promise<{ payment_id?: string }>;
}

/**
 * Where Stripe sends the payer after checkout. It reads the same public view
 * the integrator API serves, so what a donor sees here is exactly what a
 * partner's own page can show.
 */
export default async function DonePage({ searchParams }: DonePageProps) {
  const { payment_id: paymentId } = await searchParams;
  const payment = paymentId ? await publicPaymentView(getPool(), paymentId) : null;

  if (!payment) {
    return (
      <>
        <h1>Thank you</h1>
        <p className="lede">
          Your donation is being processed. We could not look up its status from this link, but
          your receipt is on its way by email.
        </p>
        <p>
          <a href="/login">Sign in to see your donations</a>
        </p>
      </>
    );
  }

  const unlockAt = payment.unlockAt ? new Date(payment.unlockAt) : null;

  return (
    <>
      <h1>Thank you</h1>
      <p className="lede">
        Your donation of {formatUsdCents(payment.amountUsdCents)} is on its way to the project.
      </p>

      <section className="card">
        <span className="status">{stateLabel(payment.state)}</span>

        <div className="row">
          <span className="field">
            <span className="label">{payment.tokensHeld ? "Tokens held" : "Tokens expected"}</span>
            <span className="value">
              {formatTokens(payment.tokensHeld ?? payment.quoteTokens)}
            </span>
          </span>
          {unlockAt ? (
            <span className="field">
              <span className="label">Delivered after</span>
              <span className="value">
                {unlockAt.toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </span>
            </span>
          ) : null}
        </div>

        <div className="row">
          <span className="field">
            <span className="label">Destination</span>
            <span className="value mono">{payment.beneficiary ?? "--"}</span>
          </span>
        </div>

        {payment.payTx ? (
          <p className="muted">
            <a href={basescanTx(payment.payTx)} rel="noreferrer noopener" target="_blank">
              Escrow transaction
            </a>
          </p>
        ) : null}
      </section>

      <p>
        Tokens are held in escrow until the date above, then delivered to your wallet
        automatically. Nothing is required of you.
      </p>
      <p className="muted">
        <a href="/login">Sign in</a> to follow this donation, or to send the tokens somewhere
        else.
      </p>
    </>
  );
}
