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
    hs_tariff_code: "9615114000", origin_country: "CA" }],   // HTSUS 9615.11.40.00 : barrettes et articles similaires en plastique, sans fausses perles ni pierres (Chit Chats exige 10 chiffres)
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

// ---------- Étape 3 (1.7.0) : étiquette Chit Chats d'une commande hors Canada (Alexandre, 24 nov. 2026 : « Toutes les colis aux US
// vont passer par là » ; « qu'on soit worldwide » ; le moins cher, plus rapide si le client a payé un service rapide).
// Appelé par le connecteur (bouton du Poste) seulement. Mêmes verrous que Freightcom : ACHATS_ACTIVES=oui, une étiquette par commande
// (un envoi déjà payé pour cette commande est repris, jamais racheté), garde-fou technique de 500 $.
const ACHATS = () => (process.env.ACHATS_ACTIVES || "non").toLowerCase() === "oui";
const GARDE = Math.min(1000, Number(process.env.GARDE_TECHNIQUE_DOLLARS || "500") || 500);
// Certification ACEUM-31102 (approuvée le 24 nov. 2026, valide jusqu'au 24 nov. 2027) : description et code EXACTS, sinon pas de franchise.
const DOUANE = { description: "Plastic hair claw clips, recycled plastic body with metal spring", hs: "9615114000", origine: "CA" };
// Les services américains (Select, Edge…) exigent le fabricant depuis la fin de l'exemption américaine (aide de Chit Chats, 29 oct. 2026).
const FABRICANT = { manufacturer_contact: "Unique Plastique inc.", manufacturer_street: "700 Rue Jean-Marchand", manufacturer_city: "Lévis",
  manufacturer_postal_code: "G6Y 9G6", manufacturer_province_code: "QC", manufacturer_country_code: "CA" };
