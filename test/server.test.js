import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { buildChaser, fakePayPal, sampleInvoice } from './helpers.js';

async function start({ adminToken = '', demoMode = true, paypal = fakePayPal() } = {}) {
  const built = buildChaser({ paypal });
  const config = { adminToken, demoMode, currency: 'USD', ai: { model: 'test' } };
  const server = createServer({ config, chaser: built.chaser, paypal, ai: { configured: false } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };
  return { ...built, call, base, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('full flow over HTTP: invoice, overdue, reminder, reply, approval, payment', async (t) => {
  const app = await start();
  t.after(app.close);

  const created = await app.call('POST', '/api/invoices', sampleInvoice);
  assert.equal(created.status, 201);
  const id = created.json.id;

  assert.equal((await app.call('POST', `/api/invoices/${id}/backdate`, { days: 20 })).status, 200);

  const swept = await app.call('POST', '/api/sweep', {});
  assert.equal(swept.json.results[0].action, 'reminded');
  assert.equal(swept.json.stats.remindersSent, 1);

  const reply = await app.call('POST', `/api/invoices/${id}/replies`, { text: 'Can we do two payments?' });
  assert.equal(reply.json.intent, 'wants_installments');

  const pending = await app.call('GET', '/api/proposals');
  assert.equal(pending.json.length, 1);

  const approved = await app.call('POST', `/api/proposals/${reply.json.proposal.id}/approve`);
  assert.equal(approved.status, 200);
  assert.equal(approved.json.children.length, 2);

  const hook = await app.call('POST', '/api/webhooks/paypal', {
    id: 'WH-9',
    event_type: 'INVOICING.INVOICE.PAID',
    resource: { invoice: { id: approved.json.children[0].id } },
  });
  assert.equal(hook.json.handled, 'paid');

  const stats = await app.call('GET', '/api/stats');
  assert.equal(stats.json.recovered, '100.00');
  assert.equal((await app.call('GET', '/api/events')).json.length > 5, true);
});

test('validates invoice input', async (t) => {
  const app = await start();
  t.after(app.close);
  const bad = [
    { ...sampleInvoice, clientEmail: 'nope' },
    { ...sampleInvoice, amount: '-5' },
    { ...sampleInvoice, amount: 'abc' },
    { ...sampleInvoice, clientName: '' },
    { ...sampleInvoice, dueInDays: 500 },
  ];
  for (const body of bad) {
    const r = await app.call('POST', '/api/invoices', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await app.call('GET', '/api/invoices')).json.length, 0);
});

test('rejects malformed and non-object JSON', async (t) => {
  const app = await start();
  t.after(app.close);
  const res = await fetch(`${app.base}/api/sweep`, { method: 'POST', body: '{nope' });
  assert.equal(res.status, 400);
  const arr = await fetch(`${app.base}/api/sweep`, { method: 'POST', body: '[1]' });
  assert.equal(arr.status, 400);
});

test('admin token protects the API but not health or the webhook', async (t) => {
  const app = await start({ adminToken: 's3cret' });
  t.after(app.close);
  assert.equal((await app.call('GET', '/api/invoices')).status, 401);
  assert.equal((await app.call('GET', '/api/invoices', undefined, { 'x-admin-token': 'wrong' })).status, 401);
  assert.equal((await app.call('GET', '/api/invoices', undefined, { 'x-admin-token': 's3cret' })).status, 200);
  assert.equal((await app.call('GET', '/api/health')).status, 200);
  assert.equal((await app.call('POST', '/api/webhooks/paypal', { id: 'x', event_type: 'y' })).status, 200);
});

test('webhooks with a bad signature are rejected', async (t) => {
  const paypal = fakePayPal();
  paypal.verifyWebhook = async () => false;
  const app = await start({ paypal });
  t.after(app.close);
  const r = await app.call('POST', '/api/webhooks/paypal', { id: 'x', event_type: 'INVOICING.INVOICE.PAID' });
  assert.equal(r.status, 400);
});

test('backdate helper only exists in demo mode', async (t) => {
  const app = await start({ demoMode: false });
  t.after(app.close);
  const inv = await app.call('POST', '/api/invoices', sampleInvoice);
  assert.equal((await app.call('POST', `/api/invoices/${inv.json.id}/backdate`, { days: 5 })).status, 404);
});

test('PayPal failures surface as 502 and unknown routes as 404', async (t) => {
  const paypal = fakePayPal();
  const { PayPalError } = await import('../src/paypal.js');
  paypal.createInvoice = async () => {
    throw new PayPalError('Unprocessable', 422, { details: [{ issue: 'INVALID_EMAIL' }] });
  };
  const app = await start({ paypal });
  t.after(app.close);
  const r = await app.call('POST', '/api/invoices', sampleInvoice);
  assert.equal(r.status, 502);
  assert.match(r.json.error, /Unprocessable/);
  assert.equal((await app.call('GET', '/api/nope')).status, 404);
});

test('static files are served and path traversal is blocked', async (t) => {
  const app = await start();
  t.after(app.close);
  const root = await fetch(`${app.base}/`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type'), /text\/html/);
  const evil = await fetch(`${app.base}/..%2fpackage.json`);
  assert.equal(evil.status, 404);
  const evil2 = await fetch(`${app.base}/%2e%2e/package.json`);
  assert.equal(evil2.status, 404);
});
