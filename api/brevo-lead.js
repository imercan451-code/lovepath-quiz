// Vercel-Funktion: nimmt die Quiz-Anmeldung entgegen und legt die Person als Kontakt in Brevo an.
// Die Person landet zuerst in der Single-Opt-in-Liste (unbestätigt). Erst nach Klick auf den
// Bestätigungslink (siehe api/confirm.js) wird sie in die Double-Opt-in-Liste verschoben.
// Benötigte Umgebungsvariablen in Vercel: BREVO_API_KEY und BREVO_SOI_LIST_ID (Single-Opt-in-Liste).

const crypto = require('crypto');

const BREVO_URL = 'https://api.brevo.com/v3/contacts';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOI_NO = 2; // Brevo-Standardfeld DOUBLE_OPT-IN: 1 = Ja, 2 = Nein

// Bestätigungscode: E-Mail-Adresse plus Signatur, damit niemand fremde Adressen bestätigen kann.
function makeDoiToken(email, secret) {
  const payload = Buffer.from(email.toLowerCase()).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update('doi:' + email.toLowerCase()).digest('base64url').slice(0, 32);
  return payload + '.' + sig;
}

// Quiz-Ergebnis aus den Antworten (Frage 1–5). Die Regeln werden der Reihe nach geprüft, die erste passende gilt.
// Der Wert landet im Brevo-Feld QUIZ_ERGEBNIS; die Ergebnis-Automationen in Brevo filtern genau auf diese Texte.
const ERGEBNIS = {
  A: 'A: Partnerschaft verstehen',
  B: 'B: Beziehungsstandort-Bestimmung',
  C: 'C: Paar-Coaching-Programm',
  D: 'D: Kommunikation in Beziehungen'
};

function quizErgebnis(antworten) {
  const a = (i) => String((antworten[i] && antworten[i].antwort) || '');
  const gespraeche = a(0), zeit = a(2), partner = a(3), wunsch = a(4);
  if (partner.startsWith('Eher nicht')) return ERGEBNIS.A;
  if (partner.startsWith('Weiß ich noch nicht') || wunsch.startsWith('Klarheit')) return ERGEBNIS.B;
  const ernst = gespraeche.includes('Streit') || gespraeche.includes('kaum') || zeit === 'Fast nie';
  if (partner.startsWith('Ja') && ernst) return ERGEBNIS.C;
  return ERGEBNIS.D;
}

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
  const listId = Number(process.env.BREVO_SOI_LIST_ID);
  if (!apiKey || !listId) {
    console.error('[brevo-lead] BREVO_API_KEY oder BREVO_SOI_LIST_ID fehlt in den Vercel-Umgebungsvariablen.');
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
  const minimal = {
    FIRSTNAME: vorname,
    DOI_TOKEN: makeDoiToken(email, apiKey),
    QUIZ_ERGEBNIS: quizErgebnis(Array.isArray(data.antworten) ? data.antworten : [])
  };
  const extras = {
    TELEFON: String(data.telefon || '').trim().slice(0, 50),
    QUIZ_ANTWORTEN: antworten
  };

  // Erst mit allen Feldern versuchen. Lehnt Brevo ein Zusatzfeld ab, wird mit weniger Feldern
  // erneut gespeichert, damit die Anmeldung nicht verloren geht. Vorname, DOI_TOKEN und QUIZ_ERGEBNIS sind immer dabei.
  const attempts = [
    { ...minimal, ...extras, 'DOUBLE_OPT-IN': DOI_NO },
    { ...minimal, ...extras },
    minimal
  ];
  let result;
  for (const attributes of attempts) {
    result = await sendToBrevo(apiKey, { ...base, attributes });
    if (result.ok || result.status !== 400) break;
    console.warn('[brevo-lead] Brevo lehnt Felder ab, versuche es mit weniger:', result.text);
  }

  if (!result.ok) {
    console.error('[brevo-lead] Brevo-Fehler', result.status, result.text);
    return res.status(502).json({ error: 'Speichern bei Brevo fehlgeschlagen.' });
  }
  return res.status(200).json({ ok: true });
};

module.exports.makeDoiToken = makeDoiToken;
