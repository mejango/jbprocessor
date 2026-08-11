/**
 * Reads a request body as flat string fields, accepting either JSON or an
 * HTML form post. Every donor-facing page here works without JavaScript, so
 * each write endpoint has to answer a plain `<form>` as well as a fetch --
 * and the two want different success responses, hence `isForm`.
 *
 * A body that doesn't parse yields no fields rather than throwing: the
 * handlers all validate what they need anyway, and a 400 with their own
 * message beats an unhandled parse error.
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
        if (typeof value === "string") fields[key] = value;
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
