import { toCents, fromCents } from './money.js';
import { addDays } from './dates.js';
export const DEFAULT_POLICY = Object.freeze({
  maxInstallments: 3,
  minFirstPaymentPct: 30,
  maxFirstPaymentPct: 80,
  spanDays: 45, 
  firstDueInDays: 3,
  minAmountToSplit: 50, 
  maxPromiseDays: 14, 
  maxReminders: 4, 
  reminderCooldownDays: 3,
});
export function splitAmount(totalCents, parts, firstPct) {
  const first = Math.round((totalCents * firstPct) / 100);
  const rest = totalCents - first;
  const each = Math.floor(rest / (parts - 1));
  const amounts = [first];
  for (let i = 1; i < parts; i += 1) {
    amounts.push(i === parts - 1 ? rest - each * (parts - 2) : each);
  }
  return amounts;
}
export function validateInstallments(request, total, today, policy = DEFAULT_POLICY) {
  const totalCents = toCents(total);
  if (totalCents < policy.minAmountToSplit * 100) {
    return { ok: false, reason: `Invoices under ${policy.minAmountToSplit} are not split.` };
  }
  const adjustments = [];
  let parts = Math.trunc(Number(request?.installments));
  if (!Number.isFinite(parts) || parts < 2) parts = 2;
  if (parts > policy.maxInstallments) {
    adjustments.push(`Limited to ${policy.maxInstallments} installments (client asked for ${parts}).`);
    parts = policy.maxInstallments;
  }
  let pct = Number(request?.firstPaymentPercent);
  if (!Number.isFinite(pct) || pct <= 0) pct = Math.max(policy.minFirstPaymentPct, Math.ceil(100 / parts));
  if (pct < policy.minFirstPaymentPct) {
    adjustments.push(`First payment raised to ${policy.minFirstPaymentPct}% (client asked for ${pct}%).`);
    pct = policy.minFirstPaymentPct;
  }
  if (pct > policy.maxFirstPaymentPct) pct = policy.maxFirstPaymentPct;
  const spacing = Math.max(1, Math.min(14, Math.floor((policy.spanDays - policy.firstDueInDays) / (parts - 1))));
  const amounts = splitAmount(totalCents, parts, pct);
  const plan = amounts.map((cents, i) => ({
    label: `Installment ${i + 1} of ${parts}`,
    amount: fromCents(cents),
    dueDate: addDays(today, policy.firstDueInDays + i * spacing),
  }));
  return { ok: true, plan, adjustments, parts, firstPaymentPercent: pct };
}
export function clampPromiseDays(days, policy = DEFAULT_POLICY) {
  const n = Math.trunc(Number(days));
  if (!Number.isFinite(n) || n < 1) return Math.min(5, policy.maxPromiseDays);
  return Math.min(n, policy.maxPromiseDays);
}
