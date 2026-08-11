export const dynamic = "force-dynamic";

interface LoginPageProps {
  searchParams: Promise<{ sent?: string; error?: string }>;
}

/**
 * The whole login surface. No password, no wallet connection: the payer types
 * the address they paid with and clicks a link in their mail.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { sent, error } = await searchParams;

  if (sent) {
    return (
      <>
        <h1>Check your email</h1>
        <p className="lede">
          If that address has made a donation, a sign-in link is on its way. The link works
          once, and expires in 15 minutes.
        </p>
        <p className="muted">
          Nothing arrived? <a href="/login">Ask for another link</a>.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Your donations</h1>
      <p className="lede">
        Sign in with the email address you used to donate. We will send you a link -- there is
        no password.
      </p>

      {error ? (
        <p className="notice problem">
          That link did not work. Links expire after 15 minutes and can only be used once.
        </p>
      ) : null}

      <form className="stack" method="post" action="/api/login">
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          aria-label="Email address"
        />
        <button type="submit">Email me a link</button>
      </form>
    </>
  );
}
