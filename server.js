// Passerelle Freightcom — Unique Plastique inc.
// Détient la clé Freightcom (variable UPSTREAM_TOKEN sur Render) et expose la demande de tarifs
// et la lecture des envois. L'achat d'étiquettes existe mais reste verrouillé tant que
// ACHATS_ACTIVES n'est pas « oui » : une étiquette par commande (aucun plafond quotidien depuis le 26 oct. 2026), un tarif que la passerelle a elle-même
// relayé depuis moins de 3 h pour le MÊME service et le MÊME envoi (destination, colis, date), un corps d'achat strict (aucun
// supplément ni ramassage glissé dedans) et, dès que l'app Shopify est branchée (toujours en production), une vraie commande
// Shopify (payée ou non), pas annulée, pas encore traitée, livrée au code postal de l'envoi.
// Plus de plafond de prix (décision d'Alexandre, 2026-10-26) : seulement un garde-fou technique (500 $ taxes incluses par défaut)
// qui n'attrape qu'une erreur de calcul.
// /magasinage/* : magasinage Shopify encadré (voir magasinage.js) : listes à lire, lectures avec empreinte de contrôle,
// prix contre-vérifiés. Ces routes prennent une clé à part (x-cle-magasinage), qui n'ouvre RIEN d'autre (ni achat, ni ramassage).
// La réservation de ramassage UPS/GLS reste verrouillée tant que RAMASSAGES_ACTIVES n'est pas « oui ».
// GET /shipment/<id>/etiquette renvoie le PDF 4x6 de l'étiquette (lecture seulement).
// /mcp/<jeton> : connecteur du Poste d'expédition (voir connecteur.js). Il passe par les routes ci-dessous, avec tous leurs verrous.
const http = require("http");
const crypto = require("crypto");
const base = require("./base");
const connecteur = require("./connecteur");
const magasinage = require("./magasinage");

const TOKEN      = process.env.UPSTREAM_TOKEN;
const PROXY_KEY  = process.env.PROXY_KEY;
const PORT       = process.env.PORT || 10000;
// Environnement : "test" (bac à sable Freightcom) ou "production".
const ENV        = (process.env.FREIGHTCOM_ENV || "test").toLowerCase();
const UPSTREAMS  = {
  test:       "https://customer-external-api.ssd-test.freightcom.com",
  production: "https://external-api.freightcom.com",
};
const UPSTREAM   = UPSTREAMS[ENV];
// Format de l'en-tête : vide = « Authorization: <clé> » ; « Bearer » = « Authorization: Bearer <clé> ».
const SCHEME     = (process.env.AUTH_SCHEME || "").trim();

if (!TOKEN || !PROXY_KEY) { console.error("Il manque UPSTREAM_TOKEN ou PROXY_KEY."); process.exit(1); }
if (!UPSTREAM) { console.error("FREIGHTCOM_ENV doit être test ou production."); process.exit(1); }
const DEMARRE_LE = new Date().toISOString();   // un redémarrage (ou un réveil du plan gratuit) efface la mémoire de la passerelle

// Clé de LECTURE du magasinage (en-tête x-cle-magasinage) : seulement /magasinage/*. Les sessions qui lisent les prix Shopify
// dans le Chrome de l'usine n'ont qu'elle : elles ne peuvent ni acheter, ni réserver, ni lire un envoi.
// MAGASINAGE_CLE sur Render (32 caractères au moins) ; sinon dérivée de PROXY_KEY (HMAC : on ne remonte pas à PROXY_KEY).
const CLE_MAGASINAGE = (() => {
  const e = (process.env.MAGASINAGE_CLE || "").trim();
  if (e) return e.length >= 32 && !egalSimple(e, PROXY_KEY) ? e : null;
  return crypto.createHmac("sha256", PROXY_KEY).update("magasinage-lecture-v1").digest("hex").slice(0, 40);
})();
function egalSimple(a, b) { return String(a) === String(b); }

// Ramassages (pickups) : FERMÉS par défaut. S'ouvrent seulement si RAMASSAGES_ACTIVES=oui sur Render.
// Un seul ramassage par transporteur et par jour (clé RAM-AAAA-MM-JJ-ups|gls|purolator), au plus MAX_RAMASSAGES_PAR_JOUR.
const RAMASSAGES_ACTIVES = (process.env.RAMASSAGES_ACTIVES || "non").toLowerCase() === "oui";
const MAX_RAM_JOUR       = Math.max(0, Math.min(4, parseInt(process.env.MAX_RAMASSAGES_PAR_JOUR || "3", 10) || 0));
// Sous-chemin Freightcom de la réservation (« Schedule a dispatch or pickup »). À confirmer au premier essai en test.
const CHEMIN_RAM         = (process.env.RAMASSAGE_CHEMIN || "schedule").replace(/[^a-z_-]/gi, "");
const dejaRamasses = new Map();   // clé RAM-… -> réponse
let compteurRam = { jour: "", n: 0 };

