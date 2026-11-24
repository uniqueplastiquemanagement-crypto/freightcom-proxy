"use strict";
// Chit Chats (chitchats.com) : les colis vers les États-Unis (Alexandre, 24 nov. 2026 : « Toutes les colis aux US vont passer par là »).
// Le bac à sable de Claude ne joint pas chitchats.com : tout passe par la passerelle, comme Freightcom.
// Clés tapées par Alexandre dans Render : CHITCHATS_CLIENT_ID (numéro de client) et CHITCHATS_ACCESS_TOKEN (clé API).
// Elles ne sont jamais renvoyées, affichées ni journalisées. API : https://chitchats.com/docs/api/v1
// Étape 1 (1.6.0) : lecture seulement (la clé marche-t-elle ?). Rien n'est créé ni acheté chez Chit Chats.
const BASE = "https://chitchats.com/api/v1/clients/";
const ID = (process.env.CHITCHATS_CLIENT_ID || "").trim();
const JETON = (process.env.CHITCHATS_ACCESS_TOKEN || "").trim();
const idOk = () => /^\d{1,12}$/.test(ID);
const jetonOk = () => JETON.length >= 10 && !/\s/.test(JETON);
function configure() { return idOk() && jetonOk(); }
function etatPublic() { return { configure: configure() }; }

async function appel(methode, chemin, corps) {
  if (!configure()) throw new Error("Chit Chats pas configuré");
  const r = await fetch(BASE + ID + chemin, {
    method: methode,
    headers: Object.assign({ Authorization: JETON, Accept: "application/json" }, corps ? { "Content-Type": "application/json; charset=utf-8" } : {}),
    body: corps ? JSON.stringify(corps) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const texte = await r.text();
  let json = null; try { json = JSON.parse(texte); } catch { /* réponse vide ou pas en JSON */ }
  return { status: r.status, json };
}

// Lecture seulement : nombre d'envois du compte. 200 = la clé et le numéro de client marchent.
async function etat() {
  if (!idOk()) return { configure: false, raison: ID ? "CHITCHATS_CLIENT_ID n'est pas un nombre (seulement le numéro après « clients/ »)" : "CHITCHATS_CLIENT_ID absent" };
  if (!jetonOk()) return { configure: false, raison: JETON ? "CHITCHATS_ACCESS_TOKEN illisible (espace dedans ?)" : "CHITCHATS_ACCESS_TOKEN absent" };
  try {
    const r = await appel("GET", "/shipments/count");
    const n = r.json && (r.json.count != null ? r.json.count : null);
    return { configure: true, joignable: r.status === 200, statut_http: r.status, envois: Number.isFinite(Number(n)) ? Number(n) : null,
      raison: r.status === 200 ? null : r.status === 401 ? "clé refusée par Chit Chats" : r.status === 404 ? "numéro de client inconnu de Chit Chats" : "réponse inattendue de Chit Chats" };
  } catch (e) {
    return { configure: true, joignable: false, raison: "Chit Chats injoignable : " + String((e && e.message) || e).slice(0, 100) };
  }
}

module.exports = { configure, etatPublic, etat, appel };
