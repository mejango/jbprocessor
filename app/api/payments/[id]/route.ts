import { publicPaymentView } from "../../../../src/account/payments.js";
import { getPool } from "../../../../src/db/index.js";

/**
 * The integrator surface: everything a partner's own donation page needs to
 * show a donor where their money is, and nothing else. No email, and no
 * Stripe identifiers -- the payment id is handed out with the checkout link,
 * so whatever this returns is effectively public.
 *
 * Never cached: a donor refreshing after their tokens land must see that.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const view = await publicPaymentView(getPool(), id);

  if (!view) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json(view, { headers: { "Cache-Control": "no-store" } });
}