// Achat d'étiquettes : FERMÉ par défaut. S'ouvre seulement si ACHATS_ACTIVES=oui sur Render.
const ACHATS_ACTIVES   = (process.env.ACHATS_ACTIVES || "non").toLowerCase() === "oui";
// Aucun plafond d'achats par jour (décision d'Alexandre, 26 oct. 2026 : « pas de limite d'achat ») : la variable
// MAX_ACHATS_PAR_JOUR n'est plus lue. Reste : une seule étiquette par commande (clé d'idempotence UP-<id Shopify>).
const MAX_ACHATS_JOUR  = null;

// Vérification d'adresse (2026-10-25, demande d'Alexandre) : la tâche d'achat ne peut pas joindre geocoder.ca elle-même.
// POST /adresse {adresse, ville, province} -> la passerelle interroge geocoder.ca et ne renvoie que le résultat normalisé.
// Rien n'est conservé ni journalisé (ni l'adresse ni la réponse). GEOCODER_AUTH (facultatif) = jeton payant geocoder.ca.
const GEOCODER_AUTH    = (process.env.GEOCODER_AUTH || "").trim();
const MAX_ADRESSES_JOUR = Math.max(0, Math.min(200, parseInt(process.env.MAX_ADRESSES_PAR_JOUR || "60", 10) || 0));
let compteurAdr = { jour: "", n: 0 };
const TEXTE_ADR = /^[\p{L}\p{N} .,'’#\/()&-]{1,120}$/u;
function txt(v) { return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : ""; }
async function verifierAdresse(corps) {
  let b; try { b = JSON.parse(corps); } catch { return { code: 400, obj: { error: "corps illisible" } }; }
  const a = txt(b && b.adresse), v = txt(b && b.ville), p = txt(b && b.province).toUpperCase();
  if (!TEXTE_ADR.test(a) || !TEXTE_ADR.test(v) || !/^[A-Z]{2}$/.test(p)) return { code: 400, obj: { error: "adresse, ville (texte simple, 120 caracteres au plus) et province (2 lettres) requis" } };
  const jour = new Date().toISOString().slice(0, 10);
  if (compteurAdr.jour !== jour) compteurAdr = { jour, n: 0 };
  if (compteurAdr.n >= MAX_ADRESSES_JOUR) return { code: 429, obj: { error: `plafond de ${MAX_ADRESSES_JOUR} verifications d'adresse par jour atteint` } };
  compteurAdr.n++;
  const url = "https://geocoder.ca/?locate=" + encodeURIComponent(`${a}, ${v}, ${p}`) + "&json=1&standard=1" + (GEOCODER_AUTH ? "&auth=" + encodeURIComponent(GEOCODER_AUTH) : "");
  let r, d;
  try { r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20000), headers: { accept: "application/json" } }); }
  catch (e) { return { code: 502, obj: { error: "geocoder.ca injoignable" } }; }
  const t = await r.text();
  try { d = JSON.parse(t); } catch { return { code: 502, obj: { error: `reponse illisible de geocoder.ca (HTTP ${r.status})` } }; }
  const st = (d && typeof d.standard === "object" && d.standard) || {};
  const err = d && d.error && typeof d.error === "object" ? { code: txt(d.error.code), description: txt(d.error.description) } : null;
  const cs = txt(st.confidence) || txt(d && d.confidence), conf = cs ? Number(cs) : NaN;
  return { code: 200, obj: {
    reconnue: !err && !!txt(d && d.latt),
    numero: txt(st.stnumber) || null, rue: txt(st.staddress) || null, ville: txt(st.city) || null, province: txt(st.prov) || null,
    code_postal: (txt(d && d.postal) || txt(st.postal) || "").toUpperCase().replace(/^([A-Z]\d[A-Z])\s*(\d[A-Z]\d)$/, "$1 $2") || null,
    confiance: Number.isFinite(conf) ? conf : null,
    non_utilise: txt(d && d.more) || txt(st.more) || null,
    erreur: err, source: "geocoder.ca", jeton: !!GEOCODER_AUTH, restantes_aujourdhui: MAX_ADRESSES_JOUR - compteurAdr.n,
  } };
}

