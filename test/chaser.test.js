import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChaser, fakePayPal, sampleInvoice } from './helpers.js';

const days = (n) => n * 86_400_000;

test('creates and sends an invoice through PayPal', async () => {
  const { chaser, paypal, store } = buildChaser();
  const inv = await chaser.createInvoice(sampleInvoice);
  assert.equal(inv.status, 'SENT');
  assert.equal(inv.dueDate, '2026-11-16');
  assert.deepEqual(paypal.calls.map((c) => c[0]), ['create', 'send']);
  assert.equal(store.allInvoices().length, 1);
});

test('sweep ignores invoices that are not overdue', async () => {
  const { chaser, paypal } = buildChaser();
  await chaser.createInvoice(sampleInvoice);
  const results = await chaser.sweep();
  assert.deepEqual(results, []);
  assert.equal(paypal.calls.filter((c) => c[0] === 'remind').length, 0);
});

test('sweep reminds an overdue invoice once, then respects the cooldown', async () => {
  const { chaser, paypal, clock } = buildChaser();
  const inv = await chaser.createInvoice(sampleInvoice);
  chaser.backdate(inv.id, 20);

  const first = await chaser.sweep();
  assert.equal(first[0].action, 'reminded');
  assert.equal(first[0].tone, 'friendly');
  assert.equal(paypal.calls.filter((c) => c[0] === 'remind').length, 1);

  const second = await chaser.sweep();
  assert.equal(second[0].action, 'skipped');

  clock.current = new Date(clock.current.getTime() + days(4));
  const third = await chaser.sweep();
  assert.equal(third[0].action, 'reminded');
  assert.equal(third[0].tone, 'firm');
});

test('dry run reports what it would do without calling PayPal', async () => {
  const { chaser, paypal } = buildChaser();
  const inv = await chaser.createInvoice(sampleInvoice);
  chaser.backdate(inv.id, 20);
  const results = await chaser.sweep({ dryRun: true });
  assert.equal(results[0].action, 'would_remind');
  assert.equal(paypal.calls.filter((c) => c[0] === 'remind').length, 0);
});

test('escalates to the human after the reminder limit', async () => {
  const { chaser, clock, store } = buildChaser();
  const inv = await chaser.createInvoice(sampleInvoice);
  chaser.backdate(inv.id, 30);
  for (let i = 0; i < 4; i += 1) {
    const r = await chaser.sweep();
    assert.equal(r[0].action, 'reminded');
    clock.current = new Date(clock.current.getTime() + days(4));
  }
  const last = await chaser.sweep();
  assert.equal(last[0].action, 'escalated');
  assert.equal(store.getInvoice(inv.id).flag, 'needs_human');
  const after = await chaser.sweep();
  assert.equal(after[0].action, 'skipped');
});

test('a payment made on PayPal is picked up by the next sweep', async () => {
  const { chaser, paypal, store } = buildChaser();
  const inv = await chaser.createInvoice(sampleInvoice);
  chaser.backdate(inv.id, 20);
  await chaser.sweep();
  paypal.remote[inv.id].status = 'PAID';
  const results = await chaser.sweep();
  assert.equal(results[0].action, 'paid');
  assert.equal(store.getInvoice(inv.id).status, 'PAID');
  assert.equal(store.getClient('asha@example.com').latePaidCount, 1);
});

test('a promise pauses reminders; a dispute stops them', async () => {
  const { chaser, store } = buildChaser();
  const a = await chaser.createInvoice(sampleInvoice);
  const b = await chaser.createInvoice({ ...sampleInvoice, clientEmail: 'ben@example.com', clientName: 'Ben Lee' });
  chaser.backdate(a.id, 20);
  chaser.backdate(b.id, 20);

  const promise = await chaser.handleReply(a.id, 'Sorry! I will pay by Friday');
  assert.equal(promise.applied.type, 'promise');
  const dispute = await chaser.handleReply(b.id, 'This is the wrong amount, I dispute it');
  assert.equal(dispute.applied.type, 'escalate');
  assert.equal(store.getInvoice(b.id).flag, 'disputed');

  const results = await chaser.sweep();
  assert.ok(results.every((r) => r.action === 'skipped'));
});

