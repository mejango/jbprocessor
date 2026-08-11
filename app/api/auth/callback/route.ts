import { completeLogin } from "../../../../src/account/login.js";
import { sessionSetCookie } from "../../../../src/auth/magic.js";
import { getPool } from "../../../../src/db/index.js";

/**
 * The landing point of a magic link. Spends the token, sets the session
 * cookie, and sends the payer to their account.
 *
 * Failures are deliberately indistinguishable to the payer -- expired,
 * forged, and already-clicked all land on the same "that link didn't work"
 * page, and the token itself is never echoed back or logged.
 */
export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const email = await completeLogin({ pool: getPool() }, token);

  if (!email) {
    return Response.redirect(new URL("/login?error=1", request.url), 303);
  }

  return new Response(null, {
    status: 303,
    headers: {
      Location: new URL("/account", request.url).toString(),
      "Set-Cookie": sessionSetCookie(email),
    },
  });
}
