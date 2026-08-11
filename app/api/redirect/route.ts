import {
  liveRedirectEscrow,
  RedirectError,
  requestRedirect,
} from "../../../src/account/redirect.js";
import { sessionFromCookieHeader } from "../../../src/auth/magic.js";
import { publicClient, walletClient } from "../../../src/chain/client.js";
import { getPool } from "../../../src/db/index.js";
import { readRequestFields } from "../fields.js";

/**
 * Points a payment's escrowed tokens at a different address. Optional by
 * design: a payer who does nothing still receives their tokens at the address
 * recorded at checkout.
 *
 * `setBeneficiary` is an operator-only call, so this route can only work in a
 * deployment whose web process is configured with the escrow operator's key.
 * Where it isn't, the client pair throws and the answer is an honest 503
 * rather than a 500 -- the redirect is unavailable, not broken.
 */
export async function POST(request: Request): Promise<Response> {
  const { fields, isForm } = await readRequestFields(request);

  const sessionEmail = sessionFromCookieHeader(request.headers.get("cookie"));
  if (!sessionEmail) {
    return respond(request, isForm, 401, { error: "unauthorized" }, "/login");
  }

  const paymentId = fields.paymentId ?? "";
  const address = fields.address ?? "";

  let escrow;
  try {
    escrow = liveRedirectEscrow({
      publicClient: publicClient(),
      walletClient: walletClient(),
    });
  } catch {
    return respond(request, isForm, 503, { error: "redirect_unavailable" }, "/account");
  }

  try {
    const result = await requestRedirect(
      { pool: getPool(), escrow },
      { paymentId, address, sessionEmail },
    );
    return respond(request, isForm, 200, { ok: true, ...result }, "/account?redirected=1");
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
