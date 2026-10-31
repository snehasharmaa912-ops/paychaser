import { randomUUID } from 'node:crypto';
import { DEFAULT_POLICY } from './policy.js';
import { toISODate, addDays, daysBetween } from './dates.js';
import { toCents, fromCents } from './money.js';

export class ChaseError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ChaseError';
    this.status = status;
  }
}

const PAID_STATUSES = new Set(['PAID', 'MARKED_AS_PAID']);
export class Chaser {
  constructor({ store, paypal, agent, policy = DEFAULT_POLICY, currency = 'USD', now = () => new Date() }) {
    this.store = store;
    this.paypal = paypal;
    this.agent = agent;
    this.policy = policy;
    this.currency = currency;
    this.now = now;
  }

  today() {
    return toISODate(this.now());
  }

  stamp() {
    return this.now().toISOString();
  }

  requireOpen(id) {
    const invoice = this.store.getInvoice(id);
    if (!invoice) throw new ChaseError('Invoice not found', 404);
    if (invoice.status !== 'SENT') throw new ChaseError(`Invoice is ${invoice.status.toLowerCase()}`, 409);
    return invoice;
  }

  async createInvoice({ clientName, clientEmail, description, amount, dueInDays = 14, dueDate = null, parentId = null }) {
    const today = this.today();
    const due = dueDate ?? addDays(today, dueInDays);
    const number = await this.paypal.generateInvoiceNumber();
    const id = await this.paypal.createInvoice({
      number,
      clientName,
      clientEmail,
      description,
      amount,
      currency: this.currency,
      dueDate: due,
      invoiceDate: today,
    });
    await this.paypal.sendInvoice(id);
    const invoice = {
      id,
      number,
      clientName,
      clientEmail: clientEmail.toLowerCase(),
      description,
      amount,
      currency: this.currency,
      dueDate: due,
      status: 'SENT',
      createdAt: this.stamp(),
      paidAt: null,
      reminders: [],
      promisedUntil: null,
      flag: null,
      parentId,
    };
    this.store.putInvoice(invoice);
    this.store.log('invoice_created', { invoiceId: id, amount, parentId }, this.stamp());
    return invoice;
  }

