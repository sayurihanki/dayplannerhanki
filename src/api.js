// Calls the serverless proxy at /api/plan, which holds the Anthropic API key server-side.
// Returns the raw Anthropic Messages response ({ content, stop_reason, ... }).
// Throws err.noBackend when no backend is configured so the app can fall back locally.
export async function aiMessage({ system, messages, max_tokens = 1500 }) {
  let res;
  try {
    res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system, messages, max_tokens }),
    });
  } catch (e) {
    const err = new Error('Network error'); err.noBackend = true; throw err;
  }
  if (res.status === 404 || res.status === 501) { const err = new Error('No AI backend configured'); err.noBackend = true; throw err; }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j && (j.error?.message || j.error)) || ''; } catch (e) {}
    throw new Error('Planner API ' + res.status + (detail ? ': ' + detail : ''));
  }
  // Guard against an HTML fallback (e.g. dev server returning index.html)
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) { const err = new Error('No AI backend configured'); err.noBackend = true; throw err; }
  return res.json();
}