// Surface autorisée. Tout le reste est refusé (factures, manifestes, suppressions, LTL).
const ALLOW = [
  { m: ["POST"], re: /^\/adresse$/, adresse: true },                 // VÉRIFIER une adresse (geocoder.ca, voir plus haut)
  { m: ["POST"], re: /^\/magasinage\/(demande|lecture|echec|signal)$/, magasinage: true }, // magasinage Shopify (magasinage.js)
  { m: ["GET"],  re: /^\/magasinage\/(etat|programme)$/, magasinage: true },
  { m: ["POST"], re: /^\/rate$/ },                                   // demander une soumission (202 + request_id)
  { m: ["GET"],  re: /^\/rate\/[A-Za-z0-9_-]{1,80}$/ },              // lire le résultat de la soumission
  { m: ["GET"],  re: /^\/services$/ },                               // liste des services/transporteurs
  { m: ["GET"],  re: /^\/finance\/payment-methods$/ },               // lire le moyen de paiement (requis pour réserver)
  { m: ["GET"],  re: /^\/shipment\/[A-Za-z0-9_-]{1,80}\/etiquette$/, etiquette: true }, // PDF 4x6 de l'étiquette (lu par la passerelle, voir plus bas)
  { m: ["GET"],  re: /^\/shipment\/[A-Za-z0-9_-]{1,80}(\/[A-Za-z0-9_-]{1,40})?$/ }, // lire un envoi et son étiquette
  { m: ["POST"], re: /^\/shipment$/, achat: true },                  // ACHETER une étiquette (verrouillé, voir plus bas)
  { m: ["POST"], re: new RegExp("^/shipment/[A-Za-z0-9_-]{1,80}/" + CHEMIN_RAM + "$"), ramassage: true }, // RÉSERVER un ramassage (verrouillé)
];
const dejaAchetes = new Map();   // clé d'idempotence -> réponse (perdu au redémarrage : ne pas s'y fier seul)
let compteurJour = { jour: "", n: 0 };

// --- DÉBUT CONTRÔLE DU PRIX ---
// Contrôle du prix : la passerelle retient les tarifs qu'elle a elle-même relayés, pour l'ENVOI EXACT qu'elle a soumissionné
// (POST /rate puis GET /rate/<id>) : origine, destination, résidentiel ou non, date, emballage, chaque colis (poids, dimensions).
// Elle refuse tout achat dont le service n'a pas été coté pour ce même envoi, dont la soumission a plus de 3 h, dont le prix
// est anormal (au-dessus du garde-fou technique : une erreur de calcul, jamais un vrai prix), ou dont unique_id n'est pas
// la clé d'idempotence (Freightcom reconnaît alors un 2e achat de la même commande, même après un redémarrage).
// En cas de doute, elle REFUSE.
const GARDE_TECHNIQUE = Math.min(1000, Number(process.env.GARDE_TECHNIQUE_DOLLARS || "500") || 500);
const VALIDITE_TARIF_MS = 3 * 3600e3;
const MAX_MEMOIRE = 5000;
const soumissions = new Map();   // request_id -> { envoi (empreinte), le (heure de la soumission) }
const tarifsVus = new Map();     // service_id|empreinte de l'envoi -> { montant TTC, le (heure de la soumission) }
const sha256 = (t) => crypto.createHash("sha256").update(t).digest("hex");

// Empreinte de ce qui fixe le prix d'un envoi (les noms, téléphones et courriels ajoutés à l'achat n'en font pas partie).
function empreinteEnvoi(d) {
  if (!d || typeof d !== "object") return null;
  const t = (v) => String(v == null ? "" : v).normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
  const cp = (v) => String(v == null ? "" : v).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const adr = (x) => { const a = (x && x.address) || {}; return [t(a.address_line_1), t(a.city), t(a.region), t(a.country), cp(a.postal_code)]; };
  const o = d.origin, de = d.destination;
  if (!o || !de || !de.address || !cp(de.address.postal_code) || !o.address || !cp(o.address.postal_code)) return null;
  const pk = d.packaging_properties && Array.isArray(d.packaging_properties.packages) ? d.packaging_properties.packages : [];
  if (!pk.length) return null;
  const colis = pk.map((p) => { const m = (p && p.measurements) || {}, w = m.weight || {}, c = m.cuboid || {}; return [Number(w.value), t(w.unit), Number(c.l), Number(c.w), Number(c.h), t(c.unit)]; });
  const j = d.expected_ship_date || {};
  return sha256(JSON.stringify([adr(o), adr(de), de.residential === true, t(d.packaging_type), colis, [j.year, j.month, j.day].map(Number)]));
}
function purgerTarifs(t = Date.now()) {
  for (const [k, v] of soumissions) if (t - v.le > VALIDITE_TARIF_MS || soumissions.size > MAX_MEMOIRE) soumissions.delete(k); else break;
  for (const [k, v] of tarifsVus) if (t - v.le > VALIDITE_TARIF_MS || tarifsVus.size > MAX_MEMOIRE) tarifsVus.delete(k); else break;
}
function retenirSoumission(rid, corpsDemande) {
  let b = null; try { b = JSON.parse(corpsDemande); } catch {}
  const envoi = empreinteEnvoi(b && b.details);
  if (!rid || !envoi) return false;
  purgerTarifs();
  soumissions.set(String(rid), { envoi, le: Date.now() });
  return true;
}

