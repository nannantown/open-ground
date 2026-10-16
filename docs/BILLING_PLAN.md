# Free / Pro / Owner billing

Implementation in `codex/productize-subscriptions` (2026-10-08). This replaces
this document's earlier deferred billing proposal. External deployment and live
payment acceptance are still required; see [PRODUCTIZATION_HANDOFF.md](./PRODUCTIZATION_HANDOFF.md).

| Plan | Price | Capability |
| --- | --- | --- |
| Free | ¥0 / month | Ground/projects, manual Board, ordinary Claude Code Terminal, usage and safety/backup controls |
| Pro | ¥2,980 / month | Free + AI Worker dispatch, monitoring/recovery and independent commander review |
| Owner | Existing administrator role | All capabilities, including Songs, Canvas, Research, custom tabs, WordPress/Skills, Assistant/Phone and experiments |

Claude usage is paid through the user's own Claude subscription, separately.
Pro initially supports macOS. Windows checkout is disabled until its Swarm guard,
SDK and packaged-app flows pass real Windows acceptance. Billing management and
cancellation remain accessible regardless of platform or lost Pro access.

## Trust boundary

- Reuse Supabase Google/GitHub PKCE login ([AUTH_SETUP.md](./AUTH_SETUP.md)). Free
  remains usable without signing in. Tokens stay in local `auth.json` (0600).
  Concurrent refreshes share one grant; a late refresh cannot resurrect sign-out.
  Failed persistence does not report successful login/sign-out.
- `worker/src/billing.ts` is a **separate** hosted billing Worker. It verifies
  Supabase ES256/RS256 JWTs against that project's JWKS. User IDs come only from
  the verified JWT, never from a Checkout return URL or request body.
- Stripe and Supabase service-role secrets exist only in the billing Worker.
  Electron includes only `OPENGROUND_BILLING_URL` and existing public auth config.
  Never bake service-role keys, Stripe keys or webhook secrets into runtime config.
  A shipped billing URL overrides the launch environment, using the existing
  collab destination lock so launch variables cannot redirect the token relay.
- `og_billing` maps one auth UID to a unique Stripe customer. RLS/revoked client
  privileges allow only the service role to read/write. Mapping must persist
  before Checkout is created. Existing customer/subscription/open-Checkout checks
  and Stripe idempotency prevent ordinary duplicate purchase requests.
- Checkout validates an active JPY 2,980 monthly price before taking payment.
  Reused open sessions must contain exactly one item for that same price.
  Card subscriptions only; there is no free trial or coupon promotion in this flow.
- `/state` and verified webhooks re-read current Stripe subscriptions. Event
  payloads never supply entitlement state or create user/customer mappings.
  The timestamp-conditional RPC rejects older overlapping snapshots. Webhook
  signature validation uses the raw body, HMAC-SHA256 and ±5 minute tolerance;
  request bodies are limited to 256 KiB. Upstream/storage errors return 503 so
  Stripe retries. Duplicates/reordered notifications repeat a canonical refresh.
- Active, quantity-one subscriptions for the configured price with a future
  period end grant Pro. Trial, paused, unpaid, past-due, expired or canceled
  states resolve Free. Scheduled cancellation retains access to the paid period
  end. Failed renewal pauses automation immediately after the next refresh.
- Local validated state is cached for at most 30 seconds per account/token;
  expiry is checked on cache hits. Network failure grants no stale paid access.
  Manual refresh and window focus update the UI after returning from Stripe.
- Revocation pauses dispatch, monitoring/recovery and automatic desk resumption.
  Existing jobs/data are retained; status and stop endpoints stay accessible.
  Free settings/local Swarm unlocks confer no Pro/Owner privilege.
- Owner continues to use `og_roles` and its documented local email override,
  independently of billing. Owner-only API middleware protects files and jobs;
  shared Canvas also requires App Owner at the cloud ticket issuer, in addition
  to project membership. A project-owner membership is not an App Owner role.

This is an open-source local client: it does not provide binary tamper-proof DRM.
Hosted payments/account mappings are verified independently of that client.

