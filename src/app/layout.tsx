import type { Metadata } from 'next';

/**
 * Shared metadata for the Next-rendered pages (/account, /checkout).
 *
 * The studio itself is static HTML and carries its own tags in index.html —
 * it is the URL people actually paste, so its preview is written by hand
 * there rather than generated here.
 *
 * The old description said "Accounts, credits, and paid cut-file export",
 * which describes the plumbing rather than the product. A preview card is
 * read by someone who has never seen the site.
 */
const url = process.env.APP_URL ?? 'https://cutlinestudio.space';

export const metadata: Metadata = {
  metadataBase: new URL(url),
  title: 'Cutline Studio',
  description:
    'Print-and-cut contour lines, straight from your artwork. SVG, PDF and DXF with a CutContour spot colour.',
  openGraph: {
    type: 'website',
    siteName: 'Cutline Studio',
    title: 'Cutline Studio',
    description: 'Print-and-cut contour lines, straight from your artwork.',
    url,
    images: [{ url: '/brand/og.png', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Cutline Studio',
    description: 'Print-and-cut contour lines, straight from your artwork.',
    images: ['/brand/og.png'],
  },
  icons: {
    icon: '/brand/icon-32.png',
    apple: '/brand/icon-180.png',
  },
  manifest: '/brand/site.webmanifest',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: '#0d0d10',
          color: '#e8e8ea',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        {children}
      </body>
    </html>
  );
}