// Freightcom donne les montants en CENTS : total = { currency, value: 1179 } veut dire 11,79 $ (confirmé le 2026-10-23).
function nombre(v) {
  let cents = false;
  if (v && typeof v === "object") { cents = v.value !== undefined; v = v.value ?? v.amount ?? v.total; }
  let n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
  if (cents) n = n / 100;
  return Number.isFinite(n) && n > 0 ? n : null;
}
function retenirTarifs(json, rid) {
  const s = soumissions.get(String(rid));
  if (!s) return 0;   // soumission inconnue (faite ailleurs ou avant un redémarrage) : ses tarifs ne permettent aucun achat
  const rates = (json && (json.rates || (json.rate && json.rate.rates))) || [];
  if (!Array.isArray(rates)) return 0;
  let n = 0;
  for (const r of rates) {
    const id = r && (r.service_id ?? (r.service && (r.service.id ?? r.service.service_id)) ?? r.serviceId);
    const montant = nombre(r && (r.total ?? r.total_charge ?? r.price));
    if (id && montant) { tarifsVus.set(String(id) + "|" + s.envoi, { montant, le: s.le }); n++; }
  }
  return n;
}
function verifierPrix(corps, cleIdem) {
  let b; try { b = JSON.parse(corps); } catch { return "corps de la demande illisible"; }
  if (!b || typeof b !== "object") return "corps de la demande illisible";
  if (String(b.unique_id == null ? "" : b.unique_id) !== String(cleIdem)) return "unique_id different de la cle d'idempotence (x-cle-idempotence)";
  const id = b.service_id ?? (b.service && b.service.id) ?? (b.details && b.details.service_id);
  if (!id) return "service_id introuvable dans la demande d'achat";
  const nomService = String(id).replace(/[^\w.-]/g, "").slice(0, 40);
  const envoi = empreinteEnvoi(b.details);
  if (!envoi) return "details de l'envoi incomplets (origine, destination, colis)";
  const t = tarifsVus.get(String(id) + "|" + envoi);
  if (!t) return `aucun tarif relaye par la passerelle pour le service ${nomService} et cet envoi exact (meme destination, memes colis, meme date) : redemander une soumission`;
  if (Date.now() - t.le > VALIDITE_TARIF_MS) return "tarif trop vieux (plus de 3 h) : redemander une soumission";
  if (!(t.montant > 0) || t.montant > GARDE_TECHNIQUE) return `prix anormal (${t.montant} $, garde-fou technique de ${GARDE_TECHNIQUE} $) : erreur probable, a verifier`;
  return null;
}
// Corps d'achat STRICT : exactement les champs que mettent le connecteur et la tâche d'achat, rien d'autre (pas d'assurance,
// de signature payante, d'étiquette de retour, de matières dangereuses, de ramassage glissé dans l'achat…). La passerelle renvoie
// ensuite à Freightcom le corps qu'elle a vérifié (re-sérialisé : une clé en double ne peut pas passer).
function verifierCorpsAchat(b, origineCp) {
  const est = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  const seulement = (x, permises) => est(x) && Object.keys(x).every((k) => permises.includes(k));
  const cp = (v) => String(v == null ? "" : v).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!seulement(b, ["unique_id", "payment_method_id", "service_id", "details"])) return "champ non permis dans l'achat (seulement unique_id, payment_method_id, service_id, details)";
  const d = b.details;
  if (!seulement(d, ["origin", "destination", "expected_ship_date", "packaging_type", "packaging_properties"])) return "champ non permis dans details";
  const lieu = (x, extra) => seulement(x, ["name", "residential", "address", "contact_name", "phone_number", "email_addresses"].concat(extra))
    && seulement(x.address, ["address_line_1", "address_line_2", "city", "region", "country", "postal_code"])
    && Object.values(x.address).every((v) => typeof v === "string" && v.length <= 120)
    && (x.phone_number === undefined || (seulement(x.phone_number, ["number", "extension"]) && /^\d{0,15}$/.test(String(x.phone_number.number || "")) && /^\d{0,8}$/.test(String(x.phone_number.extension || ""))))
    && (x.email_addresses === undefined || (Array.isArray(x.email_addresses) && x.email_addresses.length === 0))
    && ["name", "contact_name"].every((k) => x[k] === undefined || (typeof x[k] === "string" && x[k].length <= 80));
  if (!lieu(d.origin, [])) return "origine : champ non permis ou illisible";
  if (d.origin.residential !== false) return "origine : residential doit etre false (l'usine)";
  if (origineCp && cp(d.origin.address.postal_code) !== cp(origineCp)) return `origine differente de l'usine (${origineCp})`;
  if (!lieu(d.destination, ["signature_requirement"])) return "destination : champ non permis ou illisible";
  if (typeof d.destination.residential !== "boolean") return "destination : residential manquant";
  if (d.destination.signature_requirement !== undefined && d.destination.signature_requirement !== "not-required") return "signature : seulement not-required";
  if (d.packaging_type !== "package") return "emballage : colis seulement (package)";
  const pp = d.packaging_properties;
  if (!seulement(pp, ["packages"]) || !Array.isArray(pp.packages) || !pp.packages.length || pp.packages.length > 20) return "colis : 1 a 20, sans autre champ";
  for (const p of pp.packages) {
    if (!seulement(p, ["description", "measurements"]) || !seulement(p.measurements, ["weight", "cuboid"])) return "colis : champ non permis";
    const w = p.measurements.weight, c = p.measurements.cuboid;
    if (!seulement(w, ["unit", "value"]) || !seulement(c, ["unit", "l", "w", "h"]) || ![w.value, c.l, c.w, c.h].every((n) => typeof n === "number" && n > 0 && n <= 200)) return "colis : mesures illisibles";
    if (p.description !== undefined && (typeof p.description !== "string" || p.description.length > 60)) return "colis : description illisible";
  }
  const j = d.expected_ship_date;
  if (!seulement(j, ["year", "month", "day"]) || ![j.year, j.month, j.day].every(Number.isInteger)) return "date d'expedition illisible";
  return null;
}
// --- FIN CONTRÔLE DU PRIX ---