  markPaid(invoice) {
    if (invoice.status === 'PAID') return false;
    const paidAt = this.today();
    invoice.status = 'PAID';
    invoice.paidAt = paidAt;
    this.store.putInvoice(invoice);
    const late = daysBetween(invoice.dueDate, paidAt) > 0;
    this.store.recordPayment(invoice.clientEmail, invoice.clientName, late);
    for (const proposal of this.store.allProposals()) {
      if (proposal.invoiceId === invoice.id && proposal.status === 'pending') {
        proposal.status = 'expired';
        this.store.putProposal(proposal);
      }
    }
    this.store.log('invoice_paid', { invoiceId: invoice.id, late }, this.stamp());
    return true;
  }
  async sweep({ dryRun = false } = {}) {
    const today = this.today();
    const results = [];
    for (const invoice of this.store.openInvoices()) {
      const base = { invoiceId: invoice.id, number: invoice.number };
      try {
        const remote = await this.paypal.getInvoice(invoice.id);
        if (PAID_STATUSES.has(remote.status)) {
          if (!dryRun) this.markPaid(invoice);
          results.push({ ...base, action: 'paid' });
          continue;
        }
        if (remote.status === 'CANCELLED') {
          if (!dryRun) {
            invoice.status = 'CANCELLED';
            this.store.putInvoice(invoice);
          }
          results.push({ ...base, action: 'cancelled' });
          continue;
        }

        const daysOverdue = daysBetween(invoice.dueDate, today);
        if (daysOverdue <= 0) continue;
        if (invoice.flag) {
          results.push({ ...base, action: 'skipped', reason: invoice.flag });
          continue;
        }
        if (invoice.promisedUntil && invoice.promisedUntil >= today) {
          results.push({ ...base, action: 'skipped', reason: `client promised payment by ${invoice.promisedUntil}` });
          continue;
        }
        const last = invoice.reminders.at(-1);
        if (last && daysBetween(last.at.slice(0, 10), today) < this.policy.reminderCooldownDays) {
          results.push({ ...base, action: 'skipped', reason: 'reminded recently' });
          continue;
        }
        if (invoice.reminders.length >= this.policy.maxReminders) {
          if (!dryRun) {
            invoice.flag = 'needs_human';
            this.store.putInvoice(invoice);
            this.store.log('escalated', { invoiceId: invoice.id, reason: 'reminder limit reached' }, this.stamp());
          }
          results.push({ ...base, action: 'escalated', reason: 'reminder limit reached' });
          continue;
        }

        const client = this.store.getClient(invoice.clientEmail);
        const plan = await this.agent.planReminder({
          invoice,
          client,
          daysOverdue,
          reminderCount: invoice.reminders.length,
        });
        if (!dryRun) {
          await this.paypal.remindInvoice(invoice.id, { subject: plan.subject, note: plan.note });
          invoice.reminders.push({
            at: this.stamp(),
            tone: plan.tone,
            subject: plan.subject,
            note: plan.note,
            source: plan.source,
          });
          this.store.putInvoice(invoice);
          this.store.log(
            'reminder_sent',
            { invoiceId: invoice.id, tone: plan.tone, subject: plan.subject, source: plan.source },
            this.stamp(),
          );
        }
        results.push({
          ...base,
          action: dryRun ? 'would_remind' : 'reminded',
          tone: plan.tone,
          subject: plan.subject,
          note: plan.note,
          source: plan.source,
        });
      } catch (err) {
        results.push({ ...base, action: 'error', error: err.message });
      }
    }
    return results;
  }
  async handleReply(invoiceId, text) {
    const invoice = this.requireOpen(invoiceId);
    const today = this.today();
    const interpreted = await this.agent.interpretReply({ invoice, text, today });
    this.store.log(
      'client_reply',
      {
        invoiceId,
        text: String(text).slice(0, 1000),
        intent: interpreted.intent,
        summary: interpreted.summary,
        source: interpreted.source,
      },
      this.stamp(),
    );

    let applied = null;
    let proposal = null;
    const p = interpreted.proposal;
    if (p?.type === 'promise') {
      invoice.promisedUntil = addDays(today, p.days);
      this.store.putInvoice(invoice);
      applied = { type: 'promise', until: invoice.promisedUntil };
      this.store.log('reminders_paused', { invoiceId, until: invoice.promisedUntil }, this.stamp());
    } else if (p?.type === 'escalate') {
      invoice.flag = 'disputed';
      this.store.putInvoice(invoice);
      applied = { type: 'escalate' };
      this.store.log('escalated', { invoiceId, reason: 'client disputes invoice' }, this.stamp());
    } else if (p?.type === 'installments') {
      proposal = this.store.putProposal({
        id: randomUUID(),
        invoiceId,
        type: 'installments',
        status: 'pending',
        plan: p.plan,
        adjustments: p.adjustments,
        summary: interpreted.summary,
        suggestedReply: interpreted.suggestedReply,
        createdAt: this.stamp(),
      });
      this.store.log('proposal_created', { invoiceId, proposalId: proposal.id }, this.stamp());
    }

    return {
      intent: interpreted.intent,
      summary: interpreted.summary,
      suggestedReply: interpreted.suggestedReply,
      source: interpreted.source,
      applied,
      proposal,
    };
  }

