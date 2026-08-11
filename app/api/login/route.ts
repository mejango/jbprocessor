import { requestMagicLink } from "../../../src/account/login.js";
import { getPool } from "../../../src/db/index.js";
import { readRequestFields } from "../fields.js";

/**
 * Starts a login. Always succeeds, whatever the address: telling a caller
 * "no such account" would turn this endpoint into a way to ask whether a given
 * person has donated.
 *
 * Serves both callers of the same handler: the no-JavaScript form on /login
 * (which wants a redirect back to a "check your email" page) and a programmatic
 * client (which wants JSON).
 */
export async function POST(request: Request): Promise<Response> {
  const { fields, isForm } = await readRequestFields(request);
  const email = fields.email ?? "";

  await requestMagicLink({ pool: getPool() }, email);

  if (isForm) {
    return Response.redirect(new URL("/login?sent=1", request.url), 303);
  }
  return Response.json({ ok: true });
}
