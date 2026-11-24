import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'SnapSelect', description: 'Simple photo culling from your SD card' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-200 antialiased">{children}</body>
    </html>
  );
}
