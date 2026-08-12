import { RedirectError, requestRedirect } from "../../../src/account/redirect.js";
import { sessionFromCookieHeader } from "../../../src/auth/magic.js";
import { getPool } from "../../../src/db/index.js";
import { readRequestFields } from "../../../src/http/fields.js";

/**
 * Points a payment's escrowed tokens at a different address. Optional by
 * design: a payer who does nothing still receives their tokens at the address
 * recorded at checkout.
 *
 * This route never signs anything. `setBeneficiary` is an operator-only call
 * on the escrow -- and the same operator can `forfeit` -- so the key stays in
 * the worker, and an accepted request is a queued job plus a 202, not a
 * transaction hash. The redirect then takes the escrow's 48h delay before it
 * takes effect anyway, so there was never a synchronous answer worth having.
 */
export async function POST(request: Request): Promise<Response> {
  const { fields, isForm } = await readRequestFields(request);

  const sessionEmail = sessionFromCookieHeader(request.headers.get("cookie"));
  if (!sessionEmail) {
    return respond(request, isForm, 401, { error: "unauthorized" }, "/login");
  }

  try {
    const result = await requestRedirect(
      { pool: getPool() },
      {
        paymentId: fields.paymentId ?? "",
        address: fields.address ?? "",
        sessionEmail,
      },
    );
    return respond(request, isForm, 202, { ...result }, "/account?redirected=1");
  } catch (err) {
    if (err instanceof RedirectError) {
      return respond(
        request,
        isForm,
        err.status,
        { error: err.code },
        `/account?error=${err.code}`,
      );
    }
    throw err;
  }
}

/** Form posts want the account page back; API callers want the JSON. */
function respond(
  request: Request,
  isForm: boolean,
  status: number,
  body: Record<string, unknown>,
  formLocation: string,
): Response {
  if (isForm) {
    return Response.redirect(new URL(formLocation, request.url), 303);
  }
  return Response.json(body, { status });
}
