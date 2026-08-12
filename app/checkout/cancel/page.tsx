export const dynamic = "force-dynamic";

/**
 * Where Stripe sends a payer who backed out of checkout. It is the
 * `cancel_url` of every session, so it has to exist -- a 404 here is the last
 * thing a hesitant donor sees.
 *
 * It reads nothing. A canceled checkout was never charged and its row is still
 * `created`; reconciliation cancels it after a day, and looking anything up
 * would only turn "you did not pay" into a status page about a payment that
 * never happened.
 */
export default function CheckoutCanceledPage() {
  return (
    <>
      <h1>Checkout canceled</h1>
      <p className="lede">
        Nothing was charged and nothing was sent. Head back to the page you started from to
        try again whenever you like.
      </p>
      <p className="muted">
        Donated before? <a href="/login">Sign in to see your donations</a>.
      </p>
    </>
  );
}
