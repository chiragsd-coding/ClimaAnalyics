import { createFileRoute, redirect } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Nav } from "~/components/Nav";
import { Alert, Logo, Spinner } from "~/components/ui";
import { getSessionUserFn } from "~/lib/server/queries";

type LoginSearch = { next?: string };

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    next:
      typeof search.next === "string" && search.next.startsWith("/") && !search.next.startsWith("//")
        ? search.next
        : undefined,
  }),
  beforeLoad: async ({ search }) => {
    const { user } = await getSessionUserFn();
    if (user) throw redirect({ to: search.next ?? "/dashboard" });
  },
  component: LoginPage,
});

function LoginPage() {
  const search = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Sign in failed.");
        return;
      }
      window.location.href = search.next ?? "/dashboard";
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col bg-slate-50">
      <Nav user={null} />
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex justify-center">
            <Logo />
          </div>
          <div className="card p-6 sm:p-8">
            <h1 className="text-xl font-bold tracking-tight text-slate-900">Sign in</h1>
            <p className="mt-1 mb-6 text-sm text-slate-500">
              Access your areas and the Downtown Miami demo.
            </p>
            <form onSubmit={submit} className="space-y-4">
              {error && <Alert kind="error">{error}</Alert>}
              <div>
                <label htmlFor="email" className="label">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  className="input"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="password" className="label">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  className="input"
                  placeholder="••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <button type="submit" disabled={busy} className="btn-primary w-full">
                {busy && <Spinner />}
                Sign in
              </button>
            </form>
          </div>
          <p className="mt-6 text-center text-sm text-slate-600">
            New to ClimaScope?{" "}
            <Link to="/register" className="font-semibold text-brand-700 hover:text-brand-800">
              Create an account
            </Link>{" "}
            — it unlocks the live demo area.
          </p>
        </div>
      </div>
    </main>
  );
}
