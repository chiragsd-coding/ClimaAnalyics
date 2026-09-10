import { createFileRoute, redirect } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Nav } from "~/components/Nav";
import { Alert, Logo, Spinner } from "~/components/ui";
import { getSessionUserFn } from "~/lib/server/queries";

export const Route = createFileRoute("/register")({
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next:
      typeof search.next === "string" && search.next.startsWith("/") && !search.next.startsWith("//")
        ? search.next
        : undefined,
  }),
  beforeLoad: async () => {
    const { user } = await getSessionUserFn();
    if (user) throw redirect({ to: "/dashboard" });
  },
  component: RegisterPage,
});

function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (password.length < 10) {
      setError("Password must be at least 10 characters.");
      setBusy(false);
      return;
    }
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Registration failed.");
        return;
      }
      window.location.href = "/dashboard";
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
            <h1 className="text-xl font-bold tracking-tight text-slate-900">Create your account</h1>
            <p className="mt-1 mb-6 text-sm text-slate-500">
              Every account can explore the Downtown Miami demo area right away.
            </p>
            <form onSubmit={submit} className="space-y-4">
              {error && <Alert kind="error">{error}</Alert>}
              <div>
                <label htmlFor="name" className="label">
                  Full name
                </label>
                <input
                  id="name"
                  type="text"
                  autoComplete="name"
                  required
                  className="input"
                  placeholder="Ada Lovelace"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="email" className="label">
                  Work email
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
                  autoComplete="new-password"
                  required
                  minLength={10}
                  className="input"
                  placeholder="At least 10 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <button type="submit" disabled={busy} className="btn-primary w-full">
                {busy && <Spinner />}
                Create account
              </button>
            </form>
          </div>
          <p className="mt-6 text-center text-sm text-slate-600">
            Already have an account?{" "}
            <Link to="/login" className="font-semibold text-brand-700 hover:text-brand-800">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
