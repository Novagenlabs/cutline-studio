export const metadata = {
  title: 'Cutline Studio',
  description: 'Accounts, credits, and paid cut-file export.',
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