  async approve(proposalId) {
    const proposal = this.store.getProposal(proposalId);
    if (!proposal) throw new ChaseError('Proposal not found', 404);
    if (proposal.status !== 'pending') throw new ChaseError(`Proposal is already ${proposal.status}`, 409);
    const original = this.requireOpen(proposal.invoiceId);

    proposal.status = 'approving'; 
    this.store.putProposal(proposal);

    const children = [];
    try {
      for (const step of proposal.plan) {
        children.push(
          await this.createInvoice({
            clientName: original.clientName,
            clientEmail: original.clientEmail,
            description: `${original.description} - ${step.label}`.slice(0, 200),
            amount: step.amount,
            dueDate: step.dueDate,
            parentId: original.id,
          }),
        );
      }
    } catch (err) {
      for (const child of children) {
        try {
          await this.paypal.cancelInvoice(child.id, {
            subject: `Invoice ${child.number} cancelled`,
            note: 'This installment invoice was cancelled because the payment plan could not be completed. Please ignore it.',
          });
          child.status = 'CANCELLED';
          this.store.putInvoice(child);
        } catch {
          /* best effort */
        }
      }
      proposal.status = 'failed';
      proposal.error = err.message;
      this.store.putProposal(proposal);
      this.store.log('proposal_failed', { invoiceId: original.id, proposalId, error: err.message }, this.stamp());
      throw new ChaseError(`Could not create the installment invoices: ${err.message}`, 502);
    }

    let warning = null;
    try {
      await this.paypal.cancelInvoice(original.id, {
        subject: `Invoice ${original.number} replaced by a payment plan`,
        note: 'As agreed, this invoice is replaced by the installment invoices you have received.',
      });
      original.status = 'CANCELLED';
      original.replacedBy = children.map((c) => c.id);
      this.store.putInvoice(original);
    } catch (err) {
      warning = `Installments were sent, but the original invoice could not be cancelled: ${err.message}`;
    }

    proposal.status = warning ? 'needs_attention' : 'approved';
    proposal.childIds = children.map((c) => c.id);
    this.store.putProposal(proposal);
    this.store.log('proposal_approved', { invoiceId: original.id, proposalId, childIds: proposal.childIds }, this.stamp());
    return { proposal, children, warning };
  }

  reject(proposalId) {
    const proposal = this.store.getProposal(proposalId);
    if (!proposal) throw new ChaseError('Proposal not found', 404);
    if (proposal.status !== 'pending') throw new ChaseError(`Proposal is already ${proposal.status}`, 409);
    proposal.status = 'rejected';
    this.store.putProposal(proposal);
    this.store.log('proposal_rejected', { invoiceId: proposal.invoiceId, proposalId }, this.stamp());
    return proposal;
  }

  async handleWebhook(event) {
    if (event?.id && !this.store.markWebhookSeen(event.id)) return { duplicate: true };
    const type = String(event?.event_type ?? '');
    const paypalId = event?.resource?.invoice?.id ?? event?.resource?.id;
    const invoice = paypalId ? this.store.getInvoice(paypalId) : null;
    if (!invoice) return { ignored: true };
    if (type === 'INVOICING.INVOICE.PAID') {
      this.markPaid(invoice);
      return { handled: 'paid', invoiceId: invoice.id };
    }
    if (type === 'INVOICING.INVOICE.CANCELLED' && invoice.status === 'SENT') {
      invoice.status = 'CANCELLED';
      this.store.putInvoice(invoice);
      return { handled: 'cancelled', invoiceId: invoice.id };
    }
    return { ignored: true };
  }
  backdate(invoiceId, days) {
    const invoice = this.requireOpen(invoiceId);
    invoice.dueDate = addDays(invoice.dueDate, -days);
    this.store.putInvoice(invoice);
    return invoice;
  }

  stats() {
    const today = this.today();
    let outstanding = 0;
    let overdue = 0;
    let overdueCount = 0;
    let recovered = 0;
    let remindersSent = 0;
    const daysToPay = [];
    for (const invoice of this.store.allInvoices()) {
      remindersSent += invoice.reminders.length;
      const cents = toCents(invoice.amount);
      if (invoice.status === 'SENT') {
        outstanding += cents;
        if (daysBetween(invoice.dueDate, today) > 0) {
          overdue += cents;
          overdueCount += 1;
        }
      }
      if (invoice.status === 'PAID' && (invoice.reminders.length > 0 || invoice.parentId)) recovered += cents;
      if (invoice.status === 'PAID' && invoice.reminders.length > 0) {
        daysToPay.push(daysBetween(invoice.reminders[0].at.slice(0, 10), invoice.paidAt));
      }
    }
    return {
      currency: this.currency,
      outstanding: fromCents(outstanding),
      overdue: fromCents(overdue),
      overdueCount,
      recovered: fromCents(recovered),
      remindersSent,
      avgDaysFromFirstReminderToPaid: daysToPay.length
        ? Number((daysToPay.reduce((a, b) => a + b, 0) / daysToPay.length).toFixed(1))
        : null,
      pendingProposals: this.store.allProposals().filter((p) => p.status === 'pending').length,
    };
  }
}
