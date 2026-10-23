// Passerelle Freightcom — Unique Plastique inc.
// Détient la clé Freightcom (variable UPSTREAM_TOKEN sur Render) et expose la demande de tarifs
// et la lecture des envois. L'achat d'étiquettes existe mais reste verrouillé tant que
// ACHATS_ACTIVES n'est pas « oui » : une étiquette par commande, plafond quotidien, plafond de 25 $.
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

// Achat d'étiquettes : FERMÉ par défaut. S'ouvre seulement si ACHATS_ACTIVES=oui sur Render.
const ACHATS_ACTIVES   = (process.env.ACHATS_ACTIVES || "non").toLowerCase() === "oui";
const MAX_ACHATS_JOUR  = Math.max(0, Math.min(50, parseInt(process.env.MAX_ACHATS_PAR_JOUR || "10", 10) || 0));

// Surface autorisée. Tout le reste est refusé (ramassages, factures, manifestes, suppressions).
const ALLOW = [
  { m: ["POST"], re: /^\/rate$/ },                                   // demander une soumission (202 + request_id)
  { m: ["GET"],  re: /^\/rate\/[A-Za-z0-9_-]{1,80}$/ },              // lire le résultat de la soumission
  { m: ["GET"],  re: /^\/services$/ },                               // liste des services/transporteurs
  { m: ["GET"],  re: /^\/finance\/payment-methods$/ },               // lire le moyen de paiement (requis pour réserver)
  { m: ["GET"],  re: /^\/shipment\/[A-Za-z0-9_-]{1,80}(\/[A-Za-z0-9_-]{1,40})?$/ }, // lire un envoi et son étiquette
  { m: ["POST"], re: /^\/shipment$/, achat: true },                  // ACHETER une étiquette (verrouillé, voir plus bas)
];
const dejaAchetes = new Map();   // clé d'idempotence -> réponse (perdu au redémarrage : ne pas s'y fier seul)
let compteurJour = { jour: "", n: 0 };

// Plafond de prix : la passerelle retient les tarifs qu'elle a elle-même relayés (GET /rate/<id>)
// et refuse tout achat dont le service n'a pas été vu, ou dont le prix dépasse MAX_PRIX_ETIQUETTE.
// En cas de doute (prix illisible, service inconnu, tarif trop vieux), elle REFUSE.
const MAX_PRIX = Math.min(25, Number(process.env.MAX_PRIX_ETIQUETTE || "25") || 0);  // jamais au-dessus de 25 $
const VALIDITE_TARIF_MS = 3 * 3600e3;
const tarifsVus = new Map();   // service_id -> { montant, le }

function nombre(v) {
  if (v && typeof v === "object") v = v.value ?? v.amount ?? v.total;
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;   // lu tel quel, en dollars ; si c'était des cents, tout sera refusé (sûr)
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
function verifierPrix(corps) {
  let b; try { b = JSON.parse(corps); } catch { return "corps de la demande illisible"; }
  const id = b && (b.service_id ?? (b.service && b.service.id) ?? (b.details && b.details.service_id));
  if (!id) return "service_id introuvable dans la demande d'achat";
  const t = tarifsVus.get(String(id));
  if (!t) return `aucun tarif relaye par la passerelle pour le service ${id}`;
  if (Date.now() - t.le > VALIDITE_TARIF_MS) return "tarif trop vieux (plus de 3 h) : redemander une soumission";
  if (!(t.montant <= MAX_PRIX)) return `prix ${t.montant} $ au-dessus du plafond de ${MAX_PRIX} $`;
  return null;
}
const MAX_BODY = 64 * 1024;

function egal(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

  if (req.url === "/" || req.url === "/health") return send(200, { ok: true, env: ENV, achats_actives: ACHATS_ACTIVES, max_achats_jour: MAX_ACHATS_JOUR, max_prix_etiquette: MAX_PRIX });
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

  const chunks = []; let taille = 0;
  for await (const c of req) { taille += c.length; if (taille > MAX_BODY) return send(413, { error: "requete trop grosse" }); chunks.push(c); }

  if (regle.achat) {
    const refus = verifierPrix(Buffer.concat(chunks).toString("utf8"));
    if (refus) return send(403, { error: "achat refuse : " + refus });
  }

  try {
    const up = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers: {
        authorization: SCHEME ? `${SCHEME} ${TOKEN}` : TOKEN,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: req.method === "GET" ? undefined : Buffer.concat(chunks),
    });
    const text = await up.text();
    if (req.method === "GET" && /^\/rate\//.test(path) && up.ok) { try { retenirTarifs(JSON.parse(text)); } catch {} }
    if (regle.achat && up.ok) { compteurJour.n++; dejaAchetes.set(cleIdem, { statut: up.status, le: new Date().toISOString() }); }
    console.log(`${new Date().toISOString()} ${req.method} ${path} -> ${up.status}${regle.achat ? " ACHAT " + cleIdem : ""}`);
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/json" });
    res.end(text);
  } catch (err) {
    send(502, { error: "echec de la requete amont", detail: String(err) });
  }
});

server.listen(PORT, () => console.log(`passerelle Freightcom (${ENV}) a l'ecoute sur ${PORT}`));
