import { handleLoginRequest, liveLoginDeps } from "../../../src/http/login.js";

/**
 * Starts a login. Always succeeds, whatever the address: telling a caller
 * "no such account" would turn this endpoint into a way to ask whether a given
 * person has donated.
 *
 * The handler itself lives in `src/http/login.ts` so it can be tested as a
 * plain `Request -> Response` function; this file is only the binding to the
 * live pool.
 */
export async function POST(request: Request): Promise<Response> {
  return handleLoginRequest(liveLoginDeps(), request);
}
