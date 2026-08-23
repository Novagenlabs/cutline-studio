# Cutline Studio — accounts, credits, paid export

Backend for user accounts, a credit balance, and **server-side generation of
the paid cut files**. Next.js + Prisma + Postgres + Stripe, matching the stack
already used in novacrm.

## Status

**Scaffold, not deployed.** The credit ledger, export authorisation, Stripe
checkout and webhook, and the export route are written. What is NOT done:

- the client still exports locally (see "Client changes still required")
- Stripe has never been exercised against real keys; only the ledger logic
  behind the webhook is tested
- Google OAuth needs real credentials to sign in through the UI; the e2e test
  inserts a Session row directly instead

Done and verified (35 tests passing):

- the credit ledger, against a real Neon Postgres — double-spend, the
  concurrent-redemption race, overdraw across parallel exports, expired and
  cross-user tokens, Stripe webhook replay, spend-to-file traceability
- server-side rendering of all four formats through the SHARED client
  builders, so a paid file cannot differ from the approved preview
- PNG framing pinned to the client's arithmetic by test, since that one piece
  is necessarily duplicated (a Node canvas cannot be driven through the DOM
  canvas API)
- the paywall end to end over HTTP against the running app: no session gets
  401, no credits gets 402 with no file, a credited user gets the file and is
  charged exactly one, and the balance never goes negative

## Do exports need a job queue?

No. Measured on the Feel at Home logo (3166x940, 32 contours): SVG 0ms, DXF
0ms, PNG 63ms, PDF 128ms warm. That fits inside an ordinary HTTP request. A
queue would add a job table, a worker, polling or websockets, and a "your file
is ready" flow to make a 130ms operation asynchronous.

Revisit it if any of these change: very large artwork pushing PDF/PNG past a
few seconds, a platform request timeout shorter than a render, or a batch
feature that exports many files at once. The first sign will be the p95 of the
export route, so measure that before building anything.

## Setup

```sh
cp .env.example .env    # fill in DATABASE_URL (Neon pooled URL is fine)
npm install
npx prisma db push
npm test                # 20 tests, ~75s against a hosted database
```

Note `npm test` needs `DATABASE_URL` exported or present in the environment —
Prisma reads `.env` relative to the working directory, so run it from `server/`.

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
