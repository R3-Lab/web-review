import type { Metadata } from "next";
import type { ReactNode } from "react";

// Global stylesheets must be imported from the root layout in the App
// Router — see globals.css's own header for why it's split from the
// package's stylesheet.
import "./globals.css";
import "@r3lab/web-review/styles.css";

import { ReviewMount } from "./review-mount";

export const metadata: Metadata = {
  title: "@r3lab/web-review — demo",
  description: "Example Next.js app demonstrating the review overlay against a real Postgres database.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ReviewMount />
      </body>
    </html>
  );
}
