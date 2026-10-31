export function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('No JSON object in model output');
  return JSON.parse(text.slice(start, end + 1));
}
export class AIClient {
  constructor({ apiKey, model }, fetchImpl = fetch) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetch = fetchImpl;
  }
  get configured() {
    return Boolean(this.apiKey);
  }
  async json(system, user, maxTokens = 600) {
    const res = await this.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `AI request failed (${res.status})`);
    const text = (data.content || []).map((block) => block.text || '').join('');
    return extractJson(text);
  }
}
