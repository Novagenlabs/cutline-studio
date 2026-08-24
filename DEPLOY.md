# Deploying to Dokploy

One app: Next serves the cutter at `/`, the account at `/account`, and the API
at `/api/*`. The Dockerfile builds everything; there is no separate front-end
container and no nginx in front of it.

## Environment variables

All of these go in Dokploy's **Environment** tab for the application.

### Required

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string. The pooled URL is fine — verified against both endpoints. |
| `AUTH_SECRET` | Signs session cookies. Generate with `npx auth secret` or `openssl rand -base64 32`. **Must differ from the development value**, and changing it later signs everyone out. |
| `APP_URL` | The public origin, e.g. `https://cutline.novagenlabs.ai`. Stripe redirects back here after checkout, so a wrong value strands buyers. No trailing slash. |
| `AUTH_URL` | Same value as `APP_URL`. Auth.js builds its callback URLs from this. (`trustHost` is set in code, so this is belt-and-braces rather than the only thing standing between you and a broken sign-in.) |
| `AUTH_GOOGLE_ID` | Google OAuth client id. Read by name — the provider is configured as bare `Google`. |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret. |
| `STRIPE_SECRET_KEY` | `sk_live_...` in production. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` from the webhook endpoint you create below. **Credits are granted only by the webhook**, so if this is wrong, payments succeed and nobody gets credits. |

### Optional

| Variable | What it is |
|---|---|
| `EMAIL_SERVER` | SMTP URL, only if you want email magic-link sign-in alongside Google. |
| `EMAIL_FROM` | Sender address for those emails. Both must be set or neither — the provider is skipped unless both are present. |

`NODE_ENV=production` is set by the Dockerfile; Dokploy does not need it.

## Before the first deploy

**1. Create the database tables.** The build runs `prisma generate`, not
`prisma db push` — generating a client is safe to repeat, but changing a live
schema on every deploy is not. Run once against production:

```sh
DATABASE_URL="<your neon url>" npx prisma db push
```

**2. Add the production redirect URI to Google.** In Cloud Console → Clients,
on the same OAuth client, add under **Authorised redirect URIs**:

```
https://<your domain>/api/auth/callback/google
```

and under **Authorised JavaScript origins**:

```
https://<your domain>
```

The path must match exactly; a trailing slash or `http` gives
`redirect_uri_mismatch` at sign-in.

**3. Create the Stripe webhook.** In the Stripe dashboard, add an endpoint at:

```
https://<your domain>/api/stripe/webhook
```

subscribed to `checkout.session.completed`. Copy its signing secret into
`STRIPE_WEBHOOK_SECRET`. Test-mode and live-mode endpoints have different
secrets — using the wrong one means every webhook fails signature
verification and no credits are ever granted.

**4. Publish the OAuth consent screen** if it is still in Testing mode, or only
accounts on the test-user list can sign in.

## After deploying

- `https://<domain>/` — the cutter, with the credit pill in the top bar
- `https://<domain>/api/me` — should return JSON; `signedIn:false` when logged out
- Sign in, then buy the smallest pack in Stripe **test** mode first and confirm
  the balance increases. That exercises the one path that cannot be tested
  locally without real keys.

## Notes

- `.env` is gitignored and is not in the image. Everything above must be set in
  Dokploy, not in the repo.
- The app listens on **3000**.
- `@napi-rs/canvas` is a native module, which is why the image ships
  `node_modules` rather than a standalone bundle. It only affects PNG export.
- Cross-origin isolation headers are applied to the cutter and to
  `/signin-done` (so the sign-in popup can talk back), and deliberately not to
  `/api/auth/*`. If you put a CDN or proxy in front that strips or rewrites
  response headers, AI matting loses multithreading and sign-in can break.
