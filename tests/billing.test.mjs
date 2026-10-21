// Pricing: margin, plan allowances, 4K streaming and account discounts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceUsage, DEFAULT_RATES } from '../api/_billing.js';

const usage = (o = {}) => ({ storedMinutes: 0, deliveredMinutes: 0, delivered4KMinutes: 0, newMinutes: 0, liveMinutes: 0, fileBytes: 0, ...o });
const line = (p, key) => p.lines.find(l => l.key === key);

test('usage is priced at cost plus the margin', () => {
  const p = priceUsage(usage({ storedMinutes: 1000 }), DEFAULT_RATES, null);
  assert.equal(line(p, 'videoStorage').amount, 1000 * DEFAULT_RATES.videoStorage * (1 + DEFAULT_RATES.margin));
});

test('a plan\'s included minutes are not charged', () => {
  const plan = { price: 249, included: { storedMinutes: 10000, deliveredMinutes: 25000, fileGB: 1000 } };
  const p = priceUsage(usage({ storedMinutes: 9000, deliveredMinutes: 20000 }), DEFAULT_RATES, plan);
  assert.equal(p.usageTotal, 0);
  assert.equal(p.total, 249);
});

test('a discount comes off usage, never off the plan', () => {
  const plan = { price: 249, included: { storedMinutes: 0, deliveredMinutes: 0, fileGB: 0 } };
  const full = priceUsage(usage({ storedMinutes: 20000 }), DEFAULT_RATES, plan);
  const off = priceUsage(usage({ storedMinutes: 20000 }), DEFAULT_RATES, plan, 25);
  assert.equal(off.usageTotal, Math.round(full.usageTotal * 0.75 * 100) / 100);
  assert.equal(off.planAmount, 249);
  assert.equal(off.discount, 25);
  assert.equal(priceUsage(usage({ storedMinutes: 20000 }), DEFAULT_RATES, plan, 150).usageTotal, 0, 'capped at 100%');
  assert.equal(priceUsage(usage({ storedMinutes: 20000 }), DEFAULT_RATES, plan, -5).usageTotal, full.usageTotal, 'never below 0%');
});

test('4K streaming is its own line at its own rate, sharing the plan allowance', () => {
  const plan = { price: 249, included: { deliveredMinutes: 25000 } };
  const p = priceUsage(usage({ deliveredMinutes: 30000, delivered4KMinutes: 10000 }), DEFAULT_RATES, plan);
  const hd = line(p, 'videoDelivery'), k4 = line(p, 'videoDelivery4K');
  assert.equal(hd.quantity, 20000);
  assert.equal(k4.quantity, 10000);
  assert.ok(Math.abs(hd.billable + k4.billable - 5000) < 0.02, 'only the 5,000 minutes above the plan are billed');
  assert.equal(k4.rate, DEFAULT_RATES.videoDelivery4K);
});

test('no 4K line when nothing was watched in 4K', () => {
  const p = priceUsage(usage({ deliveredMinutes: 100 }), DEFAULT_RATES, null);
  assert.equal(line(p, 'videoDelivery4K'), undefined);
});
