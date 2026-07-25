/**
 * Unit tests — run: node tests.js
 */
import assert from 'assert';
import {
  detectShutterLife,
  shutterDepreciationFactor,
  platformFee,
  calcOffer,
  isStolenLocal,
  generateIdempotencyKey,
  normalizeSerial,
  PLATFORM_FEE_RATE,
  PLATFORM_FEE_FIXED,
} from './app.js';

// sliding window (mirror of worker logic)
function slidingWindowAllow(timestamps, now, limit = 10, windowMs = 60_000) {
  const pruned = timestamps.filter((t) => now - t < windowMs);
  if (pruned.length >= limit) {
    const oldest = Math.min(...pruned);
    return {
      allowed: false,
      retryAfter: Math.ceil((windowMs - (now - oldest)) / 1000),
      timestamps: pruned,
    };
  }
  pruned.push(now);
  return { allowed: true, timestamps: pruned };
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('Camera Trade Hub tests\n');

// Platform fee
test('platform fee 5% + 0.50', () => {
  const r = platformFee(100);
  assert.strictEqual(r.fee, 5.5);
  assert.strictEqual(r.net, 94.5);
});

test('platform fee zero amount', () => {
  const r = platformFee(0);
  assert.strictEqual(r.net, 0);
  assert.strictEqual(r.fee, PLATFORM_FEE_FIXED);
});

test('platform fee constants', () => {
  assert.strictEqual(PLATFORM_FEE_RATE, 0.05);
  assert.strictEqual(PLATFORM_FEE_FIXED, 0.5);
});

// Trade offer
test('calcOffer excellent no shutter', () => {
  const o = calcOffer({
    marketValue: 1000,
    condition: 'excellent',
    model: 'Unknown Body',
    shutterCount: null,
  });
  assert.strictEqual(o.tradeValue, 850);
  assert.strictEqual(o.shutterFactor, 1);
});

test('calcOffer mint full value almost', () => {
  const o = calcOffer({
    marketValue: 1000,
    condition: 'mint',
    model: 'X',
  });
  assert.strictEqual(o.tradeValue, 950);
});

test('calcOffer poor condition', () => {
  const o = calcOffer({ marketValue: 1000, condition: 'poor', model: 'X' });
  assert.strictEqual(o.tradeValue, 350);
});

// Stolen serial
test('stolen local SN12345678', () => {
  assert.strictEqual(isStolenLocal('SN12345678'), true);
});

test('stolen local case-insensitive', () => {
  assert.strictEqual(isStolenLocal('stolen999'), true);
});

test('clean serial not stolen', () => {
  assert.strictEqual(isStolenLocal('CLEAN12345'), false);
});

test('normalize serial', () => {
  assert.strictEqual(normalizeSerial(' sn 123 '), 'SN123');
});

// Idempotency key
test('idempotency key unique-ish', () => {
  const a = generateIdempotencyKey('payout');
  const b = generateIdempotencyKey('payout');
  assert.ok(a.startsWith('payout_'));
  assert.notStrictEqual(a, b);
});

// Sliding window
test('sliding window allows under limit', () => {
  const now = 1_000_000;
  let ts = [];
  for (let i = 0; i < 9; i++) {
    const r = slidingWindowAllow(ts, now + i * 100);
    assert.strictEqual(r.allowed, true);
    ts = r.timestamps;
  }
});

test('sliding window blocks at 10', () => {
  const now = 2_000_000;
  let ts = Array.from({ length: 10 }, (_, i) => now - 1000 + i);
  const r = slidingWindowAllow(ts, now, 10, 60_000);
  assert.strictEqual(r.allowed, false);
  assert.ok(r.retryAfter >= 1);
});

test('sliding window prunes old entries', () => {
  const now = 3_000_000;
  const ts = [now - 120_000, now - 90_000]; // outside 60s
  const r = slidingWindowAllow(ts, now, 10, 60_000);
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.timestamps.length, 1); // only `now` kept after prune+push
});

// Shutter depreciation
test('shutter factor 0 count is 1', () => {
  assert.strictEqual(shutterDepreciationFactor(0, 150_000), 1);
});

test('shutter factor mid-life between 0.45 and 1', () => {
  const f = shutterDepreciationFactor(75_000, 150_000);
  assert.ok(f < 1 && f > 0.45, `got ${f}`);
});

test('shutter factor floor at high count', () => {
  const f = shutterDepreciationFactor(500_000, 150_000);
  assert.ok(f >= 0.45 && f <= 0.55, `got ${f}`);
});

test('electronic shutter no penalty', () => {
  const life = detectShutterLife('Nikon Z9');
  assert.strictEqual(life.life, Infinity);
  const f = shutterDepreciationFactor(200_000, life.life);
  assert.strictEqual(f, 1);
});

// Model tiers
test('detect entry tier R50', () => {
  const t = detectShutterLife('Canon EOS R50');
  assert.strictEqual(t.tier, 'entry');
  assert.strictEqual(t.life, 100_000);
});

test('detect enthusiast R6', () => {
  const t = detectShutterLife('Canon EOS R6');
  assert.strictEqual(t.tier, 'enthusiast');
});

test('detect pro R5', () => {
  const t = detectShutterLife('Canon EOS R5');
  assert.strictEqual(t.tier, 'pro');
});

test('detect flagship A1', () => {
  const t = detectShutterLife('Sony A1');
  assert.strictEqual(t.tier, 'flagship');
});

test('model-aware offer lower for high shutter entry body', () => {
  const low = calcOffer({
    marketValue: 1000,
    condition: 'excellent',
    model: 'Canon EOS R50',
    shutterCount: 90_000,
  });
  const highLife = calcOffer({
    marketValue: 1000,
    condition: 'excellent',
    model: 'Sony A1',
    shutterCount: 90_000,
  });
  assert.ok(
    low.tradeValue < highLife.tradeValue,
    `entry ${low.tradeValue} should be < flagship ${highLife.tradeValue}`
  );
});

test('cash net applies fee', () => {
  const o = calcOffer({
    marketValue: 1000,
    condition: 'excellent',
    model: 'X',
    payout: 'cash',
  });
  // 850 - 5% - 0.50
  assert.strictEqual(o.tradeValue, 850);
  assert.strictEqual(o.cashFee, 43);
  assert.strictEqual(o.cashNet, 807);
});

console.log(`\n${passed} tests passed`);
