import { Store } from '../src/store.js';
import { Chaser } from '../src/chaser.js';
import { ChaseAgent } from '../src/agent.js';
export function fakePayPal() {
  let invoiceNumber = 0;
  let nextId = 0;
  const calls = [];
  const remote = {};
  return {
    configured: true,
    calls,
    remote,
    async generateInvoiceNumber() {
      invoiceNumber += 1;
      return String(invoiceNumber).padStart(4, '0');
    },
    async createInvoice(input) {
      nextId += 1;
      const id = `INV2-${nextId}`;
      remote[id] = { status: 'DRAFT', input };
      calls.push(['create', id, input]);
      return id;
    },
    async sendInvoice(id) {
      remote[id].status = 'SENT';
      calls.push(['send', id]);
    },
    async remindInvoice(id, payload) {
      calls.push(['remind', id, payload]);
    },
    async cancelInvoice(id, payload) {
      remote[id].status = 'CANCELLED';
      calls.push(['cancel', id, payload]);
    },
    async getInvoice(id) {
      return { id, status: remote[id]?.status ?? 'SENT' };
    },
    async verifyWebhook() {
      return true;
    },
  };
}

export function buildChaser({ ai = { configured: false }, paypal = fakePayPal(), now = '2026-11-02T10:00:00Z' } = {}) {
  const clock = { current: new Date(now) };
  const store = new Store(null);
  const agent = new ChaseAgent({ ai });
  const chaser = new Chaser({ store, paypal, agent, currency: 'USD', now: () => clock.current });
  return { chaser, store, paypal, clock };
}

export const sampleInvoice = {
  clientName: 'Asha Rao',
  clientEmail: 'asha@example.com',
  description: 'Brand identity design',
  amount: '200.00',
  dueInDays: 14,
};