test('installments need approval, then replace the original invoice', async () => {
  const { chaser, paypal, store } = buildChaser();
  const inv = await chaser.createInvoice(sampleInvoice);
  chaser.backdate(inv.id, 20);

  const reply = await chaser.handleReply(inv.id, 'Can I pay half now and half later?');
  assert.equal(reply.intent, 'wants_installments');
  assert.equal(reply.proposal.status, 'pending');
  assert.equal(store.getInvoice(inv.id).status, 'SENT'); 
  assert.equal(paypal.calls.filter((c) => c[0] === 'cancel').length, 0);

  const { proposal, children, warning } = await chaser.approve(reply.proposal.id);
  assert.equal(warning, null);
  assert.equal(proposal.status, 'approved');
  assert.equal(children.length, 2);
  assert.deepEqual(children.map((c) => c.amount), ['100.00', '100.00']);
  assert.ok(children.every((c) => c.parentId === inv.id));
  assert.equal(store.getInvoice(inv.id).status, 'CANCELLED');

  await assert.rejects(chaser.approve(reply.proposal.id), /already approved/);
});

test('if creating installments fails midway, nothing is left dangling', async () => {
  const paypal = fakePayPal();
  const { chaser, store } = buildChaser({ paypal });
  const inv = await chaser.createInvoice(sampleInvoice);
  const reply = await chaser.handleReply(inv.id, 'Can I split this into 3 payments?');

  const realSend = paypal.sendInvoice.bind(paypal);
  let sends = 0;
  paypal.sendInvoice = async (id) => {
    sends += 1;
    if (sends === 2) throw new Error('PayPal is down');
    return realSend(id);
  };

  await assert.rejects(chaser.approve(reply.proposal.id), /Could not create/);
  assert.equal(store.getInvoice(inv.id).status, 'SENT'); 
  assert.equal(store.getProposal(reply.proposal.id).status, 'failed');
  const cancelled = store.allInvoices().filter((i) => i.parentId === inv.id && i.status === 'CANCELLED');
  const live = store.allInvoices().filter((i) => i.parentId === inv.id && i.status === 'SENT');
  assert.equal(live.length, 0);
  assert.ok(cancelled.length >= 1);
});

test('rejecting a proposal changes nothing on PayPal', async () => {
  const { chaser, paypal } = buildChaser();
  const inv = await chaser.createInvoice(sampleInvoice);
  const reply = await chaser.handleReply(inv.id, 'Could we do two payments?');
  const rejected = chaser.reject(reply.proposal.id);
  assert.equal(rejected.status, 'rejected');
  assert.equal(paypal.calls.filter((c) => c[0] === 'cancel').length, 0);
});

test('paid webhook marks the invoice paid and is idempotent', async () => {
  const { chaser, store } = buildChaser();
  const inv = await chaser.createInvoice(sampleInvoice);
  const event = { id: 'WH-1', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: inv.id } } };
  assert.deepEqual(await chaser.handleWebhook(event), { handled: 'paid', invoiceId: inv.id });
  assert.equal(store.getInvoice(inv.id).status, 'PAID');
  assert.deepEqual(await chaser.handleWebhook(event), { duplicate: true });
  assert.deepEqual(await chaser.handleWebhook({ id: 'WH-2', event_type: 'OTHER', resource: {} }), { ignored: true });
});

test('stats report outstanding, recovered money and days to pay', async () => {
  const { chaser, paypal, clock } = buildChaser();
  const a = await chaser.createInvoice(sampleInvoice);
  await chaser.createInvoice({ ...sampleInvoice, clientEmail: 'ben@example.com', clientName: 'Ben Lee', amount: '50.50' });
  chaser.backdate(a.id, 20);
  await chaser.sweep();
  clock.current = new Date(clock.current.getTime() + days(3));
  paypal.remote[a.id].status = 'PAID';
  await chaser.sweep();

  const s = chaser.stats();
  assert.equal(s.recovered, '200.00');
  assert.equal(s.outstanding, '50.50');
  assert.equal(s.remindersSent, 1);
  assert.equal(s.avgDaysFromFirstReminderToPaid, 3);
});
