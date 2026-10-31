import test from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient, PayPalError } from '../src/paypal.js';

const CONFIG = { baseUrl: 'https://api-m.sandbox.paypal.com', clientId: 'id', secret: 'sec', webhookId: 'WH-1' };

function stubFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const path = url.replace(CONFIG.baseUrl, '');
    const handler = routes[`${init.method || 'GET'} ${path}`];
    if (!handler) throw new Error(`Unexpected call: ${init.method} ${path}`);
    const { status = 200, body = {} } = handler(init);
    const text = JSON.stringify(body);
    return { ok: status < 400, status, text: async () => text, json: async () => body };
  };
  return { impl, calls };
}

const tokenRoute = { 'POST /v1/oauth2/token': () => ({ body: { access_token: 'tok', expires_in: 3600 } }) };

test('caches the OAuth token across requests', async () => {
  const { impl, calls } = stubFetch({
    ...tokenRoute,
    'GET /v2/invoicing/invoices/INV2-1': () => ({ body: { id: 'INV2-1', status: 'SENT' } }),
  });
  const pp = new PayPalClient(CONFIG, impl);
  await pp.getInvoice('INV2-1');
  await pp.getInvoice('INV2-1');
  assert.equal(calls.filter((c) => c.url.endsWith('/oauth2/token')).length, 1);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer tok');
});

test('createInvoice returns the id parsed from the href and sends the due date', async () => {
  let sent;
  const { impl } = stubFetch({
    ...tokenRoute,
    'POST /v2/invoicing/invoices': (init) => {
      sent = JSON.parse(init.body);
      return { status: 201, body: { href: 'https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-ABC' } };
    },
  });
  const pp = new PayPalClient(CONFIG, impl);
  const id = await pp.createInvoice({
    number: '0001',
    clientName: 'Asha Rao',
    clientEmail: 'asha@example.com',
    description: 'Logo design',
    amount: '120.00',
    currency: 'USD',
    dueDate: '2026-11-20',
    invoiceDate: '2026-11-06',
  });
  assert.equal(id, 'INV2-ABC');
  assert.equal(sent.detail.payment_term.due_date, '2026-11-20');
  assert.equal(sent.items[0].unit_amount.value, '120.00');
  assert.equal(sent.primary_recipients[0].billing_info.name.surname, 'Rao');
});

test('API errors surface as PayPalError with details', async () => {
  const { impl } = stubFetch({
    ...tokenRoute,
    'POST /v2/invoicing/invoices/X/remind': () => ({ status: 422, body: { message: 'Unprocessable', name: 'UNPROCESSABLE_ENTITY' } }),
  });
  const pp = new PayPalClient(CONFIG, impl);
  await assert.rejects(pp.remindInvoice('X', { subject: 's', note: 'n' }), (err) => {
    assert.ok(err instanceof PayPalError);
    assert.equal(err.status, 422);
    assert.equal(err.details.name, 'UNPROCESSABLE_ENTITY');
    return true;
  });
});

test('verifyWebhook forwards PayPal headers and maps SUCCESS to true', async () => {
  let sent;
  const { impl } = stubFetch({
    ...tokenRoute,
    'POST /v1/notifications/verify-webhook-signature': (init) => {
      sent = JSON.parse(init.body);
      return { body: { verification_status: 'SUCCESS' } };
    },
  });
  const pp = new PayPalClient(CONFIG, impl);
  const ok = await pp.verifyWebhook(
    { 'paypal-transmission-id': 't1', 'paypal-auth-algo': 'SHA256withRSA' },
    JSON.stringify({ id: 'WH-EVT', event_type: 'INVOICING.INVOICE.PAID' }),
  );
  assert.equal(ok, true);
  assert.equal(sent.webhook_id, 'WH-1');
  assert.equal(sent.transmission_id, 't1');
  assert.equal(sent.webhook_event.event_type, 'INVOICING.INVOICE.PAID');
});

test('verifyWebhook refuses when no webhook id is configured', async () => {
  const pp = new PayPalClient({ ...CONFIG, webhookId: '' }, async () => {
    throw new Error('should not call PayPal');
  });
  assert.equal(await pp.verifyWebhook({}, '{}'), false);
});
