import { randomUUID } from 'node:crypto';
export class PayPalError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.details = details;
  }
}
export class PayPalClient {
  constructor({ baseUrl, clientId, secret, webhookId }, fetchImpl = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.clientId = clientId;
    this.secret = secret;
    this.webhookId = webhookId;
    this.fetch = fetchImpl;
    this.cached = null;
  }

  
  get configured() {
    return Boolean(this.clientId && this.secret);
  }
  async token() {
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000) return this.cached.value;
    const basic = Buffer.from(`${this.clientId}:${this.secret}`).toString('base64');
    const res = await this.fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError('PayPal authentication failed', res.status, data);
    this.cached = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return this.cached.value;
  }
  async request(method, path, body) {
    const token = await this.token();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (method === 'POST') headers['PayPal-Request-Id'] = randomUUID();
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) throw new PayPalError(data.message || `PayPal ${method} ${path} failed`, res.status, data);
    return data;
  }
  async generateInvoiceNumber() {
    const data = await this.request('POST', '/v2/invoicing/generate-next-invoice-number');
    return data.invoice_number;
  }
  async createInvoice({ number, clientName, clientEmail, description, amount, currency, dueDate, invoiceDate }) {
    const [given, ...rest] = clientName.trim().split(/\s+/);
    const data = await this.request('POST', '/v2/invoicing/invoices', {
      detail: {
        invoice_number: number,
        invoice_date: invoiceDate,
        currency_code: currency,
        note: 'Created by PayChaser',
        payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: dueDate },
      },
      primary_recipients: [
        {
          billing_info: {
            email_address: clientEmail,
            name: { given_name: given, surname: rest.join(' ') || undefined },
          },
        },
      ],
      items: [
        {
          name: description,
          quantity: '1',
          unit_amount: { currency_code: currency, value: amount },
        },
      ],
    });
    return data.href.split('/').pop();
  }
  async sendInvoice(id) {
    return this.request('POST', `/v2/invoicing/invoices/${id}/send`, {
      send_to_recipient: true,
      send_to_invoicer: false,
    });
  }
  async remindInvoice(id, { subject, note }) {
    return this.request('POST', `/v2/invoicing/invoices/${id}/remind`, {
      subject,
      note,
      send_to_recipient: true,
      send_to_invoicer: false,
    });
  }
  async cancelInvoice(id, { subject, note }) {
    return this.request('POST', `/v2/invoicing/invoices/${id}/cancel`, {
      subject,
      note,
      send_to_recipient: true,
      send_to_invoicer: false,
    });
  }
  async getInvoice(id) {
    return this.request('GET', `/v2/invoicing/invoices/${id}`);
  }
  async verifyWebhook(headers, rawBody) {
    if (!this.webhookId) return false;
    const h = (name) => headers[name] ?? headers[name.toLowerCase()];
    const data = await this.request('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: this.webhookId,
      webhook_event: JSON.parse(rawBody),
    });
    return data.verification_status === 'SUCCESS';
  }
}
