import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Co-Prompt Studio | Multiplayer AI Engineering",
  description:
    "A collaborative workspace for testing and comparing AI prompts.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
