import Script from 'next/script';

/**
 * Scoped to /checkout so Whop's loader is fetched by the one page that needs
 * it, rather than on every visit to the studio or the account page.
 *
 * `afterInteractive` rather than `beforeInteractive`: the embed replaces a
 * div that React has to render first, and a script that runs before hydration
 * finds nothing to attach to.
 */
export default function CheckoutLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`@keyframes cutline-spin { to { transform: rotate(360deg); } }`}</style>
      <Script
        src="https://js.whop.com/static/checkout/loader.js"
        strategy="afterInteractive"
      />
      {children}
    </>
  );
}
