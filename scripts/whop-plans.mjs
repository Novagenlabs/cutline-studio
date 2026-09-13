/**
 * Create or check the Whop plans behind the credit packs.
 *
 *   node scripts/whop-plans.mjs          # check: compare Whop against PACKS
 *   node scripts/whop-plans.mjs --create # create any pack that has no plan
 *
 * Each pack in src/lib/packs.ts is sold as a hidden, one-time Whop plan.
 * Hidden because they are sold from our own dialog rather than the Whop
 * storefront; one-time because a renewal plan would quietly subscribe someone
 * who meant to buy a pack once.
 *
 * Run the check after changing a price. Whop charges what its plan says, not
 * what PACKS says, so a drift between the two means the buyer is charged one
 * number while the dialog promised another — which the check catches and no
 * test can, because the truth lives in Whop.
 *
 * Creating is idempotent: a pack whose plan already exists is skipped, so
 * re-running never produces duplicate plans.
 */
import { readFileSync } from 'node:fs';
import { PACKS } from '../src/lib/packs.ts';

const ACCOUNT = 'biz_jvwbsoOnkhNZxW';
const CREATE = process.argv.includes('--create');

function apiKey() {
  if (process.env.WHOP_API_KEY) return process.env.WHOP_API_KEY;
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const m = env.match(/^WHOP_API_KEY\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1];
  } catch {
    /* fall through to the error below */
  }
  console.error('WHOP_API_KEY is not set (env or .env).');
  process.exit(1);
}

const H = {
  Authorization: `Bearer ${apiKey()}`,
  'Api-Version-Date': '2026-09-11-1',
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

const listed = await fetch(`https://api.whop.com/api/v1/plans?account_id=${ACCOUNT}`, {
  headers: H,
}).then((r) => r.json());
const byId = new Map((listed.data ?? []).map((p) => [p.id, p]));

let problems = 0;
for (const [id, pack] of Object.entries(PACKS)) {
  const plan = byId.get(pack.whopPlanId);

  if (!plan) {
    if (!CREATE) {
      console.log(`✗ ${id}: no plan ${pack.whopPlanId} on Whop — run with --create`);
      problems++;
      continue;
    }
    const res = await fetch('https://api.whop.com/api/v1/plans', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        account_id: ACCOUNT,
        plan_type: 'one_time',
        release_method: 'buy_now',
        visibility: 'hidden',
        currency: 'usd',
        initial_price: pack.amount / 100,
        product: {
          title: `Credits · ${pack.label}`,
          description: `${pack.credits} export credits for Cutline Studio`,
        },
        metadata: { pack: id, credits: String(pack.credits) },
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.log(`✗ ${id}: create failed (${res.status}) ${text.slice(0, 200)}`);
      problems++;
      continue;
    }
    const created = JSON.parse(text);
    console.log(`+ ${id}: created ${created.id} — put this in src/lib/packs.ts`);
    continue;
  }

  // The checks that matter: the price the buyer is charged, and that this is
  // not secretly a subscription.
  const expected = pack.amount / 100;
  const ok = [];
  if (plan.plan_type !== 'one_time') ok.push(`plan_type is ${plan.plan_type}, want one_time`);
  if (Number(plan.initial_price) !== expected)
    ok.push(`price is $${plan.initial_price}, PACKS says $${expected}`);
  if (Number(plan.renewal_price ?? 0) !== 0) ok.push(`renews at $${plan.renewal_price}`);

  if (ok.length) {
    console.log(`✗ ${id} (${pack.whopPlanId}): ${ok.join('; ')}`);
    problems++;
  } else {
    console.log(`✓ ${id} (${pack.whopPlanId}): one-time $${expected}, ${pack.credits} credits`);
  }
}

process.exit(problems ? 1 : 0);
