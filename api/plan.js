// Serverless proxy (Vercel/Netlify Node function). Keeps ANTHROPIC_API_KEY on the server.
// The browser POSTs { system, messages, max_tokens }; we forward to the Anthropic API.
//
// Hardening TODO for production: authenticate the caller (session/user), enforce
// per-user rate limits, and constrain `system`/`messages` to your own prompts so this
// can't be used as an open relay. Kept minimal here for clarity.
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(501).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' }); return; }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { system, messages, max_tokens } = body;
    if (!Array.isArray(messages) || messages.length === 0) { res.status(400).json({ error: 'messages[] is required' }); return; }

    const payload = {
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: Math.min(Math.max(parseInt(max_tokens, 10) || 1024, 64), 4096),
      messages,
    };
    if (system) payload.system = String(system).slice(0, 20000);

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(500).json({ error: 'Proxy error' });
  }
}
