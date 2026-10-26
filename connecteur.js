"use strict";
// Connecteur du Poste d'expédition (MCP) — Unique Plastique inc. — 2026-10-26
//
// Le Poste (page claude.ai) appelle ces outils au clic « Acheter et imprimer les étiquettes 4×6 » :
//   lancer_lot {lot_id, commandes[], regle}  -> démarre le lot en arrière-plan et répond tout de suite
//   etat_lot   {lot_id}                       -> avancement, résultats (sans nom ni adresse), PDF prêt ou non
//   pdf_lot    {lot_id, partie}               -> le PDF 4×6 fusionné, en morceaux base64
//   tarifs_shopify {commandes[{no, cle}]}     -> prix Shopify contre-vérifiés (magasinage.js), pour l'affichage du Poste
//   etat       {}                             -> réglages de la passerelle et du magasinage
//
// Garde-fous :
// - adresse secrète /mcp/<jeton> (jeton = MCP_JETON, sinon dérivé de PROXY_KEY) ; mauvais jeton = 404 ;
// - environnement : « test » = bac à sable ; « production » = VRAIES étiquettes, payées par FREIGHTCOM_PAIEMENT (permis depuis
//   le 26 oct. 2026, demande d'Alexandre : « fait fonctionner le bouton ») ; en production, la passerelle exige aussi l'app Shopify ;
// - les commandes sont relues dans Shopify par la passerelle (app « client credentials », LECTURE seulement) :
//   le Poste n'envoie que des numéros ; adresse, téléphone et total viennent de Shopify ;
// - chaque étape passe par les routes de la passerelle (127.0.0.1) avec TOUS leurs verrous : ACHATS_ACTIVES, une étiquette
//   par commande, plafond du jour, tarif coté par la passerelle pour ce même envoi, garde-fou technique de prix, environnement ;
// - un refus de Freightcom n'est jamais relayé tel quel (il peut citer le client) : code HTTP et noms des champs seulement ;
// - le moins cher gagne, Shopify ou Freightcom : prix Shopify contre-vérifié (magasinage.js) s'il y en a un, sinon
//   l'estimation de la table Shopify mesurée (table_shopify.js : même boîte, même poids, même région, même origine,
//   transporteurs permis ; aucune lecture, aucun crédit) contre le prix Freightcom réel du même envoi ; Shopify n'est retenu
//   sur estimation que s'il bat Freightcom d'au moins la marge (MARGE_ESTIMATION_CENTS) ; région, boîte, poids ou origine
//   absents de la table = pas d'estimation (B2C : Freightcom ; B2B : Shopify, comme avant). Payée ou non,
//   une vraie commande peut avoir son étiquette (26 oct. 2026) ;
//   Shopify moins cher = rien n'est acheté ici (statut shopify_moins_cher, lien vers la commande) ;
// - aucune écriture Shopify, aucun ramassage, aucun courriel ;
// - le journal ne contient ni nom, ni adresse, ni téléphone, ni jeton ; les résultats renvoyés au Poste non plus.
const crypto = require("crypto");
const B = require("./base");
const magasinage = require("./magasinage");
// Module de la table Shopify : s'il manque ou plante au chargement, le connecteur et la passerelle restent debout (pas d'estimation).
let TS = null;
try { TS = require("./table_shopify"); } catch { /* signalé par l'outil etat */ }
const { M, erreurMoteur, SHOP, appShopify, shopify, REQ_COMMANDES, cpNorm, maintenant, arrondi, egal } = B;
let PDFDocument = null;
try { ({ PDFDocument } = require("pdf-lib")); } catch { /* signalé par l'outil etat */ }

const VERSION = "1.3.0";
const PORT = process.env.PORT || 10000;
const PROXY_KEY = process.env.PROXY_KEY || "";
const ENV = (process.env.FREIGHTCOM_ENV || "test").toLowerCase();
const ACHATS_ACTIVES = (process.env.ACHATS_ACTIVES || "non").toLowerCase() === "oui";
// Téléphone de l'usine imprimé sur l'étiquette : ORIGINE_TELEPHONE ; à défaut, en production, celui de la boutique dans
// Shopify (26 oct. 2026) ; en test, un numéro fictif.
const TEL_USINE = (process.env.ORIGINE_TELEPHONE || (ENV === "production" ? "5815805182" : "")).replace(/\D/g, "").slice(-10);
const TEL_ORIGINE = TEL_USINE.length === 10 ? TEL_USINE : (ENV === "test" ? "4185550100" : "");   // numéro fictif permis en test seulement
const MAX_LOT = 15;
// Plus de plafond de prix (décision d'Alexandre, 2026-10-26 : « y'a pas vraiment de max, faut juste que ce soit le moins cher »).
// Reste un garde-fou TECHNIQUE (taxes incluses) qui n'attrape qu'une erreur de calcul (des cents lus comme des dollars) ;
// la passerelle applique le même.
const GARDE_TECHNIQUE = Math.min(1000, Number(process.env.GARDE_TECHNIQUE_DOLLARS || "500") || 500);
// Moyen de paiement Freightcom (décision d'Alexandre, 26 oct. 2026 : solde prépayé à rechargement automatique). Valeurs
// permises : prepaid, credit-card, net-terms. Toute autre valeur : aucun achat (le lot s'arrête avec un message clair).
const MOYEN_PAIEMENT = (process.env.FREIGHTCOM_PAIEMENT || "prepaid").trim().toLowerCase();
const MOYEN_PAIEMENT_OK = ["prepaid", "credit-card", "net-terms"].includes(MOYEN_PAIEMENT);
const SERVICES = ["ups.standard", "ups.ground", "ups.expedited", "ups.express", "ups.express-saver", "gls.ground",
  "canadapost.expedited-parcel", "canadapost.regular-parcel", "canadapost.priority", "canadapost.xpresspost",
  "canadapost-exclusive.expedited-parcel", "canadapost-exclusive.regular-parcel", "canadapost-exclusive.priority", "canadapost-exclusive.xpresspost"];
