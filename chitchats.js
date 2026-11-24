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

// ---------- Étape 2 (1.6.1) : tarifs. Chit Chats donne ses tarifs sur un envoi créé « non payé » (postage_type « unknown ») ;
// l'achat est une autre étape (PATCH …/buy) que ce fichier n'appelle JAMAIS pour l'instant.
const RE_ID = /^[A-Za-z0-9_-]{1,40}$/;
function vueTarif(t) {
  const n = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  return { postage_type: String(t.postage_type || ""), service: String(t.postage_description || "").slice(0, 80), delai: String(t.delivery_time_description || "").slice(0, 60),
    montant: n(t.payment_amount), port: n(t.postage_fee), assurance: n(t.insurance_fee), taxe: n(t.federal_tax), assure: !!t.is_insured };
}
function vueEnvoi(s) {
  return { id: s && s.id != null ? String(s.id) : null, statut: s && s.status ? String(s.status) : null,
    tarifs: Array.isArray(s && s.rates) ? s.rates.map(vueTarif).sort((a, b) => (a.montant ?? 1e9) - (b.montant ?? 1e9)) : [] };
}
function erreurChitChats(r) {
  const j = r.json || {};
  const m = j.error && (j.error.message || j.error) || j.message || j.errors;
  return `Chit Chats ${r.status}` + (m ? ` : ${JSON.stringify(m).slice(0, 300)}` : "");
}
// Crée un envoi NON PAYÉ et renvoie ses tarifs (rien n'est acheté).
async function creerNonPaye(envoi) {
  const corps = Object.assign({}, envoi, { postage_type: "unknown" });
  delete corps.cheapest_postage_type_requested;
  const r = await appel("POST", "/shipments", corps);
  if (r.status !== 201 && r.status !== 200) throw new Error(erreurChitChats(r));
  let s = r.json && (r.json.shipment || r.json);
  let v = vueEnvoi(s);
  if (!v.id || !RE_ID.test(v.id)) throw new Error("Chit Chats : envoi créé sans identifiant lisible");
  if (!v.tarifs.length) {   // tarifs pas encore là : les redemander sur le même envoi (toujours rien d'acheté)
    const r2 = await appel("PATCH", `/shipments/${v.id}/refresh`, {});
    s = r2.json && (r2.json.shipment || r2.json);
    if (r2.status === 200 && s) v = Object.assign(v, { tarifs: vueEnvoi(s).tarifs, statut: vueEnvoi(s).statut || v.statut });
  }
  return v;
}
async function supprimer(id) {
  if (!RE_ID.test(String(id))) throw new Error("identifiant d'envoi invalide");
  const r = await appel("DELETE", `/shipments/${id}`);
  return { supprime: r.status === 200 || r.status === 204, statut_http: r.status };
}
// Essai demandé par Alexandre (24 nov. 2026, « Oui, fais l'essai ») : adresse américaine fictive, 12x9x4, 1 lb, 1 pince.
// Crée l'envoi non payé, lit les tarifs, le supprime aussitôt. Jamais d'achat.
const ENVOI_ESSAI = {
  name: "Essai Unique Plastique", address_1: "100 Main St", city: "Plattsburgh", province_code: "NY", postal_code: "12901", country_code: "US",
  package_contents: "merchandise", description: "Plastic hair clip", value: "15.00", value_currency: "cad", order_id: "ESSAI-TARIFS",
  package_type: "parcel", size_unit: "in", size_x: 12, size_y: 9, size_z: 4, weight_unit: "lb", weight: 1, ship_date: "today",
  line_items: [{ quantity: 1, description: "Plastic hair clip (recycled plastic)", value_amount: "15.00", currency_code: "cad", weight: 1, weight_unit: "lb",
    hs_tariff_code: "9615.11", origin_country: "CA" }],
};
async function essaiTarifs() {
  if (!configure()) return { ok: false, raison: "Chit Chats pas configuré" };
  let v = null, err = null;
  try { v = await creerNonPaye(ENVOI_ESSAI); } catch (e) { err = String((e && e.message) || e).slice(0, 400); }
  if (!v) return { ok: false, raison: err };
  let suppression;
  try { suppression = await supprimer(v.id); } catch (e) { suppression = { supprime: false, raison: String(e.message || e).slice(0, 100) }; }
  return Object.assign({ ok: true }, v, { suppression });
}

module.exports = { configure, etatPublic, etat, appel, creerNonPaye, supprimer, essaiTarifs };