## Setup (test environment first)

1. Follow `AUTH_SETUP.md` for Supabase Google/GitHub providers, PKCE redirects and
   `og_roles` read policies. Enable an asymmetric JWT signing key (ES256/RS256)
   and verify the project's JWKS endpoint. Keep Owner grants service-role only;
   apply existing grant-hardening migration `0012_og_roles_revoke_anon_writes.sql` if applicable.
2. Review/apply `supabase/migrations/0016_billing.sql` to the chosen Supabase
   environment. It adds a table/RPC only and performs no local migration or
   deletion. Verify anon/authenticated cannot SELECT/INSERT/UPDATE/DELETE or call
   the snapshot RPC, and service_role can. Back up hosted data before deployment.
3. In Stripe **test mode**, create an active recurring price: JPY 2,980, one month,
   quantity one. Configure the Customer Portal for payment-method updates and
   cancellation at period end. Disable switching plans, quantity changes,
   promotions and trial offers for this product. Confirm tax configuration and
   the displayed final ¥2,980 match the intended consumer price.
4. With Node 22+, run `npm ci` in `worker/`, then use **this config on every
   command**, so the existing collaboration/Phone workers remain untouched:

   ```sh
   npx wrangler secret put SUPABASE_URL --config wrangler.billing.jsonc
   npx wrangler secret put SUPABASE_ANON_KEY --config wrangler.billing.jsonc
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config wrangler.billing.jsonc
   npx wrangler secret put STRIPE_SECRET_KEY --config wrangler.billing.jsonc
   npx wrangler secret put STRIPE_PRO_PRICE_ID --config wrangler.billing.jsonc
   npx wrangler secret put BILLING_RETURN_URL --config wrangler.billing.jsonc
   npx wrangler secret put STRIPE_WEBHOOK_SECRET --config wrangler.billing.jsonc
   npx wrangler deploy --config wrangler.billing.jsonc
   ```

   `BILLING_RETURN_URL` must be an HTTPS URL serving `landing/billing.html`, without
   an existing query/fragment. Use the matching test/live keys and price IDs;
   never pass secret values as command arguments or commit `.dev.vars`.
5. Register `https://<billing-worker>/webhook` in Stripe with events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `customer.subscription.created/updated/deleted`, `invoice.paid`,
   `invoice.payment_failed`. Copy its signing secret to the Worker. The Stripe
   API request version is pinned to `2025-06-30.basil` (item-level period ends).
6. Set `OPENGROUND_BILLING_URL=https://<billing-worker>` in the app build/runtime
   environment and run the standard build. Do not enable it in a public binary
   until hosted database privileges and all test-mode acceptance cases pass.
   Without it, Free works, purchasing is disabled, and local flags grant no Pro.
7. Confirm real test-mode signup → Checkout → return/focus/refresh → Pro →
   dispatch/review, portal cancellation → retained access until expiry → Free,
   failed renewal → Free → payment recovery → Pro. Include two devices/accounts,
   repeated Checkout clicks, webhook replay/delay, sign-out, reinstall/restart,
   network failures and subscription expiration while the app stays open.
8. Obtain release approval only after operator identity/contact, consumer sales
   disclosures, privacy/terms, price/tax/refund/dispute policy and real packaged
   Mac/Windows acceptance are reviewed. Switch to live-mode resources and re-run
   a controlled live payment/cancellation check before public rollout.

Refunds/disputes do not themselves cancel an active Stripe subscription. An
operator must follow the agreed refund/dispute policy and cancel/revoke through
Stripe when required. That business policy is an explicit remaining launch item.

Stripe references: [subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks),
[Checkout API](https://docs.stripe.com/api/checkout/sessions/create),
[Checkout line items](https://docs.stripe.com/api/checkout/sessions/line_items),
[Customer Portal API](https://docs.stripe.com/api/customer_portal/sessions/create),
[webhook endpoints](https://docs.stripe.com/events/manage-webhook-endpoints).