// SEUIL : plus de plafond (voir plus haut). PAIEMENT : une commande pas encore payée est permise (décision d'Alexandre, 26 oct. 2026).
const RAISONS_PERMISES = new Set(["REGLE_ESSAI", "INCOMPLET", "SEUIL", "PAIEMENT"]);
const PAUSE = Math.max(10, Number(process.env.CONNECTEUR_PAUSE_MS || 5000)); // attente entre deux lectures chez Freightcom
const RE_LOT = /^L\d{8}-\d{6}-[a-z0-9]{4}$/;
// Table des prix Shopify mesurés (fichier table_shopify.json livré avec le code). Absente ou invalide : pas d'estimation.
let TABLE_SH = null, ERREUR_TABLE = null;
if (!TS) ERREUR_TABLE = "module table_shopify.js absent ou illisible";
else try { TABLE_SH = TS.charger(); } catch (e) { if (!(e && e.code === "ENOENT")) ERREUR_TABLE = String((e && e.message) || e).slice(0, 200); }
// Shopify n'est retenu sur estimation que s'il bat Freightcom d'au moins cette marge (dérive des surcharges de carburant,
// arrondis) : le plus grand de 25 cents et 3 % du prix Shopify estimé. Comparaison en cents entiers.
const MARGE_ESTIMATION_CENTS = (cents) => Math.max(25, Math.round(cents * 0.03));
function estimationShopify(p, regle) {
  if (!TABLE_SH) return { ok: false, raison: ERREUR_TABLE ? "table Shopify illisible" : "table Shopify absente" };
  const d = p.destination || {};
  const colis = p.colis && p.colis.length ? p.colis : (p.boite ? [{ poids_lb: p.poids_lb, longueur_po: p.boite.longueur_po, largeur_po: p.boite.largeur_po, hauteur_po: p.boite.hauteur_po }] : []);
  const transporteurs = ((regle && regle.transporteurs_permis) || []).map(M.transporteurCanonique);
  try { return TS.estimer(TABLE_SH, { colis, code_postal: d.code_postal, pays: d.pays, origine_cp: p.origine_cp, transporteurs, rapide: !!p.express }); }
  catch (e) { return { ok: false, raison: "estimation impossible" }; }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function journal(t) { console.log(new Date().toISOString(), "CONNECTEUR", t); }

function jetonConnecteur() {
  const e = (process.env.MCP_JETON || "").trim();
  if (e) return e.length >= 32 ? e : null;
  if (!PROXY_KEY) return null;
  return crypto.createHmac("sha256", PROXY_KEY).update("connecteur-mcp-poste-v1").digest("hex").slice(0, 48);
}

// Diagnostic de l'app Shopify pour l'outil etat : la dernière commande est-elle lisible, avec son adresse ?
// (données client protégées de Shopify : sans accès, nom et adresse reviennent vides). Ne renvoie que des oui/non.
let diagShop = { a: 0, v: null };
async function diagnosticShopify() {
  if (!appShopify()) return null;
  if (diagShop.v && Date.now() - diagShop.a < 10 * 60e3) return diagShop.v;
  let v;
  try {
    const d = await shopify("{ orders(first: 1, sortKey: CREATED_AT, reverse: true) { nodes { shippingAddress { name address1 phone } } } }", {});
    const a = ((d && d.orders && d.orders.nodes) || [])[0];
    const sa = (a && a.shippingAddress) || null;
    v = { lecture_commandes: true, adresse_visible: !!(sa && sa.address1), nom_visible: !!(sa && sa.name), telephone_visible: !!(sa && sa.phone), erreur: null };
  } catch (e) { v = { lecture_commandes: false, adresse_visible: false, nom_visible: false, telephone_visible: false, erreur: String((e && e.message) || e).slice(0, 160) }; }
  diagShop = { a: Date.now(), v };
  return v;
}

// ---------- Appels aux routes de la passerelle (mêmes verrous que de l'extérieur) ----------
async function passerelle(method, chemin, { corps, entetes = {}, brut = false } = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}${chemin}`, {
    method, headers: Object.assign({ "x-proxy-key": PROXY_KEY }, corps ? { "content-type": "application/json" } : {}, entetes),
    body: corps ? JSON.stringify(corps) : undefined, signal: AbortSignal.timeout(130000),
  });
  if (brut) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, texte: t, refusPasserelle: r.headers.get("x-passerelle") === "refus" };
}

// ---------- Date d'expédition (heure de Toronto) : aujourd'hui en semaine avant 16 h, sinon le prochain jour ouvrable ----------
function dateExpedition(m = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(m).map((x) => [x.type, x.value]));
  let d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  const ouvrable = (x) => x.getUTCDay() >= 1 && x.getUTCDay() <= 5;
  if (!(ouvrable(d) && +p.hour < 16)) { do { d = new Date(d.getTime() + 864e5); } while (!ouvrable(d)); }
  return d.toISOString().slice(0, 10);
}

// ---------- Adresse : signaux, vérification geocoder.ca par la passerelle, classement (consigne de la tâche, étape 2 b2) ----------
const LETTRES_PROV = { QC: "GHJ", ON: "KLMNP", NB: "E", NS: "B", PE: "C", NL: "A", MB: "R", SK: "S", AB: "T", BC: "V", YT: "Y", NT: "X", NU: "X" };
const S_NOM = "nom de livraison vide", S_VILLE = "ville répétée dans l'adresse", S_CIVIQUE = "numéro civique absent";
function signauxAdresse(a) {
  const s = [];
  const v = String(a.validationResultSummary || "").toUpperCase();
  if (v === "WARNING" || v === "ERROR") s.push(`Shopify signale l'adresse (${v})`);
  const cp = cpNorm(a.zip);
  if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(cp)) s.push("code postal hors du format A1A 1A1");
  else { const l = LETTRES_PROV[String(a.provinceCode || "").toUpperCase()]; if (l && !l.includes(cp[0])) s.push("code postal incohérent avec la province"); }
  if (String(a.name || a.company || "").trim().length <= 1) s.push(S_NOM);
  const a1 = M.norm(a.address1), ville = M.norm(a.city);
  if (ville.length >= 4 && a1.includes(ville)) s.push(S_VILLE);
  if (!/\d/.test(String(a.address1 || ""))) s.push(S_CIVIQUE);
  return s;
}
// Seulement « numéro civique + rue » pour geocoder.ca : jamais l'appartement (règle 7 de la tâche).
const MOTS_APP = "app|apt|appart|appartement|unit|unite|unité|suite|bureau|logement|log";
function civiqueEtRue(a1) {
  let t = String(a1 || "").replace(/\s+/g, " ").trim();
  t = t.replace(new RegExp(`^(?:${MOTS_APP})\\.?\\s*[\\w-]+\\s*[,-]?\\s*`, "i"), "").replace(/^#\s*[\w-]+\s*[,-]?\s*/, "");
  t = t.replace(/^[A-Za-z]?\d+[A-Za-z]?\s*-\s*(?=\d)/, "");                           // « 4-123 rue X » -> « 123 rue X »
  t = t.replace(new RegExp(`[,\\s]+(?:(?:${MOTS_APP})\\.?|#)\\s*[\\w-]+\\s*$`, "i"), "");
  return t.replace(/[^\p{L}\p{N} .,'’#\/()&-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}
function numeroCivique(t) { const m = String(t || "").match(/^\s*(\d{1,6})/); return m ? m[1] : null; }
const MOTS_VOIE = new Set(["rue", "r", "avenue", "av", "ave", "boulevard", "boul", "bd", "blvd", "chemin", "ch", "route", "rte", "rang", "place", "pl", "croissant", "cr", "cres", "crescent", "impasse", "imp", "terrasse", "allee", "montee", "cote", "carre", "promenade", "street", "st", "road", "rd", "drive", "dr", "court", "ct", "lane", "ln", "way", "de", "du", "des", "la", "le", "les", "l", "d", "et", "est", "ouest", "nord", "sud", "e", "o", "n", "s", "w"]);
function jetonsRue(t) {
  return M.norm(t).replace(/\bste\b\.?/g, "sainte").replace(/\bst\b\.?(?=\s*-\s*[a-z])/g, "saint").split(/[^a-z0-9]+/).filter((x) => x && !MOTS_VOIE.has(x) && !/^\d+[a-z]?$/.test(x));
}
function rueEgale(rueGeo, adr) { const g = jetonsRue(rueGeo), a = new Set(jetonsRue(adr)); return g.length > 0 && g.every((x) => a.has(x)); }
const villeNorm = (v) => M.norm(v).replace(/\bste\b\.?/g, "sainte").replace(/\bst\b\.?/g, "saint").replace(/[^a-z0-9]/g, "");
const QUESTION = "Pouvez-vous confirmer votre adresse de livraison complète (numéro, rue, appartement s'il y a lieu, ville et code postal) ?";

async function verifierAdresseCommande(a, lotId) {
  const signaux = signauxAdresse(a);
  if (!signaux.length) return { ok: true };
  const base = { source: "geocoder.ca (passerelle)", le: maintenant(), lot: lotId };
  const sc = (pourquoi, essais, question = QUESTION) => ({ ok: false, verif: Object.assign({ resultat: "service_client", probleme: signaux.concat(pourquoi ? [pourquoi] : []).join(" ; "), demander_au_client: question, essais }, base) });
  if (signaux.includes(S_NOM)) return sc(null, 0, "Pouvez-vous confirmer le nom du destinataire et votre adresse de livraison complète ?");
  if (signaux.includes(S_CIVIQUE)) return sc(null, 0);
  const adr = civiqueEtRue(a.address1), civ = numeroCivique(adr);
  if (!civ || adr.length < 4) return sc("numéro civique illisible", 0);
  const r = await passerelle("POST", "/adresse", { corps: { adresse: adr, ville: String(a.city || "").replace(/[^\p{L}\p{N} .,'’#\/()&-]/gu, " ").trim().slice(0, 120), province: String(a.provinceCode || "").toUpperCase() } });
  const g = r.status === 200 ? r.json : null;
  if (!g) return sc(`vérification impossible (passerelle ${r.status})`, 1);
  if (!g.reconnue) return sc("adresse non reconnue par geocoder.ca", 1);
  if (!(g.confiance >= 0.9)) return sc("geocoder.ca peu sûr", 1);
  if (String(g.numero || "").replace(/\D/g, "") !== civ) return sc("numéro civique différent selon geocoder.ca", 1);
  if (!rueEgale(g.rue, adr)) return sc("rue différente selon geocoder.ca", 1);
  const cpG = cpNorm(g.code_postal);
  if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(cpG)) return sc("code postal non confirmé par geocoder.ca", 1);
  const champs = [], props = [];
  if (cpG !== cpNorm(a.zip)) { champs.push("zip"); props.push(`code postal → ${cpG.slice(0, 3)} ${cpG.slice(3)}`); }
  if (g.ville && villeNorm(g.ville) !== villeNorm(a.city)) { champs.push("city"); props.push(`ville → ${String(g.ville).slice(0, 40)}`); }
  if (g.province && String(g.province).toUpperCase() !== String(a.provinceCode || "").toUpperCase()) { champs.push("provinceCode"); props.push(`province → ${String(g.province).toUpperCase().slice(0, 2)}`); }
  if (signaux.includes(S_VILLE)) { champs.push("address1"); props.push("retirer la ville répétée de la ligne d'adresse"); }
  if (!champs.length) return { ok: true, verif: Object.assign({ resultat: "verifiee", probleme: signaux.join(" ; "), essais: 1 }, base) };
  return { ok: false, correction: props.join(" ; "), verif: Object.assign({ resultat: "correction_proposee", probleme: signaux.join(" ; ") + " ; correction selon geocoder.ca", champs, proposition: props.join(" ; "), essais: 1 }, base) };
}

// Un message d'erreur renvoyé au Poste ne doit jamais contenir le nom, l'adresse ni le téléphone du client.
function propre(msg, a) {
  let t = String(msg || "").replace(/\s+/g, " ");
  for (const v of [a && a.name, a && a.company, a && a.address1, a && a.address2, a && a.firstName, a && a.lastName]) {
    const s = String(v || "").trim();
    if (s.length >= 3) t = t.split(s).join("…");
  }
  return t.replace(/\d[\d\s().-]{6,}\d/g, "…").slice(0, 160);
}
// Refus d'achat : le texte de la passerelle (en-tête « x-passerelle: refus », qu'une réponse relayée de Freightcom ne porte
// jamais) est le nôtre et ne cite aucun client ; celui de Freightcom peut répéter le nom ou l'adresse (sous n'importe quelle
// forme) : on n'en garde que le code HTTP et le NOM des champs en cause.
function messageAchat(r, a) {
  const j = r && r.json;
  if (r && r.refusPasserelle && j && typeof j.error === "string") return propre(j.error, a);
  const champs = j && j.data && typeof j.data === "object" && !Array.isArray(j.data) ? Object.keys(j.data).filter((k) => /^[A-Za-z0-9_.\[\]-]{1,80}$/.test(k)).slice(0, 5) : [];
  return `Freightcom a refusé l'achat (HTTP ${r ? r.status : "?"})` + (champs.length ? ` ; champs en cause : ${champs.join(", ")}` : "");
}

// ---------- Réponses des employés (comme avecReponses dans le Poste) : grandeurs et compositions de kits ----------
function validerAjustements(aj, nos) {
  if (aj == null) return {};
  if (typeof aj !== "object" || Array.isArray(aj)) throw new Error("ajustements illisibles");
  const out = {};
  for (const [no, v] of Object.entries(aj)) {
    if (!nos.includes(no)) continue;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`ajustements #${no} illisibles`);
    const te = Object.entries(v.tailles || {}), ce = Object.entries(v.compositions || {});
    if (te.length > 30 || ce.length > 30) throw new Error(`ajustements #${no} : trop d'entrées`);
    const t = {}, c = {};
    for (const [k, x] of te) { if (!k.trim() || k.length > 120 || !["P", "M", "G"].includes(x)) throw new Error(`ajustements #${no} : grandeur invalide`); t[k] = x; }
    for (const [k, x] of ce) {
      if (!k.trim() || k.length > 200 || !x || typeof x !== "object" || Array.isArray(x)) throw new Error(`ajustements #${no} : composition invalide`);
      const y = {};
      for (const g of ["P", "M", "G"]) { const n = x[g] == null || x[g] === "" ? 0 : Number(x[g]); if (!Number.isInteger(n) || n < 0 || n > 500) throw new Error(`ajustements #${no} : composition invalide`); if (n) y[g] = n; }
      c[k] = y;
    }
    if (te.length || ce.length) out[no] = { tailles: t, compositions: c };
  }
  return out;
}
function ajuster(cmd, regle, aj) {
  const r2 = Object.assign({}, regle, { tailles_par_titre: Object.assign({}, regle.tailles_par_titre || {}, aj.tailles || {}) });
  const nodes = [];
  for (const l of (cmd.lineItems && cmd.lineItems.nodes) || []) {
    const c = (aj.compositions || {})[l.title];
    if (!c) { nodes.push(l); continue; }
    for (const [k, mot] of [["P", "Petite"], ["M", "Moyenne"], ["G", "Grande"]]) {
      const n = Number(c[k] || 0); if (!n) continue;
      nodes.push({ title: "Pince à cheveux — " + l.title, variantTitle: mot, quantity: n * l.quantity, unfulfilledQuantity: n * Number(l.unfulfilledQuantity || 0), requiresShipping: true, lineItemGroup: null, variant: { selectedOptions: [{ name: "Grandeur", value: mot }] } });
    }
  }
  return { cmd: Object.assign({}, cmd, { lineItems: { nodes } }), regle: r2 };
}

// ---------- Un lot ----------
const lots = new Map(); // lot_id -> état (en mémoire seulement : perdu si la passerelle redémarre)
function nettoyer() { for (const [k, v] of lots) if (v.statut !== "en_cours" && Date.now() - v.cree > 6 * 3600e3) lots.delete(k); }
function vueLot(l) {
  return {
    lot_id: l.lot_id, statut: l.statut, debut_a: l.debut_a, fin_a: l.fin_a || null, etape: l.etape || null,
    progression: { faites: Object.keys(l.resultats).length, total: l.commandes.length },
    resultats: l.resultats, adresses: l.adresses, cout_total_ttc: arrondi(l.cout),
    pdf: l.pdf ? { pages: l.pages, parties: l.parties.length, octets: l.pdf.length, sha256: l.sha } : null,
    note: l.note || null, erreur: l.erreur || null, env: ENV, version_regle: l.version_regle || null, connecteur: VERSION,
    imprimante_usine: imprimanteUsine(), imprime_usine: l.imprime_usine || null,
  };
}
const rien = (raison, plus = {}) => Object.assign({ statut: "saute", raison, transporteur: null, service: null, montant_ttc: null, suivi: null, tracking_url: null, shipment_id: null, pages: 0 }, plus);
const erreur = (raison, plus = {}) => Object.assign(rien(raison, plus), { statut: "erreur" });

async function traiterLot(l, regle) {
  try {
    l.etape = "lecture des commandes dans Shopify";
    const data = await shopify(REQ_COMMANDES, { q: l.commandes.map((n) => `name:#${n}`).join(" OR ") });
    const noeuds = ((data && data.orders && data.orders.nodes) || []).filter((o) => l.commandes.includes(String(o.name || "").replace("#", "")));
    const parNo = new Map(noeuds.map((o) => [String(o.name).replace("#", ""), o]));
    const planJson = M.plan(noeuds, regle);
    l.version_regle = planJson.version_regle;
    const dateExp = dateExpedition();
    l.etape = "moyen de paiement Freightcom";
    if (!MOYEN_PAIEMENT_OK) throw new Error(`FREIGHTCOM_PAIEMENT invalide (« ${MOYEN_PAIEMENT.slice(0, 20)} ») : prepaid, credit-card ou net-terms`);
    const pm = await passerelle("GET", "/finance/payment-methods");
    const liste = Array.isArray(pm.json) ? pm.json : (pm.json && (pm.json.payment_methods || pm.json.data || pm.json.methods)) || [];
    const moyen = liste.find((x) => x && String(x.type || x.kind || "").trim().toLowerCase() === MOYEN_PAIEMENT);
    if (!moyen || !moyen.id) throw new Error(`moyen de paiement « ${MOYEN_PAIEMENT} » introuvable chez Freightcom (passerelle ${pm.status})`);
    let plafondJour = false;

    for (const no of l.commandes) {
      l.etape = `#${no}`;
      const c = parNo.get(no);
      let p = planJson.commandes.find((x) => String(x.no) === no), rUn = regle;
      if (!c || !p) { l.resultats[no] = rien("commande introuvable dans Shopify"); continue; }
      if (l.ajustements[no]) {
        try {
          const a2 = ajuster(c, regle, l.ajustements[no]); M.validerRegle(a2.regle); rUn = a2.regle;
          const b2b = p.segment === "B2B";
          p = M.planCommande(a2.cmd, rUn);
          // Une commande B2B reste B2B après les réponses des employés (le titre de ligne qui la classait a pu changer).
          if (b2b && p.segment !== "B2B") p = Object.assign({}, p, { segment: "B2B", b2b: true });
        }
        catch (e) { l.resultats[no] = rien("réponses des employés refusées : " + String(e.message || e).slice(0, 120)); continue; }
      }
      const planUn = { version_regle: rUn.version, achats_permis: rUn.achats_permis === true, commandes: [p] };
      const textes = (rs) => rs.map((r) => r.texte).join(" ; ");
      if (p.statut === "IGNORER") { l.resultats[no] = rien(textes(p.raisons || []) || "ignorée"); continue; }
      // Estimation Shopify par la table mesurée (aucune lecture, aucun crédit). B2B sans estimation : Shopify, comme avant.
      const estSh = estimationShopify(p, rUn);
      // B2B sans estimation Shopify : reste dans Shopify, comme avant. (Payée ou non n'empêche plus l'achat : 26 oct. 2026.)
      if (p.segment === "B2B" && !estSh.ok) {
        l.resultats[no] = rien(`commande B2B : étiquette par Shopify (${estSh.raison})`); continue;
      }
      if (!p.a_soumissionner) { l.resultats[no] = rien(textes((p.raisons || []).filter((r) => !RAISONS_PERMISES.has(r.code))) || "à traiter à la main"); continue; }
      const bloquantesPlan = (p.raisons || []).filter((r) => !RAISONS_PERMISES.has(r.code));
      if (bloquantesPlan.length) { l.resultats[no] = rien(textes(bloquantesPlan)); continue; }
      if (plafondJour) { l.resultats[no] = erreur("plafond d'achats du jour atteint : prochain lot demain"); continue; }
      const a = c.shippingAddress || {};

      // Adresse (seulement s'il y a un signal)
      const adr = await verifierAdresseCommande(a, l.lot_id);
      if (adr.verif) l.adresses[no] = adr.verif;
      if (!adr.ok) { l.resultats[no] = rien(adr.correction ? `adresse : correction proposée (${adr.correction})` : "adresse à confirmer avec le client"); continue; }

      // Tarifs Freightcom
      const dem = M.demandeFreightcom(p, rUn, dateExp);
      const r1 = await passerelle("POST", "/rate", { corps: Object.assign({}, dem, { services: SERVICES }) });
      const rid = r1.json && (r1.json.request_id || r1.json.id);
      if (!rid || !/^[A-Za-z0-9_-]{1,80}$/.test(String(rid))) { l.resultats[no] = erreur(`demande de tarifs refusée (passerelle ${r1.status})`); continue; }
      let rep = null;
      for (let i = 0; i < 24 && !rep; i++) {
        await pause(PAUSE);
        const r2 = await passerelle("GET", `/rate/${rid}`);
        if (r2.json && r2.json.status && r2.json.status.done) rep = r2.json;
      }
      if (!rep) { l.resultats[no] = erreur("Freightcom n'a pas donné ses tarifs à temps"); continue; }
      const releve = maintenant();
      const tarifs = M.extraireFreightcom(rep, p).tarifs.map((t) => Object.assign({ no: p.no, cle: p.cle }, t, { releve_le: releve }));
      // Prix Shopify contre-vérifiés (deux lectures concordantes du calculateur, mêmes boîtes, même poids, même origine) :
      // ils entrent dans la même décision du moteur que Freightcom (le moins cher avant taxes parmi UPS, GLS et Postes Canada).
      const sh = magasinage.tarifsVerifies(no, p.cle);
      const dec = M.decision(planUn, sh.ok ? tarifs.concat(sh.tarifs) : tarifs, rUn).commandes.find((x) => String(x.no) === no);
      const decFc = sh.ok ? M.decision(planUn, tarifs, rUn).commandes.find((x) => String(x.no) === no) : dec;
      const fc = decFc && (decFc.gagnant || decFc.meilleur_indicatif);
      const raisons = (dec && dec.raisons) || [];
      const bloquantes = raisons.filter((r) => !RAISONS_PERMISES.has(r.code));
      const retenu = dec && (dec.gagnant || dec.meilleur_indicatif);
      const estime = !sh.ok && estSh.ok;
      const comparaison = { shopify: sh.ok ? "contre-vérifié" : (estSh.ok ? "estimé" : sh.raison), freightcom_ht: fc ? fc.montant : null,
        shopify_estime_ht: estSh.ok ? estSh.montant : null,
        estimation: estSh.ok ? { table: estSh.table, approx: estSh.approx, borne: estSh.borne, marge: MARGE_ESTIMATION_CENTS(estSh.cents) / 100 } : { raison: estSh.raison } };
      const lien = `https://admin.shopify.com/store/${SHOP}/orders/${String(c.id).split("/").pop()}`;
      // Shopify sur estimation : il bat le meilleur Freightcom admissible d'au moins la marge, ou Freightcom n'a rien d'admissible
      // (aucun tarif, ou aucun tarif rapide pour un client qui a payé un service rapide : l'estimation applique le même filtre).
      const fcRien = bloquantes.length > 0 || !retenu;
      const viaEstimation = estime && (fcRien || estSh.cents + MARGE_ESTIMATION_CENTS(estSh.cents) < Math.round(Number(retenu.montant) * 100));
      if (viaEstimation) {
        const pourquoi = !fcRien ? `Shopify devrait être moins cher (prix mesurés le ${TABLE_SH.mesure_le}) : acheter l'étiquette dans Shopify`
          : `Freightcom n'a aucun tarif admissible (${textes(bloquantes) || "aucun tarif"} ; vérifier l'adresse) ; Shopify, prix estimé : acheter l'étiquette dans Shopify si l'adresse est bonne`;
        l.resultats[no] = rien(pourquoi, { statut: "shopify_moins_cher",
          transporteur: estSh.transporteur, service: estSh.service, montant_ht: estSh.montant, lien, comparaison: Object.assign(comparaison, { estime: true, freightcom_rien: fcRien }) });
        continue;
      }
      if (bloquantes.length || !retenu) { l.resultats[no] = rien(textes(bloquantes) || "aucun tarif admissible (UPS, GLS, Postes Canada)", { comparaison }); continue; }
      if (retenu.plateforme === "shopify") {
        l.resultats[no] = rien("Shopify est moins cher : acheter l'étiquette dans Shopify", { statut: "shopify_moins_cher", transporteur: retenu.transporteur,
          service: retenu.service, montant_ht: retenu.montant, lien, comparaison });
        continue;
      }
      if (!retenu.service_id) { l.resultats[no] = rien("aucun tarif Freightcom admissible", { comparaison }); continue; }
      const choisi = tarifs.find((t) => t.service_id === retenu.service_id) || {};
      const ttc = Number(choisi.total_taxes_incluses);
      const base = { transporteur: retenu.transporteur, service: retenu.service, montant_ttc: Number.isFinite(ttc) ? ttc : null, montant_ht: retenu.montant, comparaison };
      if (!(ttc > 0) || ttc > GARDE_TECHNIQUE) { l.resultats[no] = rien(`prix anormal (${Number.isFinite(ttc) ? ttc.toFixed(2) : "?"} $ taxes incluses ; garde-fou technique de ${GARDE_TECHNIQUE} $) : à vérifier`, base); continue; }

      // Achat (une étiquette par commande ; la passerelle refuse un 2e achat, un service qu'elle n'a pas vu et un prix anormal)
      if (!TEL_ORIGINE) { l.resultats[no] = erreur("téléphone de l'usine manquant (ORIGINE_TELEPHONE) : achat refusé", base); continue; }
      const det = JSON.parse(JSON.stringify(dem.details));
      det.origin.contact_name = "Unique Plastique";
      det.origin.phone_number = { number: TEL_ORIGINE, extension: "" };
      det.origin.email_addresses = [];
      const nom = String(a.name || a.company || "").replace(/\s+/g, " ").trim().slice(0, 60);
      det.destination.name = nom; det.destination.contact_name = nom;
      det.destination.phone_number = { number: String(a.phone || "").replace(/\D/g, "").slice(-10) || TEL_ORIGINE, extension: "" };
      det.destination.email_addresses = [];
      det.destination.signature_requirement = "not-required";
      if (a.address2) det.destination.address.address_line_2 = String(a.address2).replace(/\s+/g, " ").trim().slice(0, 60);
      const cle = "UP-" + String(c.id).split("/").pop();
      const r3 = await passerelle("POST", "/shipment", { corps: { unique_id: cle, payment_method_id: moyen.id, service_id: retenu.service_id, details: det }, entetes: { "x-cle-idempotence": cle } });
      let sid = null, deja = false;
      if (r3.status === 429) { plafondJour = true; l.resultats[no] = erreur("plafond d'achats du jour atteint : prochain lot demain", base); continue; }
      if (r3.status === 409) {
        const prec = r3.json && r3.json.precedent;
        if (!prec || !prec.id) { l.resultats[no] = erreur("déjà achetée selon la passerelle, introuvable ici : vérifier dans Freightcom", base); continue; }
        sid = String(prec.id); deja = true;
      } else {
        sid = r3.json && (r3.json.id || (r3.json.shipment && r3.json.shipment.id));
        if (!(r3.status >= 200 && r3.status < 300) || !sid) { l.resultats[no] = erreur("achat refusé : " + messageAchat(r3, a), base); continue; }
        sid = String(sid); deja = !!(r3.json && r3.json.previously_created);
      }
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(sid)) { l.resultats[no] = erreur("identifiant d'envoi inattendu : vérifier dans Freightcom", base); continue; }

      // Étiquette
      let env = null;
      for (let i = 0; i < 12 && !env; i++) {
        const r4 = await passerelle("GET", `/shipment/${sid}`);
        const s = r4.json && (r4.json.shipment || r4.json);
        if (s && Array.isArray(s.labels) && s.labels.length) env = s; else await pause(PAUSE);
      }
      const rate = (env && env.rate) || {};
      const res = Object.assign({}, base, {
        statut: deja ? "deja_achete" : "achete", raison: deja ? "achat déjà fait pour cette commande : aucune deuxième facture" : null, shipment_id: sid,
        transporteur: rate.carrier_name || base.transporteur, service: rate.service_name || base.service,
        montant_ttc: rate.total && /^\d+$/.test(String(rate.total.value)) ? Number(rate.total.value) / 100 : base.montant_ttc,
        suivi: (env && env.primary_tracking_number) || null, tracking_url: (env && env.tracking_url) || null,
        achete_a: maintenant(), essai: ENV === "test", pages: 0 });
      if (!deja && Number.isFinite(res.montant_ttc)) l.cout += res.montant_ttc;
      const r5 = env ? await passerelle("GET", `/shipment/${sid}/etiquette`, { brut: true }) : null;
      if (r5 && r5.status === 200 && r5.buf.subarray(0, 5).toString("latin1") === "%PDF-") { l.pdfs.push(r5.buf); res.pages = 1; }
      else res.raison = (res.raison ? res.raison + " ; " : "") + "étiquette achetée mais PDF non récupéré";
      l.resultats[no] = res;
    }

    // Un seul PDF, dans l'ordre du lot
    if (l.pdfs.length) {
      l.etape = "assemblage du PDF";
      if (!PDFDocument) throw new Error("bibliothèque pdf-lib absente : PDF non assemblé");
      const doc = await PDFDocument.create();
      const tailles = new Set();
      for (const b of l.pdfs) {
        const src = await PDFDocument.load(b);
        for (const pg of await doc.copyPages(src, src.getPageIndices())) { doc.addPage(pg); const s = pg.getSize(); tailles.add(`${Math.round(s.width)}×${Math.round(s.height)}`); }
      }
      l.pdf = Buffer.from(await doc.save());
      l.pages = doc.getPageCount();
      l.sha = crypto.createHash("sha256").update(l.pdf).digest("hex");
      const b64 = l.pdf.toString("base64");
      for (let i = 0; i < b64.length; i += 256 * 1024) l.parties.push(b64.slice(i, i + 256 * 1024));
      const autres = [...tailles].filter((t) => t !== "288×432");
      if (autres.length) l.note = "pages qui ne font pas 4×6 (288×432 points) : " + autres.join(", ");
    }
    l.statut = "termine";
  } catch (e) {
    l.statut = Object.keys(l.resultats).length ? "termine" : "erreur";
    l.erreur = String((e && e.message) || e).slice(0, 300);
  } finally {
    l.fin_a = maintenant(); l.etape = null; l.pdfs = [];
    const n = (s) => Object.values(l.resultats).filter((r) => r.statut === s).length;
    journal(`lot ${l.lot_id} ${l.statut} : ${n("achete")} achetée(s), ${n("deja_achete")} déjà, ${n("saute")} sautée(s), ${n("erreur")} erreur(s)${l.erreur ? " ; arrêt : " + l.erreur.slice(0, 80) : ""}`);
  }
}

// ---------- Outils ----------
const OUTILS = [
  { name: "lancer_lot", description: "Démarre l'achat des étiquettes 4×6 d'un lot du Poste d'expédition d'Unique Plastique (Freightcom : en production, de VRAIES étiquettes payées par le moyen de paiement de la passerelle ; en test, le bac à sable). La passerelle relit les commandes dans Shopify, vérifie les adresses signalées, redemande les tarifs Freightcom en direct, les compare aux prix Shopify contre-vérifiés (deux lectures concordantes du calculateur) ou, à défaut, à l'estimation de la table Shopify mesurée (même boîte, même poids, même région ; Shopify retenu seulement s'il bat Freightcom d'au moins la marge) et prend le moins cher avant taxes parmi UPS, GLS et Postes Canada, sans plafond de prix (garde-fou technique de 500 $ seulement). Freightcom moins cher : achète au plus une étiquette par commande et assemble un seul PDF. Shopify moins cher : n'achète rien et le dit (statut shopify_moins_cher). Répond tout de suite ; suivre avec etat_lot. Même lot_id = même lot (rien n'est racheté).",
    annotations: { title: "Acheter les étiquettes d'un lot", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { type: "object", additionalProperties: false, required: ["lot_id", "commandes", "regle"], properties: {
      lot_id: { type: "string", pattern: "^L\\d{8}-\\d{6}-[a-z0-9]{4}$", description: "identifiant du lot écrit par le Poste" },
      commandes: { type: "array", minItems: 1, maxItems: MAX_LOT, items: { type: "string", pattern: "^\\d{3,7}$" }, description: "numéros de commande Shopify, sans #, dans l'ordre d'impression" },
      regle: { type: "object", description: "règle des boîtes du Poste (Drive), validée par le moteur" },
      ajustements: { type: "object", description: "réponses des employés par numéro de commande : {tailles: {titre: P|M|G}, compositions: {titre: {P, M, G}}}, comme dans le Poste" } } } },
  { name: "tarifs_shopify", description: "Statut des prix Shopify lus dans le calculateur (contre-vérifiés ou non) pour des commandes du Poste, avec le moins cher permis. Lecture seulement, sans adresse.",
    annotations: { title: "Prix Shopify contre-vérifiés", readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: "object", additionalProperties: false, required: ["commandes"], properties: {
      commandes: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, required: ["no", "cle"], properties: { no: { type: "string", pattern: "^\\d{3,7}$" }, cle: { type: "string", pattern: "^[a-f0-9]{16}$" } } }, description: "numéro de commande et clé du plan (boîtes, poids, destination) calculée par le Poste" } } } },
  { name: "etat_lot", description: "Avancement d'un lot : statut (en_cours, termine, erreur), résultat par commande (sans nom ni adresse), vérifications d'adresse, PDF prêt ou non.",
    annotations: { title: "État d'un lot", readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: "object", additionalProperties: false, required: ["lot_id"], properties: { lot_id: { type: "string", pattern: "^L\\d{8}-\\d{6}-[a-z0-9]{4}$" } } } },
  { name: "pdf_lot", description: "Une partie (base64) du PDF 4×6 fusionné d'un lot terminé. Parties numérotées à partir de 0 ; le nombre de parties est dans etat_lot.",
    annotations: { title: "PDF des étiquettes", readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: "object", additionalProperties: false, required: ["lot_id", "partie"], properties: { lot_id: { type: "string", pattern: "^L\\d{8}-\\d{6}-[a-z0-9]{4}$" }, partie: { type: "integer", minimum: 0, maximum: 200 } } } },
  { name: "imprimer_document", description: "Dépose un document dans la file de l'imprimante de l'usine ; le PC de l'usine le prend et l'imprime sans clic. Type « bons_b2b » : HTML simple (sans script, image ni lien externe), imprimé en couleur sur la Brother. Type « etiquettes » : PDF 4×6 d'un ancien lot (base64), réimprimé sur l'imprimante d'étiquettes. Envoyé en parties (≤ 300 Ko chacune) ; le document est prêt quand toutes les parties sont reçues. N'achète rien et ne lit rien dans Shopify.",
    annotations: { title: "Imprimer à l'usine", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", additionalProperties: false, required: ["doc_id", "type", "partie", "parties"], properties: {
      doc_id: { type: "string", pattern: "^D\\d{8}-\\d{6}-[a-z0-9]{4}$", description: "identifiant du document écrit par le Poste" },
      type: { type: "string", enum: ["bons_b2b", "etiquettes"], description: "bons_b2b : HTML pour la Brother ; etiquettes : PDF 4×6 pour l'imprimante d'étiquettes" },
      lot: { type: "string", pattern: "^L\\d{8}-\\d{6}-[a-z0-9]{4}$", description: "etiquettes : le lot d'origine (pour le journal)" },
      partie: { type: "integer", minimum: 0, maximum: 19 }, parties: { type: "integer", minimum: 1, maximum: 20 },
      html: { type: "string", minLength: 1, maxLength: 307200, description: "bons_b2b : cette partie du document HTML" },
      base64: { type: "string", minLength: 1, maxLength: 307200, description: "etiquettes : cette partie du PDF en base64" } } } },
  { name: "etat", description: "Réglages de la passerelle et du connecteur : environnement Freightcom, achats ouverts, garde-fou technique, app Shopify branchée, magasinage Shopify (dernière lecture, signaux), lot en cours.",
    annotations: { title: "État de la passerelle", readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: "object", additionalProperties: false, properties: {} } },
];

async function appelerOutil(nom, args) {
  args = args && typeof args === "object" ? args : {};
  if (erreurMoteur) throw new Error(erreurMoteur);
  if (nom === "etat") {
    const h = await passerelle("GET", "/health");
    return Object.assign({}, h.json || {}, { connecteur: VERSION, app_shopify: appShopify(), boutique: SHOP || null, shopify: await diagnosticShopify(), pdf_lib: !!PDFDocument, telephone_usine: !!TEL_USINE, garde_technique_ttc: GARDE_TECHNIQUE, magasinage: magasinage.etat(),
      table_shopify: TABLE_SH ? { version: TABLE_SH.version, mesure_le: TABLE_SH.mesure_le, valide_jusqu_au: TABLE_SH.valide_jusqu_au, origine_cp: TABLE_SH.origine_cp, zones: Object.keys(TABLE_SH.zones).length, rta: Object.keys(TABLE_SH.rta).length, groupes: Object.keys(TABLE_SH.groupes || {}).length } : { erreur: ERREUR_TABLE || "absente" },
      lot_en_cours: [...lots.values()].some((l) => l.statut === "en_cours"), impression_usine: imprimanteUsine(), documents_a_imprimer: docsAImprimer().length });
  }
  if (nom === "tarifs_shopify") return { commandes: magasinage.etatCommandes(args.commandes) };
  if (nom === "imprimer_document") return recevoirDocument(args);
  const id = String(args.lot_id || "");
  if (!RE_LOT.test(id)) throw new Error("lot_id invalide");
  if (nom === "etat_lot") { const l = lots.get(id); if (!l) throw new Error("lot inconnu de la passerelle (redémarrée ?) : relancer le lot depuis le Poste"); return vueLot(l); }
  if (nom === "pdf_lot") {
    const l = lots.get(id); if (!l || !l.pdf) throw new Error("PDF pas prêt ou lot inconnu");
    const i = Number(args.partie); if (!Number.isInteger(i) || i < 0 || i >= l.parties.length) throw new Error("partie hors limites");
    return { lot_id: id, partie: i, parties: l.parties.length, sha256: l.sha, base64: l.parties[i] };
  }
  if (nom === "lancer_lot") {
    nettoyer();
    if (lots.has(id)) return vueLot(lots.get(id)); // même lot : on ne relance rien
    if (ENV !== "test" && ENV !== "production") throw new Error("environnement Freightcom inconnu : aucun achat");
    if (!ACHATS_ACTIVES) throw new Error("achats fermés sur la passerelle (ACHATS_ACTIVES)");
    if ([...lots.values()].some((l) => l.statut === "en_cours")) throw new Error("un autre lot est déjà en cours : attendre sa fin");
    const nos = Array.isArray(args.commandes) ? [...new Set(args.commandes.map((x) => String(x).replace("#", "").trim()))] : [];
    if (!nos.length || nos.length > MAX_LOT || !nos.every((x) => /^\d{3,7}$/.test(x))) throw new Error(`commandes : 1 à ${MAX_LOT} numéros de commande`);
    const regle = args.regle;
    if (!regle || typeof regle !== "object" || Array.isArray(regle)) throw new Error("règle des boîtes absente");
    try { M.validerRegle(regle); } catch (e) { throw new Error("règle des boîtes refusée : " + String(e.message || e).slice(0, 160)); }
    const ajustements = validerAjustements(args.ajustements, nos);
    if (!appShopify()) throw new Error("app Shopify pas encore branchée sur la passerelle (variables SHOPIFY_* sur Render)");
    const l = { lot_id: id, commandes: nos, ajustements, statut: "en_cours", debut_a: maintenant(), cree: Date.now(), resultats: {}, adresses: {}, pdfs: [], pdf: null, parties: [], pages: 0, cout: 0 };
    lots.set(id, l);
    journal(`lot ${id} lancé : ${nos.length} commande(s)`);
    traiterLot(l, JSON.parse(JSON.stringify(regle)));
    return vueLot(l);
  }
  throw new Error("outil inconnu : " + nom);
}

// ---------- MCP (HTTP « streamable », sans état, réponses JSON) ----------
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
async function repondre(msg) {
  const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
  const ko = (id, code, message) => ({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } });
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return ko(msg && msg.id, -32600, "requête JSON-RPC invalide");
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null; // notification (ex. notifications/initialized) : rien à répondre
  if (method === "initialize") {
    const v = params && VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[1];
    return ok(id, { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "freightcom-unique-plastique", title: "Freightcom UP", version: VERSION },
      instructions: `Outils du Poste d'expédition d'Unique Plastique (Freightcom, environnement ${ENV}${ENV === "production" ? " : VRAIES étiquettes payées" : ""}). N'appeler lancer_lot que sur demande explicite d'Alexandre ou depuis le bouton du Poste.` });
  }
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: OUTILS });
  if (method === "tools/call") {
    const nom = params && params.name;
    if (!OUTILS.some((o) => o.name === nom)) return ko(id, -32602, "outil inconnu : " + String(nom).slice(0, 40));
    try {
      const r = await appelerOutil(nom, params.arguments);
      journal(`outil ${nom} OK`);
      // pdf_lot : le texte seul (gros base64, pas en double) ; les autres : texte + structuredContent
      return ok(id, nom === "pdf_lot" ? { content: [{ type: "text", text: JSON.stringify(r) }], isError: false }
        : { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r, isError: false });
    } catch (e) {
      const m = String((e && e.message) || e).slice(0, 300);
      journal(`outil ${nom} refusé : ${m.slice(0, 80)}`);
      return ok(id, { content: [{ type: "text", text: m }], structuredContent: { erreur: m }, isError: true });
    }
  }
  return ko(id, -32601, "méthode non prise en charge : " + String(method).slice(0, 40));
}

