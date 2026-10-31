import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRouter, readBody, sendJson, serveStatic, HttpError } from './http.js';
import { ChaseError } from './chaser.js';
import { PayPalError } from './paypal.js';
import { isValidAmount } from './money.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PUBLIC_API = new Set(['/api/health', '/api/webhooks/paypal']);

function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function text(value, field, max, { required = true } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s && required) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return s;
}

export function createServer({ config, chaser, paypal, ai }) {
  const router = createRouter();
  const needPayPal = () => {
    if (!paypal.configured) throw new HttpError(503, 'PayPal credentials are not configured');
  };

  router.add('GET', '/api/health', () => ({
    body: {
      ok: true,
      paypal: paypal.configured,
      ai: ai.configured,
      model: ai.configured ? config.ai.model : null,
      demoMode: config.demoMode,
      currency: config.currency,
      protected: Boolean(config.adminToken),
    },
  }));

  router.add('GET', '/api/invoices', () => ({ body: chaser.store.allInvoices() }));
  router.add('GET', '/api/stats', () => ({ body: chaser.stats() }));
  router.add('GET', '/api/events', () => ({ body: chaser.store.events().slice(0, 50) }));
  router.add('GET', '/api/proposals', () => ({
    body: chaser.store.allProposals().filter((p) => p.status === 'pending'),
  }));

  router.add('POST', '/api/invoices', async ({ body }) => {
    needPayPal();
    const clientName = text(body.clientName, 'clientName', 80);
    const clientEmail = text(body.clientEmail, 'clientEmail', 120);
    if (!EMAIL.test(clientEmail)) throw new HttpError(400, 'clientEmail is not a valid email');
    const description = text(body.description, 'description', 150);
    if (!isValidAmount(body.amount)) throw new HttpError(400, 'amount must be a positive number with up to 2 decimals');
    const dueInDays = body.dueInDays === undefined ? 14 : Number(body.dueInDays);
    if (!Number.isInteger(dueInDays) || dueInDays < 0 || dueInDays > 90) {
      throw new HttpError(400, 'dueInDays must be a whole number from 0 to 90');
    }
    const invoice = await chaser.createInvoice({
      clientName,
      clientEmail,
      description,
      amount: Number(body.amount).toFixed(2),
      dueInDays,
    });
    return { status: 201, body: invoice };
  });

  router.add('POST', '/api/sweep', async ({ body }) => {
    needPayPal();
    const results = await chaser.sweep({ dryRun: body.dryRun === true });
    return { body: { results, stats: chaser.stats() } };
  });

  router.add('POST', '/api/invoices/:id/replies', async ({ params, body }) => {
    needPayPal();
    const reply = text(body.text, 'text', 2000);
    return { body: await chaser.handleReply(params.id, reply) };
  });

  router.add('POST', '/api/invoices/:id/backdate', ({ params, body }) => {
    if (!config.demoMode) throw new HttpError(404, 'Not found');
    const days = Number(body.days);
    if (!Number.isInteger(days) || days < 1 || days > 120) throw new HttpError(400, 'days must be 1-120');
    return { body: chaser.backdate(params.id, days) };
  });

  router.add('POST', '/api/proposals/:id/approve', async ({ params }) => {
    needPayPal();
    return { body: await chaser.approve(params.id) };
  });

  router.add('POST', '/api/proposals/:id/reject', ({ params }) => ({ body: chaser.reject(params.id) }));

  router.add('POST', '/api/webhooks/paypal', async ({ req, raw }) => {
    const valid = await paypal.verifyWebhook(req.headers, raw).catch(() => false);
    if (!valid) throw new HttpError(400, 'Webhook signature could not be verified');
    return { body: await chaser.handleWebhook(JSON.parse(raw)) };
  });

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const isApi = url.pathname.startsWith('/api/');

      if (!isApi) {
        if (req.method === 'GET' && serveStatic(res, PUBLIC_DIR, url.pathname)) return;
        throw new HttpError(404, 'Not found');
      }

      if (config.adminToken && !PUBLIC_API.has(url.pathname) && !tokenMatches(req.headers['x-admin-token'], config.adminToken)) {
        throw new HttpError(401, 'Missing or invalid admin token');
      }

      const match = router.match(req.method, url.pathname);
      if (!match) throw new HttpError(404, 'Not found');

      let raw = '';
      let body = {};
      if (req.method === 'POST') {
        raw = await readBody(req);
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            throw new HttpError(400, 'Body must be valid JSON');
          }
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          throw new HttpError(400, 'Body must be a JSON object');
        }
      }

      const result = await match.handler({ req, params: match.params, body, raw });
      sendJson(res, result.status ?? 200, result.body);
    } catch (err) {
      if (err instanceof HttpError || err instanceof ChaseError) {
        sendJson(res, err.status, { error: err.message });
      } else if (err instanceof PayPalError) {
        sendJson(res, 502, { error: `PayPal: ${err.message}`, details: err.details?.details ?? undefined });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'Internal server error' });
      }
    }
  });
}
