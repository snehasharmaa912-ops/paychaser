import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const empty = () => ({ invoices: {}, clients: {}, proposals: {}, events: [], seenWebhooks: [] });
const MAX_EVENTS = 200;
const MAX_WEBHOOKS = 500;
export class Store {
  constructor(file = null) {
    this.file = file;
    this.data = empty();
    if (file && fs.existsSync(file)) {
      try {
        this.data = { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`); // keep it, start fresh
      }
    }
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  getInvoice(id) {
    return this.data.invoices[id] ?? null;
  }
  putInvoice(invoice) {
    this.data.invoices[invoice.id] = invoice;
    this.save();
    return invoice;
  }
  allInvoices() {
    return Object.values(this.data.invoices).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  openInvoices() {
    return this.allInvoices().filter((invoice) => invoice.status === 'SENT');
  }
  getClient(email) {
    return this.data.clients[String(email).toLowerCase()] ?? null;
  }
  recordPayment(email, name, late) {
    const key = String(email).toLowerCase();
    const client = this.data.clients[key] ?? { email: key, name, onTimeCount: 0, latePaidCount: 0 };
    if (late) client.latePaidCount += 1;
    else client.onTimeCount += 1;
    this.data.clients[key] = client;
    this.save();
  }
  getProposal(id) {
    return this.data.proposals[id] ?? null;
  }
  putProposal(proposal) {
    this.data.proposals[proposal.id] = proposal;
    this.save();
    return proposal;
  }
  allProposals() {
    return Object.values(this.data.proposals).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  log(type, payload, at) {
    this.data.events.unshift({ id: randomUUID(), at, type, ...payload });
    this.data.events.length = Math.min(this.data.events.length, MAX_EVENTS);
    this.save();
  }
  events() {
    return this.data.events;
  }
  markWebhookSeen(id) {
    if (this.data.seenWebhooks.includes(id)) return false;
    this.data.seenWebhooks.push(id);
    if (this.data.seenWebhooks.length > MAX_WEBHOOKS) this.data.seenWebhooks.shift();
    this.save();
    return true;
  }
}
