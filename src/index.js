import { loadConfig } from './config.js';
import { PayPalClient } from './paypal.js';
import { AIClient } from './ai.js';
import { ChaseAgent } from './agent.js';
import { Chaser } from './chaser.js';
import { Store } from './store.js';
import { createServer } from './server.js';

try {
  process.loadEnvFile();
} catch {
  /* no .env file: use real environment variables */
}

const config = loadConfig();
const paypal = new PayPalClient(config.paypal);
const ai = new AIClient(config.ai);
const store = new Store(config.dataFile);
const chaser = new Chaser({ store, paypal, agent: new ChaseAgent({ ai }), currency: config.currency });

createServer({ config, chaser, paypal, ai }).listen(config.port, () => {
  console.log(`PayChaser running on http://localhost:${config.port}`);
  console.log(`  PayPal: ${paypal.configured ? 'configured' : 'MISSING credentials (see .env.example)'}`);
  console.log(`  AI:     ${ai.configured ? config.ai.model : 'no key, using built-in rules'}`);
  if (!config.adminToken) console.log('  Warning: ADMIN_TOKEN is not set, the API is open.');
});
