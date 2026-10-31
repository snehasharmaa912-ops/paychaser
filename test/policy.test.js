import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAmount, validateInstallments, clampPromiseDays, DEFAULT_POLICY } from '../src/policy.js';
import { toCents } from '../src/money.js';

test('splitAmount always sums exactly to the total', () => {
  for (const total of [10001, 33333, 99999, 5000, 12345]) {
    for (const parts of [2, 3, 4]) {
      for (const pct of [30, 50, 80]) {
        const amounts = splitAmount(total, parts, pct);
        assert.equal(amounts.length, parts);
        assert.equal(amounts.reduce((a, b) => a + b, 0), total);
        assert.ok(amounts.every((a) => a > 0));
      }
    }
  }
});

test('a reasonable request passes through unchanged', () => {
  const r = validateInstallments({ installments: 2, firstPaymentPercent: 50 }, '200.00', '2026-11-02');
  assert.equal(r.ok, true);
  assert.deepEqual(r.adjustments, []);
  assert.deepEqual(r.plan.map((p) => p.amount), ['100.00', '100.00']);
  assert.equal(r.plan[0].dueDate, '2026-11-05');
});

test('excessive requests are clamped and the change is recorded', () => {
  const r = validateInstallments({ installments: 12, firstPaymentPercent: 5 }, '300.00', '2026-11-02');
  assert.equal(r.ok, true);
  assert.equal(r.parts, DEFAULT_POLICY.maxInstallments);
  assert.equal(r.firstPaymentPercent, DEFAULT_POLICY.minFirstPaymentPct);
  assert.equal(r.adjustments.length, 2);
  assert.equal(r.plan.reduce((s, p) => s + toCents(p.amount), 0), 30000);
});

test('the final installment never lands beyond the allowed span', () => {
  const r = validateInstallments({ installments: 3 }, '900.00', '2026-11-02');
  const last = r.plan[r.plan.length - 1].dueDate;
  const spanEnd = new Date(Date.parse('2026-11-02T00:00:00Z') + DEFAULT_POLICY.spanDays * 86_400_000);
  assert.ok(Date.parse(`${last}T00:00:00Z`) <= spanEnd.getTime());
});

test('small invoices are not split', () => {
  const r = validateInstallments({ installments: 2 }, '20.00', '2026-11-02');
  assert.equal(r.ok, false);
});

test('garbage input falls back to a safe two-part plan', () => {
  const r = validateInstallments({ installments: 'lots', firstPaymentPercent: -4 }, '100.00', '2026-11-02');
  assert.equal(r.ok, true);
  assert.equal(r.parts, 2);
  assert.ok(r.firstPaymentPercent >= DEFAULT_POLICY.minFirstPaymentPct);
});

test('promise days are clamped', () => {
  assert.equal(clampPromiseDays(3), 3);
  assert.equal(clampPromiseDays(90), DEFAULT_POLICY.maxPromiseDays);
  assert.equal(clampPromiseDays(null), 5);
});