// Services avec suivi complet seulement (jamais Media Mail, Library Mail, ni les services sans suivi).
const SERVICES_PERMIS = /^(chit_chats_(us_(select|edge|connect|courier)|international_(tracked|select))|usps_(ground_advantage|priority|express))$/;
const PAYES = new Set(["ready", "in_transit", "received", "released", "inducted", "resolved", "delivered", "exception", "postage_requested"]);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function joursMax(d) { const m = String(d || "").match(/(\d+)\s*[-–]\s*(\d+)/); if (m) return Number(m[2]); const n = String(d || "").match(/(\d+)/); return n ? Number(n[1]) : 99; }
function choisirTarif(tarifs, express) {
  const ok = (tarifs || []).filter((t) => SERVICES_PERMIS.test(t.postage_type) && t.montant > 0);
  if (!ok.length) return null;
  if (express) { const min = Math.min(...ok.map((t) => joursMax(t.delai))); return ok.filter((t) => joursMax(t.delai) === min).sort((a, b) => a.montant - b.montant)[0]; }
  return ok.slice().sort((a, b) => a.montant - b.montant || joursMax(a.delai) - joursMax(b.delai))[0];
}
// cmd = { no, adresse (Shopify shippingAddress), colis (du moteur : longueur_po…, poids_g), valeur_cad (sous-total des articles), nb_pinces }
function envoiCommande(cmd) {
  const net = (v, n = 60) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
  const a = cmd.adresse || {}, c = cmd.colis || {};
  const personne = net(a.name || [a.firstName, a.lastName].filter(Boolean).join(" "));
  const entreprise = net(a.company).length > 1 ? net(a.company) : "";
  const q = Math.max(1, Math.round(Number(cmd.nb_pinces) || 1));
  const total = Math.max(1, Math.round((Number(cmd.valeur_cad) || 0) * 100) / 100);
  const g = Math.max(1, Math.round(Number(c.poids_g) || 0));
  const tel = String(a.phone || "").replace(/[^\d+]/g, "").slice(0, 20);
  const e = {
    name: personne || entreprise, address_1: net(a.address1), city: net(a.city, 40), country_code: String(a.countryCodeV2 || "").toUpperCase(),
    package_contents: "merchandise", description: DOUANE.description, value: total.toFixed(2), value_currency: "cad",
    order_id: String(cmd.no), order_store: "Unique Plastique",
    package_type: "parcel", size_unit: "in", size_x: Number(c.longueur_po), size_y: Number(c.largeur_po), size_z: Number(c.hauteur_po),
    weight_unit: "g", weight: g, ship_date: "today",
    line_items: [Object.assign({ quantity: q, description: DOUANE.description, value_amount: (total / q).toFixed(2), currency_code: "cad",
      weight: Math.max(1, Math.floor(g / q)), weight_unit: "g", hs_tariff_code: DOUANE.hs, origin_country: DOUANE.origine, sku_code: "UP-PINCE" }, FABRICANT)],
  };
  const a2 = [entreprise && entreprise !== e.name ? entreprise : "", net(a.address2)].filter(Boolean).join(", ").slice(0, 60);
  if (a2) e.address_2 = a2;
  if (a.provinceCode) e.province_code = String(a.provinceCode).toUpperCase().slice(0, 3);
  if (a.zip) e.postal_code = net(a.zip, 12);
  if (tel.length >= 7) e.phone = tel;
  return e;
}
function listeEnvois(j) { const l = Array.isArray(j) ? j : (j && (j.shipments || j.data)) || []; return l.map((s) => (s && s.shipment) || s).filter(Boolean); }
// Envois déjà faits chez Chit Chats pour cette commande (order_id = numéro de la commande Shopify).
async function envoisDeLaCommande(no) {
  const r = await appel("GET", `/shipments?q=${encodeURIComponent(String(no))}&limit=100`);
  if (r.status !== 200) throw new Error(`lecture des envois Chit Chats impossible (${r.status}) : achat suspendu pour ne pas acheter deux fois`);
  return listeEnvois(r.json).filter((s) => String(s.order_id || "") === String(no));
}
async function etiquettePdf(s) {
  const url = String((s && s.postage_label_pdf_url) || "");
  if (!/^https:\/\//.test(url)) return null;
  const h = new URL(url).hostname;
  // La clé ne part que vers chitchats.com (jamais vers un autre hôte, ex. un stockage de fichiers).
  const entetes = /(^|\.)chitchats\.com$/.test(h) ? { Authorization: JETON } : {};
  const r = await fetch(url, { headers: entetes, redirect: "follow", signal: AbortSignal.timeout(30000) });
  if (!r.ok) return null;
  const b = Buffer.from(await r.arrayBuffer());
  return b.subarray(0, 5).toString("latin1") === "%PDF-" ? b : null;
}
function resultat(s, deja, t) {
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v) * 100) / 100 : null);
  return { statut: deja ? "deja_achete" : "achete", raison: deja ? "étiquette Chit Chats déjà achetée pour cette commande : aucune deuxième facture" : null,
    shipment_id: "CC-" + String(s.id), transporteur: "Chit Chats", service: (t && t.service) || String(s.postage_description || s.postage_type || "").slice(0, 80),
    montant_ttc: n(s.payment_amount) ?? (t ? t.montant : null), delai: t ? t.delai : null,
    suivi: s.carrier_tracking_code || s.tracking_code || null, tracking_url: s.tracking_url || `https://chitchats.com/tracking/${s.id}` };
}
// Lot Chit Chats du jour (« UP aaaa-mm-jj ») : les colis du jour y sont ajoutés ; Canpar ramasse le lot (réservé dans le site).
const lots = new Map();
async function lotDuJour() {
  const jour = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
  const nom = `UP ${jour}`;
  if (lots.has(nom)) return lots.get(nom);
  const r = await appel("GET", "/batches?status=pending&limit=100");
  const l = (Array.isArray(r.json) ? r.json : (r.json && r.json.batches) || []).map((b) => (b && b.batch) || b);
  let b = l.find((x) => String(x.description || "") === nom);
  if (!b) {
    const c = await appel("POST", "/batches", { description: nom });
    if (c.status !== 201 && c.status !== 200) throw new Error(erreurChitChats(c));
    b = c.json && (c.json.batch || c.json);
    if (!b || b.id == null) {   // l'identifiant peut n'être que dans l'en-tête Location : relire la liste
      const r2 = await appel("GET", "/batches?status=pending&limit=100");
      b = (Array.isArray(r2.json) ? r2.json : (r2.json && r2.json.batches) || []).map((x) => (x && x.batch) || x).find((x) => String(x.description || "") === nom);
    }
  }
  if (!b || b.id == null) throw new Error("lot Chit Chats créé sans identifiant");
  lots.set(nom, { id: Number(b.id), nom });
  return lots.get(nom);
}
async function ajouterAuLot(id) {
  try {
    const lot = await lotDuJour();
    const r = await appel("PATCH", "/shipments/add_to_batch", { batch_id: lot.id, shipment_ids: [Number(id) || String(id)] });
    return r.status === 200 ? { lot: lot.nom } : { lot: null, note: `ajout au lot refusé (${r.status})` };
  } catch (e) { return { lot: null, note: "lot du jour : " + String((e && e.message) || e).slice(0, 120) }; }
}
// essai = true : crée l'envoi non payé, choisit le tarif, puis le SUPPRIME (rien n'est acheté).
async function acheterCommande(cmd, { essai = false } = {}) {
  if (!configure()) return { statut: "saute", raison: "Chit Chats pas configuré dans Render" };
  if (!essai && !ACHATS()) return { statut: "saute", raison: "achats désactivés (ACHATS_ACTIVES)" };
  const ex = await envoisDeLaCommande(cmd.no);
  const paye = ex.find((s) => PAYES.has(String(s.status)));
  if (paye) {
    if (essai) return { statut: "essai", raison: "déjà achetée chez Chit Chats", existant: resultat(paye, true) };
    let s = paye;
    for (let i = 0; i < 15 && s.status === "postage_requested"; i++) { await pause(2000); const g = await appel("GET", `/shipments/${s.id}`); s = (g.json && (g.json.shipment || g.json)) || s; }
    const res = resultat(s, true); res.pdf = await etiquettePdf(s); return res;
  }
  // Anciens envois non payés de cette commande (essais, achat interrompu) : supprimés pour repartir propre.
  for (const s of ex.filter((x) => ["unpaid", "pending", "postage_purchase_failed"].includes(String(x.status)))) { try { await supprimer(s.id); } catch { /* sans gravité */ } }
  const envoi = envoiCommande(cmd);
  const v = await creerNonPaye(envoi);
  const t = choisirTarif(v.tarifs, !!cmd.express);
  const base = { tarifs: v.tarifs.map((x) => ({ service: x.service, montant: x.montant, delai: x.delai })) };
  if (essai || !t || !(t.montant > 0) || t.montant > GARDE) {
    let suppression = null; try { suppression = await supprimer(v.id); } catch (e) { suppression = { supprime: false }; }
    if (essai) return Object.assign({ statut: "essai", choisi: t ? { service: t.service, postage_type: t.postage_type, montant: t.montant, delai: t.delai } : null, envoi: { pays: envoi.country_code, boite: `${envoi.size_x}x${envoi.size_y}x${envoi.size_z}`, poids_g: envoi.weight, valeur_cad: envoi.value, pinces: envoi.line_items[0].quantity }, suppression }, base);
    return Object.assign({ statut: "saute", raison: !t ? `aucun service Chit Chats avec suivi pour ${envoi.country_code}` : `prix anormal (${t.montant} $ ; garde-fou de ${GARDE} $) : à vérifier` }, base);
  }
  const rb = await appel("PATCH", `/shipments/${v.id}/buy`, { postage_type: t.postage_type });
  if (rb.status !== 200) { try { await supprimer(v.id); } catch { /* sans gravité */ } return Object.assign({ statut: "erreur", raison: "achat Chit Chats refusé : " + erreurChitChats(rb) }, base); }
  let s = null;
  for (let i = 0; i < 30; i++) {
    await pause(2000);
    const g = await appel("GET", `/shipments/${v.id}`);
    s = g.json && (g.json.shipment || g.json);
    if (s && (String(s.status) === "ready" || String(s.status) === "postage_purchase_failed")) break;
  }
  if (!s || String(s.status) === "postage_purchase_failed") return Object.assign({ statut: "erreur", raison: "Chit Chats n'a pas pu acheter l'affranchissement" + (s ? "" : " (pas de réponse)") }, base);
  const res = Object.assign(resultat(s, false, t), base);
  if (String(s.status) !== "ready") res.raison = "achat demandé, étiquette pas encore prête chez Chit Chats : réimprimer plus tard";
  res.pdf = await etiquettePdf(s);
  Object.assign(res, await ajouterAuLot(s.id));
  return res;
}

module.exports = { configure, etatPublic, etat, appel, creerNonPaye, supprimer, essaiTarifs, acheterCommande, _test: { envoiCommande, choisirTarif, joursMax, DOUANE } };
