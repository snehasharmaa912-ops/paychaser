# PayChaser

**An AI agent that gets freelancers paid.** It watches your PayPal invoices, chases the overdue ones in the right tone, reads client replies, and drafts payment plans that stay inside rules you set. You approve anything that changes an invoice with one tap.

Built for the PayPal AI Hackathon 2026. License: MIT.

## The problem

Freelancers and small studios lose hours (and goodwill) chasing late payments. Generic reminders get ignored, and ad-hoc "sure, pay me in parts" deals get messy fast.

## How it works

```
 PayPal Invoicing API  <--  PayChaser  -->  AI model (Claude)
   create / send              |              writes reminders,
   remind / cancel            |              classifies replies
   get status                 v
 PayPal Webhooks  ---->  policy guardrails  ---->  mobile dashboard
   INVOICE.PAID           clamp every plan         approve / reject
```

1. **Create and send** an invoice through PayPal Invoicing.
2. **Sweep** (manually or from a scheduler hitting `POST /api/sweep`): PayPal is checked for payments first, then each overdue invoice gets a reminder sent through PayPal's own remind endpoint. The AI picks the tone (friendly, firm, final) from how late it is, how many reminders were sent, and how that client has paid before.
3. **Reply**: paste the client's reply. The AI classifies it:
   - *"I'll pay Friday"*: reminders pause (bounded by your policy).
   - *"This is the wrong amount"*: reminders stop and it is flagged for you.
   - *"Can I pay half now?"*: a payment plan is drafted and waits for your approval. On approval, PayChaser sends the installment invoices through PayPal and cancels the original.
4. **Webhook** `INVOICING.INVOICE.PAID` updates the dashboard instantly (the sweep also syncs as a fallback).

## Why you can trust an AI near your invoices

- **The AI proposes, rules decide.** Every plan goes through `src/policy.js`: max installments, minimum first payment, maximum span, minimum invoice size. A model that is manipulated by a hostile client reply cannot exceed them (covered by tests).
- **Client replies are treated as untrusted data**, never as instructions.
- **Links are stripped** from anything the model writes before it is emailed to a client.
- **Approval gate** for anything that creates or cancels invoices. Only low-risk, reversible actions (pausing reminders, flagging a dispute) apply automatically.
- **Hard stop**: after 4 reminders the case is handed to you.
- **No AI key? It still works** with built-in rules.

## Run it

Requires Node 20.12+. There are no runtime dependencies, so there is nothing to `npm install`.

```bash
cp .env.example .env     # fill in your PayPal sandbox credentials
npm start                # http://localhost:3000
npm test                 # 42 tests, no network needed
```

Get sandbox credentials at developer.paypal.com (Apps & Credentials, Sandbox). Use a sandbox **buyer** email as the client so you can pay invoices in the demo.

| Variable | Purpose |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal sandbox app credentials |
| `PAYPAL_WEBHOOK_ID` | Webhook for `INVOICING.INVOICE.PAID` (point it at `/api/webhooks/paypal`) |
| `ANTHROPIC_API_KEY`, `AI_MODEL` | AI model (optional, rules fallback without it) |
| `ADMIN_TOKEN` | Protects `/api/*`. Set this on any deployed instance. |
| `DEMO_MODE=1` | Adds an "age this invoice" button so overdue flows can be shown in one sitting |

## API

| Method | Path | |
|---|---|---|
| GET | `/api/health` `/api/stats` `/api/invoices` `/api/events` `/api/proposals` | read state |
| POST | `/api/invoices` | create and send an invoice |
| POST | `/api/sweep` | run a chase (`{"dryRun": true}` to preview) |
| POST | `/api/invoices/:id/replies` | analyse a client reply |
| POST | `/api/proposals/:id/approve` `/reject` | decide on a payment plan |
| POST | `/api/webhooks/paypal` | PayPal webhook (signature verified with PayPal) |

## Deploy

`render.yaml` is included for a one-click Render web service. Add the environment variables above. The default store is a JSON file, which is ephemeral on free hosting tiers.

## Known limits

- Client replies are pasted in manually; there is no inbox integration yet.
- Single currency per deployment (`DEFAULT_CURRENCY`).
- JSON-file storage suits a demo, not production scale.
- Webhook payload field paths follow PayPal's documented shape; confirm against a real sandbox event, and the sweep covers any gap.
