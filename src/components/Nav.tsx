/** Top navigation bar. Auth-aware; the sign-out action calls the REST API. */
import { Link } from "@tanstack/react-router";
import { Logo, RoleBadge } from "~/components/ui";
import type { Role } from "~/lib/rbac";

export type NavUser = { name: string; role: Role } | null;

export function Nav({ user, active }: { user: NavUser; active?: "dashboard" | "home" }) {
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6">
        <div className="flex items-center gap-6">
          <Link to="/" aria-label="ClimaScope home">
            <Logo />
          </Link>
          {user && (
            <Link
              to="/dashboard"
              className={`text-sm font-medium ${
                active === "dashboard" ? "text-brand-800" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Dashboard
            </Link>
          )}
        </div>
        <div className="flex items-center gap-3">
          {user ? (
            <>
              <span className="hidden items-center gap-2 text-sm text-slate-700 sm:flex">
                <span className="font-medium">{user.name}</span>
                <RoleBadge role={user.role} />
              </span>
              <button type="button" onClick={() => void signOut()} className="btn-ghost">
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="btn-ghost">
                Sign in
              </Link>
              <Link to="/register" className="btn-primary">
                Create account
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
