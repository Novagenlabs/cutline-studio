# Cutline Studio — accounts, credits, paid export

Backend for user accounts, a credit balance, and **server-side generation of
the paid cut files**. Next.js + Prisma + Postgres + Stripe, matching the stack
already used in novacrm.

## Status

**Scaffold, not deployed.** The credit ledger, export authorisation, Stripe
checkout and webhook, and the export route are written. What is NOT done:

- `src/lib/raster-server.ts` (PNG via `@napi-rs/canvas`) is imported but not written
- the shared `@cutline/pipeline` package alias does not exist yet — today the
  export builders live in the client's `src/export/`, and they must be moved to
  a package both sides import so the server and preview can never disagree
- no `package.json`, `next.config`, sign-in pages, or account UI
- the client still exports locally (see "Client changes still required")
- **the database tests have never been run** — there is no Postgres on this
  machine. `test/credits.test.ts` is written against a real database on purpose;
  run it before trusting any claim below.

## Setup

```sh
createdb cutline
export DATABASE_URL=postgresql://localhost/cutline
npx prisma db push
npx vitest run          # requires DATABASE_URL
```

Environment: `DATABASE_URL`, `AUTH_SECRET`, `APP_URL`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, plus Google OAuth or SMTP for sign-in.

## How payment is actually enforced

The important decision: **the browser never generates the paid file.** It
computes the preview (fast, local, unchanged) and sends the cut geometry to
`POST /api/export`, which charges a credit and returns the file. Client-side
credit checks were considered and rejected — if the browser can build the
artifact, the user already has it, and any check in front of that is a
formality that DevTools removes in seconds.

Credits are an **append-only ledger**, not a counter. Balance is `SUM(amount)`.
A counter that is read, decided on, and written back is the classic
double-spend shape under concurrency, and a paid product has to be able to
explain a balance months later.

Spending is a two-step: an `ExportToken` is issued (bound to the exact request
by a canonical hash), the file is rendered, then the token is redeemed inside
one `Serializable` transaction that re-checks the balance and writes both the
`Download` row and the negative ledger entry. Consequences:

- a render that crashes never costs a credit (the token just goes unredeemed)
- concurrent redemptions of one token settle as exactly one spend
- a token cannot be moved to a bigger job, another user, or replayed

Purchases are keyed on the Stripe session id, so at-least-once webhook
delivery cannot grant twice. Credits are granted **only** from the
signature-verified webhook — never from the browser hitting a success URL,
which is just a link anyone can visit.

## Watermarking: what it does and does not do

Requested to stop screenshots. It cannot, and nothing in the payment path
relies on it. Anything visible can be photographed.

It is still worth having, for a narrower reason: it makes the free preview
obviously unfit for production so honest users buy a credit. The real
protection is that **a screenshot is worthless to a cutting plotter** — the
value is in the vector geometry, and that only ever comes from the server
after a credit is spent.

Paid files carry no visible watermark (customers are paying for a clean file)
but do carry the download id in metadata, so a leaked file traces back to the
account that bought it. A determined party can strip that; the alternative is
degrading every honest customer's file, which is worse.

## Client changes still required

1. Replace the local `download()` calls in `src/main.ts` with a `POST` to
   `/api/export`, and stream the response to the user.
2. Delete nothing from `src/export/` — move it to the shared package so both
   sides render identically.
3. Show balance, sign-in, and a buy-credits path in the UI.
4. Keep the preview local. That is the product's speed and its privacy claim.

## Privacy

The README currently promises "no uploads leave the machine". That stops being
true for paid PDF/PNG export, which must embed the raster. The chosen
behaviour: preview and tracing stay entirely local, and artwork is sent **only
at the moment of a paid download**, held in memory for the render, never
written to disk. SVG and DXF need only the geometry, so artwork never leaves
the machine for those. The README must be updated to say exactly this before
launch — the current sentence would become false advertising.
