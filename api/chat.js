// Proxy zu Anthropic. Hält den echten API Key serverseitig geheim.
// Erwartet POST-Body: { system, messages, max_tokens }
// Erwartet Header: x-access-code

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Zugangscode prüfen (falls gesetzt)
  const accessCode = req.headers['x-access-code'];
  if (process.env.ACCESS_CODE && accessCode !== process.env.ACCESS_CODE) {
    return res.status(401).json({ error: 'Ungültiger Zugangscode' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server nicht konfiguriert (ANTHROPIC_API_KEY fehlt)' });
  }

  // Einfaches Tages-Rate-Limit pro IP (optional, nur aktiv wenn Upstash konfiguriert ist)
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const allowed = await checkRateLimit(ip);
  if (!allowed) {
    return res.status(429).json({ error: 'Tageslimit erreicht. Bitte morgen wieder versuchen.' });
  }

  try {
    const { system, messages, max_tokens } = req.body;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: Math.min(parseInt(max_tokens) || 400, 600),
        system,
        messages
      })
    });

    const data = await anthropicRes.json();
    return res.status(anthropicRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function checkRateLimit(ip) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const limit = parseInt(process.env.MAX_REQUESTS_PER_DAY || '300', 10);
  if (!url || !token) return true; // Rate-Limiting nicht konfiguriert -> erlauben

  try {
    const day = new Date().toISOString().slice(0, 10);
    const key = `ratelimit:chat:${ip}:${day}`;
    const incrRes = await fetch(`${url}/incr/${key}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const incrData = await incrRes.json();
    const count = incrData.result;
    if (count === 1) {
      await fetch(`${url}/expire/${key}/172800`, {
        headers: { Authorization: `Bearer ${token}` }
      });
    }
    return count <= limit;
  } catch (e) {
    // Bei Fehlern im Rate-Limiting lieber durchlassen als die App komplett zu blockieren
    return true;
  }
}
