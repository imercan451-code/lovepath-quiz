// Vercel-Funktion: Bestätigungslink aus der Single-Opt-in-Mail.
// Prüft den Code, verschiebt den Kontakt von der Single-Opt-in-Liste (unbestätigt) in die
// Double-Opt-in-Liste (bestätigt) und setzt das Brevo-Feld DOUBLE_OPT-IN auf "Ja".
// Benötigte Umgebungsvariablen: BREVO_API_KEY, BREVO_SOI_LIST_ID (Single-Opt-in), BREVO_DOI_LIST_ID (Double-Opt-in).

const crypto = require('crypto');
const { makeDoiToken } = require('./brevo-lead.js');

const BREVO_API = 'https://api.brevo.com/v3';
const DOI_YES = 1; // Brevo-Standardfeld DOUBLE_OPT-IN: 1 = Ja, 2 = Nein

function emailFromToken(token, secret) {
  const [payload] = String(token || '').split('.');
  if (!payload) return null;
  let email;
  try { email = Buffer.from(payload, 'base64url').toString('utf8'); } catch { return null; }
  const expected = Buffer.from(makeDoiToken(email, secret));
  const given = Buffer.from(String(token));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return email;
}

async function brevo(apiKey, method, path, body) {
  const res = await fetch(BREVO_API + path, {
    method,
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

function redirect(res, path) {
  res.statusCode = 303;
  res.setHeader('Location', path);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

module.exports = async (req, res) => {
  const apiKey = process.env.BREVO_API_KEY;
  const soiListId = Number(process.env.BREVO_SOI_LIST_ID);
  const doiListId = Number(process.env.BREVO_DOI_LIST_ID);
  if (!apiKey || !soiListId || !doiListId) {
    console.error('[confirm] BREVO_API_KEY, BREVO_SOI_LIST_ID oder BREVO_DOI_LIST_ID fehlt.');
    return redirect(res, '/link-ungueltig.html');
  }

  const token = (req.query && req.query.t) || '';
  const email = emailFromToken(token, apiKey);
  if (!email) return redirect(res, '/link-ungueltig.html');

  const id = encodeURIComponent(email);
  const update = await brevo(apiKey, 'PUT', `/contacts/${id}`, { attributes: { 'DOUBLE_OPT-IN': DOI_YES } });
  if (!update.ok) {
    // Kontakt existiert nicht (mehr) oder Brevo ist nicht erreichbar.
    console.error('[confirm] Kontakt konnte nicht aktualisiert werden', update.status, update.text);
    return redirect(res, '/link-ungueltig.html');
  }

  // "Kontakt ist schon in der Liste" bzw. "nicht in der Liste" meldet Brevo als 400, das ist hier in Ordnung,
  // denn ein zweiter Klick auf denselben Link soll einfach wieder auf der Bestätigungsseite landen.
  const add = await brevo(apiKey, 'POST', `/contacts/lists/${doiListId}/contacts/add`, { emails: [email] });
  if (!add.ok && add.status !== 400) {
    console.error('[confirm] Hinzufügen zur Double-Opt-in-Liste fehlgeschlagen', add.status, add.text);
    return redirect(res, '/link-ungueltig.html');
  }
  const remove = await brevo(apiKey, 'POST', `/contacts/lists/${soiListId}/contacts/remove`, { emails: [email] });
  if (!remove.ok && remove.status !== 400) console.error('[confirm] Entfernen aus Single-Opt-in-Liste fehlgeschlagen', remove.status, remove.text);

  return redirect(res, '/bestaetigt.html');
};
