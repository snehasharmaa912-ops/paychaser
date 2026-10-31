export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    currency: env.DEFAULT_CURRENCY || 'USD',
    dataFile: env.DATA_FILE || './data/db.json',
    adminToken: env.ADMIN_TOKEN || '',
    demoMode: env.DEMO_MODE === '1',
    paypal: {
      baseUrl: env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com',
      clientId: env.PAYPAL_CLIENT_ID || '',
      secret: env.PAYPAL_CLIENT_SECRET || '',
      webhookId: env.PAYPAL_WEBHOOK_ID || '',
    },
    ai: {
      apiKey: env.ANTHROPIC_API_KEY || '',
      model: env.AI_MODEL || 'claude-sonnet-5-5',
    },
  };
}