async function traiter(req, res, chemin) {
  const fin = (code, obj, entetes = {}) => { res.writeHead(code, Object.assign({ "content-type": "application/json", "cache-control": "no-store" }, entetes)); res.end(obj === undefined ? "" : JSON.stringify(obj)); };
  const jeton = jetonConnecteur();
  if (!jeton || !egal(chemin.slice("/mcp/".length), jeton)) return fin(404, { error: "introuvable" });
  if (req.method !== "POST") return fin(405, { error: "POST seulement" }, { allow: "POST" });
  const morceaux = []; let taille = 0;
  for await (const c of req) { taille += c.length; if (taille > 1024 * 1024) return fin(413, { error: "requête trop grosse" }); morceaux.push(c); }
  let msg; try { msg = JSON.parse(Buffer.concat(morceaux).toString("utf8")); } catch { return fin(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON illisible" } }); }
  if (Array.isArray(msg)) {
    if (!msg.length || msg.length > 10) return fin(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "lot JSON-RPC vide ou trop long" } });
    const rep = (await Promise.all(msg.map(repondre))).filter(Boolean);
    return rep.length ? fin(200, rep) : fin(202);
  }
  const rep = await repondre(msg);
  return rep ? fin(200, rep) : fin(202);
}

function etatPublic() {
  // table Shopify en place (rien de secret) : la vérification aux deux semaines s'en sert pour confirmer quelle table tourne
  const table_shopify = TABLE_SH ? { version: TABLE_SH.version, valide_jusqu_au: TABLE_SH.valide_jusqu_au, origine_cp: TABLE_SH.origine_cp } : { erreur: ERREUR_TABLE ? "illisible" : "absente" };
  return { actif: !!jetonConnecteur() && !erreurMoteur, app_shopify: appShopify(), version: VERSION, table_shopify, paiement: MOYEN_PAIEMENT_OK ? MOYEN_PAIEMENT : "invalide", impression_usine: imprimanteUsine() };
}
// ---------- Impression à l'usine (26 oct. 2026, demande d'Alexandre : « zéro clic ») ----------
// Le programme d'impression du PC de l'usine vient chercher lui-même le PDF des lots finis, peu importe l'appareil
// qui a cliqué « Acheter et imprimer » :
//   GET  /impression/<jeton>/file              -> lots finis depuis moins de 2 h, pas encore imprimés [{lot_id, pages, octets, sha256, fin_a}]
//   GET  /impression/<jeton>/<lot>.pdf         -> le PDF 4×6 du lot
//   POST /impression/<jeton>/<lot>/imprime     -> le PC confirme l'impression (le lot n'est plus proposé)
//   GET  /impression/<jeton>/<doc>.html        -> un document HTML déposé par l'outil imprimer_document (bons B2B, Brother couleur)
//   POST /impression/<jeton>/<doc>/imprime     -> le PC confirme l'impression du document
// La file « file » donne aussi les documents : [{doc_id, type, octets, sha256, cree_a}].
// Jeton = HMAC(PROXY_KEY, « impression-usine-v1 »), 48 caractères ; mauvais jeton ou chemin = 404. N'ouvre rien d'autre
// (ni achat, ni lecture d'envoi, ni connecteur). Les lots sont en mémoire : une passerelle redémarrée n'a plus rien à imprimer.
const IMPRESSION_FENETRE_MS = 2 * 3600e3, IMPRESSION_EN_LIGNE_MS = 90e3;
let impressionVu = 0;
function jetonImpression() {
  const e = (process.env.IMPRESSION_JETON || "").trim();
  if (e) return e.length >= 32 ? e : null;
  if (!PROXY_KEY) return null;
  return crypto.createHmac("sha256", PROXY_KEY).update("impression-usine-v1").digest("hex").slice(0, 48);
}
// Documents (en mémoire, 2 h au plus, 40 au plus) :
//  - bons_b2b : HTML simple seulement (script et ressources externes refusés ici) ; le PC l'ouvre dans Edge, en fait
//    un PDF et l'imprime en couleur sur la Brother ;
//  - etiquettes : le PDF 4×6 d'un ancien lot (réimpression demandée dans le Poste) ; seulement des pages 4×6, pour
//    l'imprimante d'étiquettes. Rien n'est racheté.
const RE_DOC = /^D\d{8}-\d{6}-[a-z0-9]{4}$/, DOC_TYPES = ["bons_b2b", "etiquettes"], DOC_MAX_OCTETS = 4 * 1024 * 1024, DOC_PARTIE_MAX = 300 * 1024, DOCS_MAX = 40;
const DOC_INTERDIT = /<script|<iframe|<object|<embed|<link|<img|<svg|<form|<base|<meta(?!\s+charset=)|javascript:|url\s*\(|@import|\son[a-z]+\s*=/i;
const docs = new Map();
function nettoyerDocs() { const t = Date.now(); for (const [id, d] of docs) if (t - d.cree > IMPRESSION_FENETRE_MS) docs.delete(id); }
function docsAImprimer() { nettoyerDocs(); return [...docs.values()].filter((d) => d.html && !d.imprime_usine); }
function vueDoc(d) { return { doc_id: d.doc_id, type: d.type, lot: d.lot || null, pret: !!d.html, recu: d.parties.filter((x) => x != null).length, parties: d.n, octets: d.html ? d.html.length : null, imprimante_usine: imprimanteUsine(), imprime_usine: d.imprime_usine }; }
async function recevoirDocument(args) {
  nettoyerDocs();
  const id = String(args.doc_id || ""), type = String(args.type || ""), i = Number(args.partie), n = Number(args.parties);
  const html = type === "etiquettes" ? args.base64 : args.html;
  if (!RE_DOC.test(id)) throw new Error("doc_id invalide");
  if (!DOC_TYPES.includes(type)) throw new Error("type de document inconnu");
  if (!Number.isInteger(n) || n < 1 || n > 20 || !Number.isInteger(i) || i < 0 || i >= n) throw new Error("parties invalides");
  if (typeof html !== "string" || !html.length || html.length > DOC_PARTIE_MAX) throw new Error(type === "etiquettes" ? "base64 : partie vide ou trop grosse" : "html : partie vide ou trop grosse");
  if (type === "etiquettes" && !/^[A-Za-z0-9+/=]+$/.test(html)) throw new Error("base64 illisible");
  const lot = args.lot == null ? null : String(args.lot);
  if (lot && !RE_LOT.test(lot)) throw new Error("lot invalide");
  let d = docs.get(id);
  if (d && d.html) return vueDoc(d);   // déjà complet : rien à refaire
  if (!d) {
    if (docs.size >= DOCS_MAX) throw new Error("trop de documents en attente : le PC de l'usine est-il allumé ?");
    d = { doc_id: id, type, lot, n, parties: new Array(n).fill(null), cree: Date.now(), cree_a: maintenant(), html: null, sha: null, imprime_usine: null };
    docs.set(id, d);
  }
  if (d.type !== type || d.n !== n) throw new Error("document incohérent (type ou nombre de parties)");
  d.parties[i] = html;
  if (d.parties.every((x) => x != null)) {
    const tout = d.parties.join("");
    let corps;
    if (type === "etiquettes") {
      corps = Buffer.from(tout, "base64");
      if (corps.length > DOC_MAX_OCTETS) { docs.delete(id); throw new Error("PDF trop gros"); }
      if (corps.subarray(0, 5).toString("latin1") !== "%PDF-") { docs.delete(id); throw new Error("ce n'est pas un PDF"); }
      if (!PDFDocument) { docs.delete(id); throw new Error("pdf-lib absent : PDF pas vérifiable"); }
      let pdf; try { pdf = await PDFDocument.load(corps, { updateMetadata: false }); } catch (e) { docs.delete(id); throw new Error("PDF illisible"); }
      const pages = pdf.getPages();
      if (!pages.length || pages.length > 200 || pages.some((p) => { const { width, height } = p.getSize(); return Math.abs(width - 288) > 3 || Math.abs(height - 432) > 3; })) { docs.delete(id); throw new Error("PDF refusé : seulement des pages 4×6 (288×432 points)"); }
      d.pages = pages.length;
    } else {
      corps = Buffer.from(tout, "utf8");
      if (corps.length > DOC_MAX_OCTETS / 2) { docs.delete(id); throw new Error("document trop gros"); }
      if (!/^<!doctype html>/i.test(tout) || DOC_INTERDIT.test(tout)) { docs.delete(id); throw new Error("document refusé : HTML simple seulement (ni script, ni image, ni lien externe)"); }
    }
    d.html = corps; d.sha = crypto.createHash("sha256").update(corps).digest("hex"); d.pret_a = maintenant(); d.parties = d.parties.map(() => "");
    journal(`document ${id} (${type}${lot ? ", lot " + lot : ""}) prêt pour l'imprimante de l'usine : ${corps.length} octets`);
  }
  return vueDoc(d);
}
function imprimanteUsine() { return { en_ligne: !!impressionVu && Date.now() - impressionVu < IMPRESSION_EN_LIGNE_MS, vu_a: impressionVu ? new Date(impressionVu).toISOString() : null }; }
async function traiterImpression(req, res, chemin) {
  const fin = (code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
  const jeton = jetonImpression();
  const m = /^\/impression\/([A-Za-z0-9]{32,128})\/(?:(file)|(L\d{8}-\d{6}-[a-z0-9]{4})\.pdf|(L\d{8}-\d{6}-[a-z0-9]{4})\/imprime|(D\d{8}-\d{6}-[a-z0-9]{4})\.(html|pdf)|(D\d{8}-\d{6}-[a-z0-9]{4})\/imprime)$/.exec(chemin);
  if (!jeton || !m || !egal(m[1], jeton)) return fin(404, { error: "introuvable" });
  impressionVu = Date.now();
  if (m[2]) {
    if (req.method !== "GET") return fin(405, { error: "GET seulement" });
    const prets = [...lots.values()].filter((l) => l.statut !== "en_cours" && l.pdf && !l.imprime_usine && Date.now() - (Date.parse(l.fin_a) || 0) < IMPRESSION_FENETRE_MS)
      .map((l) => ({ lot_id: l.lot_id, pages: l.pages, octets: l.pdf.length, sha256: l.sha, fin_a: l.fin_a }));
    const documents = docsAImprimer().map((d) => ({ doc_id: d.doc_id, type: d.type, lot: d.lot || null, pages: d.pages || null, octets: d.html.length, sha256: d.sha, cree_a: d.cree_a }));
    return fin(200, { lots: prets, documents });
  }
  if (m[5] || m[7]) {
    const d = docs.get(m[5] || m[7]);
    if (!d || !d.html) return fin(404, { error: "document inconnu ou pas prêt" });
    if (m[5]) {
      if (req.method !== "GET") return fin(405, { error: "GET seulement" });
      if ((m[6] === "pdf") !== (d.type === "etiquettes")) return fin(404, { error: "document inconnu ou pas prêt" });
      res.writeHead(200, Object.assign({ "content-length": String(d.html.length), "cache-control": "no-store", "x-content-type-options": "nosniff" }, d.type === "etiquettes"
        ? { "content-type": "application/pdf" } : { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" }));
      return res.end(d.html);
    }
    if (req.method !== "POST") return fin(405, { error: "POST seulement" });
    if (!d.imprime_usine) { d.imprime_usine = maintenant(); journal(`document ${d.doc_id} imprimé à l'usine`); }
    return fin(200, { ok: true, doc_id: d.doc_id, imprime_a: d.imprime_usine });
  }
  const id = m[3] || m[4], l = lots.get(id);
  if (!l || !l.pdf) return fin(404, { error: "lot inconnu ou PDF pas prêt" });
  if (m[3]) {
    if (req.method !== "GET") return fin(405, { error: "GET seulement" });
    res.writeHead(200, { "content-type": "application/pdf", "content-length": String(l.pdf.length), "cache-control": "no-store" });
    return res.end(l.pdf);
  }
  if (req.method !== "POST") return fin(405, { error: "POST seulement" });
  if (!l.imprime_usine) { l.imprime_usine = maintenant(); journal(`lot ${id} imprimé à l'usine`); }
  return fin(200, { ok: true, lot_id: id, imprime_a: l.imprime_usine });
}


module.exports = { traiter, traiterImpression, etatPublic, jetonConnecteur, jetonImpression, _test: { docs, recevoirDocument, dateExpedition, signauxAdresse, civiqueEtRue, numeroCivique, rueEgale, villeNorm, propre, messageAchat, validerAjustements, ajuster, appelerOutil, lots } };
