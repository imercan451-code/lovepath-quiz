// Vercel-Funktion: schickt PageView und Lead serverseitig an die Meta Conversion API (CAPI).
// Der Browser ruft sie NUR auf, wenn im Cookie-Banner „Marketing“ erlaubt wurde.
// Jedes Ereignis trägt dieselbe event_id wie das Meta-Pixel im Browser, damit Meta doppelte Ereignisse aussortiert.
// Benötigte Umgebungsvariablen in Vercel: META_CAPI_ACCESS_TOKEN und META_PIXEL_ID.
// Optional zum Testen: META_TEST_EVENT_CODE (aus dem Events Manager → Test Events). Danach wieder löschen.

const crypto = require('crypto');

const GRAPH_VERSION = 'v21.0';
const ALLOWED_EVENTS = new Set(['PageView', 'Lead']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const norm = (v) => String(v || '').trim().toLowerCase();

function readCookie(header, name) {
  const m = String(header || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Nur POST erlaubt.' });
  }

  const token = process.env.META_CAPI_ACCESS_TOKEN;
  const pixelId = process.env.META_PIXEL_ID;
  if (!token || !pixelId) {
    console.error('[meta-capi] META_CAPI_ACCESS_TOKEN oder META_PIXEL_ID fehlt in den Vercel-Umgebungsvariablen.');
    return res.status(500).json({ error: 'Server ist nicht eingerichtet.' });
  }

  let data = req.body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Ungültige Anfrage.' });

  // Sicherheitsnetz: ohne Marketing-Zustimmung wird nichts an Meta geschickt.
  if (data.consent_marketing !== true) return res.status(204).end();

  const eventName = String(data.event_name || '');
  const eventId = String(data.event_id || '').slice(0, 100);
  if (!ALLOWED_EVENTS.has(eventName) || !eventId) {
    return res.status(400).json({ error: 'event_name (PageView/Lead) und event_id sind nötig.' });
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
  const userData = {
    client_ip_address: ip || undefined,
    client_user_agent: String(req.headers['user-agent'] || '') || undefined,
    fbp: readCookie(req.headers.cookie, '_fbp') || undefined,
    fbc: readCookie(req.headers.cookie, '_fbc') || undefined
  };

  // Beim Lead: E-Mail und Vorname nur verschlüsselt (SHA-256) mitschicken, so wie Meta es verlangt.
  if (eventName === 'Lead') {
    const email = norm(data.email);
    const vorname = norm(data.vorname);
    if (EMAIL_RE.test(email)) userData.em = [sha256(email)];
    if (vorname) userData.fn = [sha256(vorname)];
  }

  let sourceUrl = String(data.event_source_url || req.headers.referer || '');
  if (!/^https?:\/\//.test(sourceUrl)) sourceUrl = 'https://' + (req.headers.host || 'lovepath-quiz.vercel.app') + '/';

  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      event_source_url: sourceUrl.slice(0, 1000),
      action_source: 'website',
      user_data: userData
    }]
  };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await r.text();
    if (!r.ok) {
      console.error('[meta-capi] Meta-Fehler', r.status, text);
      return res.status(502).json({ error: 'Meta hat das Ereignis abgelehnt.' });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[meta-capi] Netzwerkfehler', e);
    return res.status(502).json({ error: 'Meta nicht erreichbar.' });
  }
};
