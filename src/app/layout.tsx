import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import "./layout.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AWS Local Console",
  description: "Local AWS resource management console",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <nav className="navbar">
          <Link href="/" className="navbar-brand">
            AWS Console
          </Link>
          <div className="navbar-links">
            <Link href="/" className="nav-link">
              Home
            </Link>
            <Link href="/dashboard" className="nav-link">
              Dashboard
            </Link>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
