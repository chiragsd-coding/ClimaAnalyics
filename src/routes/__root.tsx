import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "ClimaScope — Street-level climate risk analytics" },
      {
        name: "description",
        content:
          "Score every structure in your area of interest for climate risk, 1–5, with hazard models matched to the local climate. Built for insurers, municipalities, and portfolio managers.",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  notFoundComponent: () => <NotFound />,
  component: RootComponent,
});

function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-6xl font-bold text-slate-200">404</p>
      <h1 className="text-xl font-semibold text-slate-900">Page not found</h1>
      <a href="/" className="btn-secondary">
        Back to home
      </a>
    </main>
  );
}

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
