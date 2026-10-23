// Passerelle Freightcom — Unique Plastique inc.
// Détient la clé Freightcom (variable UPSTREAM_TOKEN sur Render) et expose la demande de tarifs
// et la lecture des envois. L'achat d'étiquettes existe mais reste verrouillé tant que
// ACHATS_ACTIVES n'est pas « oui » : une étiquette par commande, plafond quotidien, plafond de 15 $ (au-dessus : 10 % de la commande, 50 $ au plus).
// La réservation de ramassage UPS/GLS reste verrouillée tant que RAMASSAGES_ACTIVES n'est pas « oui ».
// GET /shipment/<id>/etiquette renvoie le PDF 4x6 de l'étiquette (lecture seulement).
const http = require("http");
const crypto = require("crypto");

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
const MAX_ACHATS_JOUR  = Math.max(0, Math.min(50, parseInt(process.env.MAX_ACHATS_PAR_JOUR || "10", 10) || 0));

// Surface autorisée. Tout le reste est refusé (factures, manifestes, suppressions, LTL).
const ALLOW = [
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

// Plafond de prix : la passerelle retient les tarifs qu'elle a elle-même relayés (GET /rate/<id>)
// et refuse tout achat dont le service n'a pas été vu, ou dont le prix dépasse MAX_PRIX_ETIQUETTE.
// En cas de doute (prix illisible, service inconnu, tarif trop vieux), elle REFUSE.
const MAX_PRIX = Math.min(15, Number(process.env.MAX_PRIX_ETIQUETTE || "15") || 0);  // jamais au-dessus de 15 $ (décision d'Alexandre, 2026-10-23 19 h 21)
// Règle d'Alexandre (2026-10-23) : au-dessus de 15 $, l'étiquette est permise si elle vaut au plus 10 % de la commande
// (total TTC envoyé dans l'en-tête x-total-commande, en dollars), sans jamais dépasser MAX_PRIX_ABSOLU (défaut 50 $, 100 $ au plus).
const PCT_COMMANDE = 0.10;
const MAX_PRIX_ABSOLU = Math.min(100, Number(process.env.MAX_PRIX_ABSOLU || "50") || 0);
const VALIDITE_TARIF_MS = 3 * 3600e3;
const tarifsVus = new Map();   // service_id -> { montant, le }

// Freightcom donne les montants en CENTS : total = { currency, value: 1179 } veut dire 11,79 $ (confirmé le 2026-10-23).
function nombre(v) {
  let cents = false;
  if (v && typeof v === "object") { cents = v.value !== undefined; v = v.value ?? v.amount ?? v.total; }
  let n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
  if (cents) n = n / 100;
  return Number.isFinite(n) && n > 0 ? n : null;
}
function retenirTarifs(json) {
  const rates = (json && (json.rates || (json.rate && json.rate.rates))) || [];
  if (!Array.isArray(rates)) return 0;
  let n = 0;
  for (const r of rates) {
    const id = r && (r.service_id ?? (r.service && (r.service.id ?? r.service.service_id)) ?? r.serviceId);
    const montant = nombre(r && (r.total ?? r.total_charge ?? r.price));
    if (id && montant) { tarifsVus.set(String(id), { montant, le: Date.now() }); n++; }
  }
  return n;
}
function verifierPrix(corps, totalCommande) {
  let b; try { b = JSON.parse(corps); } catch { return "corps de la demande illisible"; }
  const id = b && (b.service_id ?? (b.service && b.service.id) ?? (b.details && b.details.service_id));
  if (!id) return "service_id introuvable dans la demande d'achat";
  const t = tarifsVus.get(String(id));
  if (!t) return `aucun tarif relaye par la passerelle pour le service ${id}`;
  if (Date.now() - t.le > VALIDITE_TARIF_MS) return "tarif trop vieux (plus de 3 h) : redemander une soumission";
  if (t.montant <= MAX_PRIX) return null;
  if (!(totalCommande > 0)) return `prix ${t.montant} $ au-dessus du plafond de ${MAX_PRIX} $ (total de la commande absent)`;
  const permis = Math.min(MAX_PRIX_ABSOLU, Math.round(totalCommande * PCT_COMMANDE * 100) / 100);
  if (!(t.montant <= permis)) return `prix ${t.montant} $ au-dessus du plafond (${MAX_PRIX} $, ou 10 % de la commande de ${totalCommande} $ = ${permis} $, maximum ${MAX_PRIX_ABSOLU} $)`;
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

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

  if (req.url === "/" || req.url === "/health") return send(200, { ok: true, env: ENV, achats_actives: ACHATS_ACTIVES, max_achats_jour: MAX_ACHATS_JOUR, max_prix_etiquette: MAX_PRIX, pct_commande_au_dessus: PCT_COMMANDE, max_prix_absolu: MAX_PRIX_ABSOLU, ramassages_actives: RAMASSAGES_ACTIVES, max_ramassages_jour: MAX_RAM_JOUR, chemin_ramassage: CHEMIN_RAM });
  if (!egal(req.headers["x-proxy-key"] || "", PROXY_KEY)) return send(401, { error: "cle de passerelle invalide" });

  const path = req.url.split("?")[0];
  const regle = ALLOW.find(r => r.m.includes(req.method) && r.re.test(path));
  if (!regle) return send(403, { error: "chemin ou methode non autorise", path, method: req.method });

  let cleIdem = null;
  if (regle.achat) {
    if (!ACHATS_ACTIVES) return send(403, { error: "achats desactives (ACHATS_ACTIVES n'est pas 'oui')" });
    cleIdem = String(req.headers["x-cle-idempotence"] || "");
    if (!/^UP-\d{6,20}$/.test(cleIdem)) return send(400, { error: "en-tete x-cle-idempotence manquant ou invalide (UP-<id commande>)" });
    if (dejaAchetes.has(cleIdem)) return send(409, { error: "etiquette deja achetee pour cette commande", precedent: dejaAchetes.get(cleIdem) });
    const jour = new Date().toISOString().slice(0, 10);
    if (compteurJour.jour !== jour) compteurJour = { jour, n: 0 };
    if (compteurJour.n >= MAX_ACHATS_JOUR) return send(429, { error: `plafond de ${MAX_ACHATS_JOUR} achats par jour atteint` });
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
  for await (const c of req) { taille += c.length; if (taille > MAX_BODY) return send(413, { error: "requete trop grosse" }); chunks.push(c); }

  if (regle.achat) {
    const tc = String(req.headers["x-total-commande"] || "");
    const totalCommande = /^\d{1,6}(\.\d{1,2})?$/.test(tc) ? Number(tc) : 0;
    const refus = verifierPrix(Buffer.concat(chunks).toString("utf8"), totalCommande);
    if (refus) return send(403, { error: "achat refuse : " + refus });
  }
  if (regle.ramassage) {
    const refus = verifierRamassage(Buffer.concat(chunks).toString("utf8"), cleRam);
    if (refus) return send(403, { error: "ramassage refuse : " + refus });
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
      body: req.method === "GET" ? undefined : Buffer.concat(chunks),
    });
    let text = await up.text();
    // Un chemin inexistant chez Freightcom renvoie une erreur AWS qui contient une empreinte de l'en-tête
    // d'autorisation : on ne la relaie pas.
    if (up.status === 403 && /Authorization header requires/.test(text)) text = JSON.stringify({ error: "chemin inexistant chez Freightcom" });
    if (req.method === "GET" && /^\/rate\//.test(path) && up.ok) { try { retenirTarifs(JSON.parse(text)); } catch {} }
    if (regle.achat && up.ok) { compteurJour.n++; dejaAchetes.set(cleIdem, { statut: up.status, le: new Date().toISOString() }); }
    if (regle.ramassage && up.ok) { compteurRam.n++; dejaRamasses.set(cleRam, { statut: up.status, le: new Date().toISOString() }); }
    console.log(`${new Date().toISOString()} ${req.method} ${path} -> ${up.status}${regle.achat ? " ACHAT " + cleIdem : ""}${regle.ramassage ? " RAMASSAGE " + cleRam : ""}`);
    res.writeHead(up.status, { "content-type": up.status === 403 && /chemin inexistant/.test(text) ? "application/json" : (up.headers.get("content-type") || "application/json") });
    res.end(text);
  } catch (err) {
    send(502, { error: "echec de la requete amont", detail: String(err) });
  }
});

server.listen(PORT, () => console.log(`passerelle Freightcom (${ENV}) a l'ecoute sur ${PORT}`));
