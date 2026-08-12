/**
 * Reads a request body as flat string fields, accepting either JSON or an
 * HTML form post. Every donor-facing page here works without JavaScript, so
 * each write endpoint has to answer a plain `<form>` as well as a fetch --
 * and the two want different success responses, hence `isForm`.
 *
 * JSON numbers and booleans are stringified rather than dropped: `amountUsd`
 * and `instant` are naturally a number and a boolean to a JSON caller and
 * strings to an HTML form, and every handler validates from the string form
 * anyway.
 *
 * A body that doesn't parse yields no fields rather than throwing: the
 * handlers all validate what they need anyway, and a 400 with their own
 * message beats an unhandled parse error.
 *
 * This is the only body reader in the service. Both the route handlers under
 * `app/api/` and the ones under `src/http/` call it -- two near-identical
 * copies is how a hardening fix lands on one endpoint and not the other.
 */
export async function readRequestFields(
  request: Request,
): Promise<{ fields: Record<string, string>; isForm: boolean }> {
  const contentType = request.headers.get("content-type") ?? "";
  const fields: Record<string, string> = {};

  if (contentType.includes("application/json")) {
    try {
      const body = (await request.json()) as Record<string, unknown> | null;
      for (const [key, value] of Object.entries(body ?? {})) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          fields[key] = String(value);
        }
      }
    } catch {
      // Leave `fields` empty; the handler reports what's missing.
    }
    return { fields, isForm: false };
  }

  try {
    const form = await request.formData();
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") fields[key] = value;
    }
  } catch {
    // Same: an unreadable body is an empty one.
  }
  return { fields, isForm: true };
}