// Un achat n'est permis que pour une VRAIE commande Shopify (UP-<id> = son identifiant) : ni annulée, ni déjà traitée
// (payée ou non : permis depuis le 26 oct. 2026), et livrée au code postal de l'envoi. Même avec la clé de passerelle, on ne peut donc pas acheter une étiquette
// pour un autre colis ou une autre adresse. Exigé dès que l'app Shopify est branchée, et toujours en production.
async function verifierCommande(b, cleIdem) {
  if (!base.appShopify()) return ENV === "production" ? "app Shopify pas branchee sur la passerelle : achat refuse en production" : null;
  let d;
  try { d = await base.shopify("query($id: ID!) { order(id: $id) { name cancelledAt displayFinancialStatus displayFulfillmentStatus shippingAddress { zip countryCodeV2 } } }", { id: "gid://shopify/Order/" + cleIdem.slice(3) }); }
  catch (e) { return "commande illisible dans Shopify : achat refuse"; }
  const o = d && d.order;
  if (!o) return "aucune commande Shopify ne porte cet identifiant";
  if (o.cancelledAt) return "commande annulee dans Shopify";
  // Payée ou non : permis (décision d'Alexandre, 26 oct. 2026 : « une vraie commande, pas grave si c'est pas payé »).
  if (/^(FULFILLED|RESTOCKED)$/.test(String(o.displayFulfillmentStatus || ""))) return "commande deja traitee dans Shopify";
  const a = o.shippingAddress;
  if (!a || !a.zip) return "adresse de la commande illisible dans Shopify (acces aux donnees client protegees de l'app)";
  const dest = b.details.destination.address;
  if (base.cpNorm(a.zip) !== base.cpNorm(dest.postal_code) || String(a.countryCodeV2 || "").toUpperCase() !== String(dest.country || "").toUpperCase()) return "le code postal de l'envoi n'est pas celui de la commande dans Shopify";
  return null;
}
const MAX_BODY = 64 * 1024;

// Vérifie le corps d'une réservation de ramassage : courrier seulement (pas de LTL), date = date de la clé,
// aujourd'hui ou dans les 14 jours, plage horaire cohérente entre 7 h et 19 h. En cas de doute : refus.
function verifierRamassage(corps, cle) {
  let b; try { b = JSON.parse(corps); } catch { return "corps de la demande illisible"; }
  const p = b && b.pickup_details;
  if (!p || typeof p !== "object") return "pickup_details manquant";
  if (b.dispatch_details || p.dispatch_details) return "dispatch LTL refuse : courrier seulement";
  const d = p.date || {}, a = p.ready_at || {}, u = p.ready_until || {};
  const ymd = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  if (!/^RAM-(\d{4}-\d{2}-\d{2})-(ups|gls|purolator)$/.test(cle)) return "cle invalide";
  if (cle.slice(4, 14) !== ymd) return `date ${ymd} differente de la cle ${cle}`;
  const auj = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
  const j = (Date.parse(ymd) - Date.parse(auj)) / 864e5;
  if (!(j >= 0 && j <= 14)) return "date passee ou a plus de 14 jours";
  const m1 = a.hour * 60 + a.minute, m2 = u.hour * 60 + u.minute;
  if (![m1, m2].every(Number.isFinite)) return "heures illisibles";
  if (!(m1 >= 420 && m2 <= 1140 && m2 - m1 >= 60)) return "plage horaire hors de 7 h-19 h ou de moins d'une heure";
  return null;
}

