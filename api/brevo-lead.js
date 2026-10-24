// Vercel-Funktion: nimmt die Quiz-Anmeldung entgegen und legt die Person als Kontakt in Brevo an.
// Benötigte Umgebungsvariablen in Vercel: BREVO_API_KEY und BREVO_LIST_ID.

const BREVO_URL = 'https://api.brevo.com/v3/contacts';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sendToBrevo(apiKey, body) {
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Nur POST erlaubt.' });
  }

  const apiKey = process.env.BREVO_API_KEY;
  const listId = Number(process.env.BREVO_LIST_ID);
  if (!apiKey || !listId) {
    console.error('[brevo-lead] BREVO_API_KEY oder BREVO_LIST_ID fehlt in den Vercel-Umgebungsvariablen.');
    return res.status(500).json({ error: 'Server ist nicht eingerichtet.' });
  }

  let data = req.body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Ungültige Anfrage.' });

  const email = String(data.email || '').trim();
  const vorname = String(data.vorname || '').trim().slice(0, 100);
  if (!EMAIL_RE.test(email) || !vorname || data.einwilligung !== true) {
    return res.status(400).json({ error: 'Vorname, E-Mail und Einwilligung sind nötig.' });
  }

  const antworten = Array.isArray(data.antworten)
    ? data.antworten.map((x, i) => `${i + 1}. ${x && x.frage}: ${x && x.antwort}`).join('\n').slice(0, 3000)
    : '';

  const base = { email, listIds: [listId], updateEnabled: true };
  const full = {
    ...base,
    attributes: {
      FIRSTNAME: vorname,
      TELEFON: String(data.telefon || '').trim().slice(0, 50),
      QUIZ_ANTWORTEN: antworten
    }
  };

  // Erst mit allen Feldern versuchen. Gibt es TELEFON oder QUIZ_ANTWORTEN in Brevo nicht,
  // lehnt Brevo ab, dann wird der Kontakt nur mit dem Vornamen gespeichert.
  let result = await sendToBrevo(apiKey, full);
  if (!result.ok && result.status === 400) {
    console.warn('[brevo-lead] Brevo lehnt Zusatzfelder ab, speichere nur Vornamen:', result.text);
    result = await sendToBrevo(apiKey, { ...base, attributes: { FIRSTNAME: vorname } });
  }

  if (!result.ok) {
    console.error('[brevo-lead] Brevo-Fehler', result.status, result.text);
    return res.status(502).json({ error: 'Speichern bei Brevo fehlgeschlagen.' });
  }
  return res.status(200).json({ ok: true });
};
