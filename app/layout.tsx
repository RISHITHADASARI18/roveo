import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Roveo — Travel together, better",
  description: "Roveo makes planning trips with friends simple, organized, and collaborative.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