// Étiquette : Freightcom range les PDF sur un stockage AWS public. La passerelle lit l'envoi chez Freightcom,
// choisit la variante 4x6 (size « a6 », format « pdf », sans marge ; ?marge=1 pour la version avec marge),
// vérifie que le lien pointe bien vers les étiquettes DE CET ENVOI sur amazonaws.com, puis renvoie le PDF.
// Elle ne suit jamais un autre lien : pas de redirection, PDF seulement, 5 Mo au plus.
const MAX_PDF = 5 * 1024 * 1024;
function lienEtiquetteSur(url, id) {
  let u; try { u = new URL(url); } catch { return false; }
  return u.protocol === "https:" && /^[a-z0-9.-]+\.amazonaws\.com$/.test(u.hostname) && u.pathname.includes(`/labels/${id}/`) && /\.pdf$/.test(u.pathname);
}
async function etiquette(id, avecMarge, entetes) {
  const r = await fetch(`${UPSTREAM}/shipment/${id}`, { headers: entetes });
  if (!r.ok) return { code: r.status, err: r.status === 404 ? "envoi introuvable" : "lecture de l'envoi refusee par Freightcom" };
  let s; try { const j = await r.json(); s = j.shipment || j; } catch { return { code: 502, err: "reponse Freightcom illisible" }; }
  const l = (s.labels || []).find((x) => x && x.size === "a6" && x.format === "pdf" && !!x.padded === avecMarge);
  if (!l) return { code: 404, err: "aucune etiquette 4x6 pour cet envoi (etiquette pas encore prete ?)" };
  if (!lienEtiquetteSur(l.url, id)) return { code: 502, err: "lien d'etiquette inattendu : refuse" };
  const p = await fetch(l.url, { redirect: "error" });
  if (!p.ok) return { code: 502, err: "stockage des etiquettes injoignable (" + p.status + ")" };
  const b = Buffer.from(await p.arrayBuffer());
  if (b.length > MAX_PDF) return { code: 502, err: "etiquette trop grosse" };
  if (b.subarray(0, 5).toString("latin1") !== "%PDF-") return { code: 502, err: "le fichier recu n'est pas un PDF" };
  return { pdf: b, suivi: s.primary_tracking_number || "" };
}

function egal(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

async function traiterRequete(req, res) {
  // Les refus écrits par la passerelle portent l'en-tête « x-passerelle: refus » (jamais une réponse relayée de Freightcom) :
  // le connecteur ne cite que ceux-là, jamais le texte de Freightcom. « passerelle: true » dans le corps sert à la lecture humaine.
  const send = (code, obj) => {
    const refus = !!(obj && obj.error && code >= 400);
    if (refus) obj = Object.assign({ passerelle: true }, obj);
    res.writeHead(code, Object.assign({ "content-type": "application/json" }, refus ? { "x-passerelle": "refus" } : {}));
    res.end(JSON.stringify(obj));
  };

  if (req.url === "/" || req.url === "/health") return send(200, { ok: true, env: ENV, achats_actives: ACHATS_ACTIVES, max_achats_jour: MAX_ACHATS_JOUR, garde_technique_ttc: GARDE_TECHNIQUE, ramassages_actives: RAMASSAGES_ACTIVES, max_ramassages_jour: MAX_RAM_JOUR, max_adresses_jour: MAX_ADRESSES_JOUR, jeton_geocoder: !!GEOCODER_AUTH, chemin_ramassage: CHEMIN_RAM, demarre_le: DEMARRE_LE, connecteur: connecteur.etatPublic(), magasinage: Object.assign(magasinage.etatPublic(), { cle_lecture: !!CLE_MAGASINAGE }) });
  const path = req.url.split("?")[0];
  // Connecteur du Poste : protégé par son adresse secrète (mauvais jeton = 404), pas par x-proxy-key.
  if (path.startsWith("/mcp/")) return connecteur.traiter(req, res, path).catch(() => { try { if (!res.headersSent) send(500, { error: "erreur du connecteur" }); else res.end(); } catch {} });
  if (path.startsWith("/.well-known/")) return send(404, { error: "introuvable" }); // pas d'OAuth : le client du connecteur ne doit pas voir un 401
  // Deux clés : /magasinage/* n'accepte QUE la clé de lecture ; tout le reste n'accepte QUE la clé de passerelle.
  const estMagasinage = path.startsWith("/magasinage/");
  if (estMagasinage) {
    if (!CLE_MAGASINAGE) return send(503, { error: "magasinage ferme : MAGASINAGE_CLE trop courte (32 caracteres au moins) ou egale a PROXY_KEY" });
    if (!egal(req.headers["x-cle-magasinage"] || "", CLE_MAGASINAGE)) return send(401, { error: "cle de lecture du magasinage invalide (en-tete x-cle-magasinage)" });
  } else if (!egal(req.headers["x-proxy-key"] || "", PROXY_KEY)) return send(401, { error: "cle de passerelle invalide" });

  const regle = ALLOW.find(r => r.m.includes(req.method) && r.re.test(path));
  if (!regle || !!regle.magasinage !== estMagasinage) return send(403, { error: "chemin ou methode non autorise", path, method: req.method });

  let cleIdem = null;
  if (regle.achat) {
    if (!ACHATS_ACTIVES) return send(403, { error: "achats desactives (ACHATS_ACTIVES n'est pas 'oui')" });
    cleIdem = String(req.headers["x-cle-idempotence"] || "");
    if (!/^UP-\d{6,20}$/.test(cleIdem)) return send(400, { error: "en-tete x-cle-idempotence manquant ou invalide (UP-<id commande>)" });
    if (dejaAchetes.has(cleIdem)) return send(409, { error: "etiquette deja achetee pour cette commande", precedent: dejaAchetes.get(cleIdem) });
    const jour = new Date().toISOString().slice(0, 10);
    if (compteurJour.jour !== jour) compteurJour = { jour, n: 0 };   // compté pour le journal seulement (aucun plafond)
  }

  let cleRam = null;
  if (regle.ramassage) {
    if (!RAMASSAGES_ACTIVES) return send(403, { error: "ramassages desactives (RAMASSAGES_ACTIVES n'est pas 'oui')" });
    cleRam = String(req.headers["x-cle-ramassage"] || "");
    if (!/^RAM-\d{4}-\d{2}-\d{2}-(ups|gls|purolator)$/.test(cleRam)) return send(400, { error: "en-tete x-cle-ramassage manquant ou invalide (RAM-AAAA-MM-JJ-ups|gls|purolator)" });
    if (dejaRamasses.has(cleRam)) return send(409, { error: "ramassage deja reserve pour ce transporteur ce jour-la", precedent: dejaRamasses.get(cleRam) });
    const jour = new Date().toISOString().slice(0, 10);
    if (compteurRam.jour !== jour) compteurRam = { jour, n: 0 };
    if (compteurRam.n >= MAX_RAM_JOUR) return send(429, { error: `plafond de ${MAX_RAM_JOUR} ramassages par jour atteint` });
  }

  const chunks = []; let taille = 0;
  try {
    for await (const c of req) { taille += c.length; if (taille > MAX_BODY) return send(413, { error: "requete trop grosse" }); chunks.push(c); }
  } catch { return; } // client parti au milieu de l'envoi : rien à répondre, et surtout pas de plantage

  let corpsVerifie = null;   // achat et ramassage : on renvoie à Freightcom le corps vérifié, re-sérialisé
  if (regle.achat) {
    const texte = Buffer.concat(chunks).toString("utf8");
    const refus = verifierPrix(texte, cleIdem);
    if (refus) return send(403, { error: "achat refuse : " + refus });
    const b = JSON.parse(texte);
    const refus2 = verifierCorpsAchat(b, base.regleDepot ? base.regleDepot.origine.code_postal : null) || await verifierCommande(b, cleIdem);
    if (refus2) return send(403, { error: "achat refuse : " + refus2 });
    corpsVerifie = JSON.stringify(b);
  }
  if (regle.ramassage) {
    const texte = Buffer.concat(chunks).toString("utf8");
    const refus = verifierRamassage(texte, cleRam);
    if (refus) return send(403, { error: "ramassage refuse : " + refus });
    corpsVerifie = JSON.stringify(JSON.parse(texte));
  }

  if (regle.magasinage) {
    const quoi = path.split("/")[2];
    try {
      if (quoi === "programme") {
        const p = magasinage.programme();
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-programme-sha256": p.sha256, "x-programme-version": p.version, "cache-control": "no-store" });
        return res.end(p.source);
      }
      if (quoi === "etat") return send(200, magasinage.etat());
      const texte = Buffer.concat(chunks).toString("utf8");
      if (quoi === "lecture") return send(200, magasinage.lecture(texte));
      let corps; try { corps = JSON.parse(texte || "{}"); } catch { return send(400, { error: "corps JSON illisible" }); }
      if (quoi === "demande") return send(200, await magasinage.demande(corps));
      if (quoi === "echec") return send(200, magasinage.echec(corps));
      return send(200, magasinage.signal(corps));
    } catch (e) {
      if (e instanceof magasinage.Refus) return send(e.statut, { error: e.message, code: e.code });
      console.log(`${new Date().toISOString()} MAGASINAGE ${quoi} -> erreur ${String((e && e.name) || "inconnue").slice(0, 40)}`); // jamais le message (il peut citer le texte lu)
      return send(502, { error: "magasinage : " + String((e && e.message) || e).slice(0, 160) });
    }
  }

  if (regle.adresse) {
    const out = await verifierAdresse(Buffer.concat(chunks).toString("utf8"));
    console.log(`${new Date().toISOString()} POST /adresse -> ${out.code} ADRESSE`);
    return send(out.code, out.obj);
  }

  const entetes = {
    authorization: SCHEME ? `${SCHEME} ${TOKEN}` : TOKEN,
    "content-type": "application/json",
    accept: "application/json",
  };

  if (regle.etiquette) {
    try {
      const id = path.split("/")[2];
      const marge = /(^|&)marge=1(&|$)/.test(req.url.split("?")[1] || "");
      const e = await etiquette(id, marge, entetes);
      console.log(`${new Date().toISOString()} GET ${path} -> ${e.pdf ? 200 : e.code} ETIQUETTE`);
      if (!e.pdf) return send(e.code, { error: e.err });
      res.writeHead(200, { "content-type": "application/pdf", "content-length": e.pdf.length, "x-suivi": e.suivi });
      return res.end(e.pdf);
    } catch (err) {
      return send(502, { error: "echec de la lecture de l'etiquette", detail: String(err) });
    }
  }

  try {
    const up = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers: entetes,
      body: req.method === "GET" ? undefined : corpsVerifie !== null ? corpsVerifie : Buffer.concat(chunks),
    });
    let text = await up.text();
    // Un chemin inexistant chez Freightcom renvoie une erreur AWS qui contient une empreinte de l'en-tête
    // d'autorisation : on ne la relaie pas.
    if (up.status === 403 && /Authorization header requires/.test(text)) text = JSON.stringify({ error: "chemin inexistant chez Freightcom" });
    if (req.method === "POST" && path === "/rate" && up.ok) { try { const j = JSON.parse(text); retenirSoumission(j && (j.request_id || j.id), Buffer.concat(chunks).toString("utf8")); } catch {} }
    if (req.method === "GET" && /^\/rate\//.test(path) && up.ok) { try { retenirTarifs(JSON.parse(text), path.split("/")[2]); } catch {} }
    if (regle.achat && up.ok) {
      compteurJour.n++;
      let id = null; try { const j = JSON.parse(text); id = (j && (j.id || (j.shipment && j.shipment.id))) || null; } catch {}
      dejaAchetes.set(cleIdem, { statut: up.status, le: new Date().toISOString(), id: id && /^[A-Za-z0-9_-]{1,80}$/.test(String(id)) ? String(id) : null });
    }
    if (regle.ramassage && up.ok) { compteurRam.n++; dejaRamasses.set(cleRam, { statut: up.status, le: new Date().toISOString() }); }
    console.log(`${new Date().toISOString()} ${req.method} ${path} -> ${up.status}${regle.achat ? " ACHAT " + cleIdem : ""}${regle.ramassage ? " RAMASSAGE " + cleRam : ""}`);
    res.writeHead(up.status, { "content-type": up.status === 403 && /chemin inexistant/.test(text) ? "application/json" : (up.headers.get("content-type") || "application/json") });
    res.end(text);
  } catch (err) {
    send(502, { error: "echec de la requete amont", detail: String(err) });
  }
}

// Aucune erreur ne doit arrêter la passerelle (un arrêt efface le plafond du jour, la mémoire des achats et les lots en cours).
const server = http.createServer((req, res) => {
  traiterRequete(req, res).catch((e) => {
    console.log(`${new Date().toISOString()} ERREUR ${String((e && e.name) || "inconnue").slice(0, 40)}`);
    try { if (!res.headersSent) { res.writeHead(500, { "content-type": "application/json", "x-passerelle": "refus" }); res.end(JSON.stringify({ error: "erreur interne de la passerelle", passerelle: true })); } else res.end(); } catch {}
  });
});

server.listen(PORT, () => console.log(`passerelle Freightcom (${ENV}) a l'ecoute sur ${PORT}`));
