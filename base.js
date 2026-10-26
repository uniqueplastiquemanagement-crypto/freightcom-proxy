"use strict";
// Pièces communes du connecteur et du magasinage — Unique Plastique inc. — 2026-10-26
// - moteur v5 (empreinte vérifiée : s'il a changé, tout ce qui en dépend se désactive) ;
// - lecture Shopify par l'app « client credentials » (AUCUNE mutation n'existe dans ce fichier) ;
// - règle des boîtes du dépôt (regle_boites.json), validée par le moteur.
const crypto = require("crypto");
const fs = require("fs");
const pathMod = require("path");

const SHA_MOTEUR = "8005ef905d7f34626cbd27c9bea8b701131ab0596c45d271ffff2eba68916c8e";
let M = null, erreurMoteur = null;
try {
  const f = pathMod.join(__dirname, "moteur_v5.js");
  const sha = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  if (sha !== SHA_MOTEUR) erreurMoteur = "moteur_v5.js modifié (empreinte inattendue) : connecteur désactivé";
  else M = require(f);
} catch (e) { erreurMoteur = "moteur_v5.js illisible : connecteur désactivé"; }

// Règle des boîtes du dépôt : la même que celle du Poste (Drive). Sert au magasinage Shopify, qui tourne sans le Poste.
let regleDepot = null, erreurRegle = null;
try {
  regleDepot = JSON.parse(fs.readFileSync(pathMod.join(__dirname, "regle_boites.json"), "utf8"));
  if (M) M.validerRegle(regleDepot);
} catch (e) { regleDepot = null; erreurRegle = "règle des boîtes du dépôt refusée : " + String((e && e.message) || e).slice(0, 160); }

const SHOP = (process.env.SHOPIFY_BOUTIQUE || "").trim().replace(/\.myshopify\.com$/, "");
const CID = (process.env.SHOPIFY_CLIENT_ID || "").trim();
const CSEC = (process.env.SHOPIFY_CLIENT_SECRET || "").trim();
const API_SHOPIFY = /^\d{4}-\d{2}$/.test(process.env.SHOPIFY_API_VERSION || "") ? process.env.SHOPIFY_API_VERSION : "2026-10";
const appShopify = () => !!(SHOP && CID && CSEC);

let jetonShop = { v: null, exp: 0 };
async function jetonShopify() {
  if (jetonShop.v && Date.now() < jetonShop.exp - 60e3) return jetonShop.v;
  if (!appShopify()) throw new Error("app Shopify pas encore branchée (SHOPIFY_BOUTIQUE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET)");
  const r = await fetch(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CID, client_secret: CSEC }).toString(),
    redirect: "error", signal: AbortSignal.timeout(20000),
  });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok || !j || !j.access_token) throw new Error(`Shopify refuse l'accès de l'app (HTTP ${r.status}${j && typeof j.error === "string" ? " : " + j.error.slice(0, 60) : ""})`);
  jetonShop = { v: j.access_token, exp: Date.now() + Math.max(300, Number(j.expires_in) || 3600) * 1000 };
  return jetonShop.v;
}
async function shopify(query, variables) {
  if (/^\s*mutation\b/.test(query)) throw new Error("écriture Shopify refusée : lecture seulement");
  const r = await fetch(`https://${SHOP}.myshopify.com/admin/api/${API_SHOPIFY}/graphql.json`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-shopify-access-token": await jetonShopify() },
    body: JSON.stringify({ query, variables }), redirect: "error", signal: AbortSignal.timeout(30000),
  });
  if (r.status === 401) jetonShop = { v: null, exp: 0 };
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok || !j) throw new Error(`lecture Shopify impossible (HTTP ${r.status})`);
  if (j.errors && j.errors.length) throw new Error("lecture Shopify refusée : " + String(j.errors[0].message || "erreur").slice(0, 160));
  return j.data;
}
// Même lecture que la tâche d'achat (sans les numéros de suivi, inutiles ici).
const CHAMPS_COMMANDE = "id name createdAt test cancelledAt tags note displayFinancialStatus displayFulfillmentStatus discountCodes purchasingEntity { __typename } totalPriceSet { shopMoney { amount } } shippingAddress { name firstName lastName company address1 address2 city provinceCode zip countryCodeV2 phone validationResultSummary } shippingLines(first: 2) { nodes { title } } fulfillments(first: 5) { status } lineItems(first: 50) { nodes { title variantTitle quantity unfulfilledQuantity requiresShipping lineItemGroup { title quantity } variant { selectedOptions { name value } } } }";
const REQ_COMMANDES = `query($q: String!) { orders(first: 20, query: $q) { nodes { ${CHAMPS_COMMANDE} } } }`;
const REQ_OUVERTES = `query($q: String!, $after: String) { orders(first: 50, after: $after, query: $q, sortKey: CREATED_AT) { pageInfo { hasNextPage endCursor } nodes { ${CHAMPS_COMMANDE} } } }`;
const FILTRE_OUVERTES = "status:open AND (fulfillment_status:unfulfilled OR fulfillment_status:partial)";
async function commandesOuvertes(maxPages = 6) {
  let nodes = [], after = null, n = 0;
  do {
    const d = await shopify(REQ_OUVERTES, after ? { q: FILTRE_OUVERTES, after } : { q: FILTRE_OUVERTES });
    const o = d && d.orders;
    if (!o) throw new Error("réponse Shopify sans commandes");
    nodes = nodes.concat(o.nodes || []);
    after = o.pageInfo && o.pageInfo.hasNextPage ? o.pageInfo.endCursor : null;
  } while (after && ++n < maxPages);
  return nodes;
}

const cpNorm = (s) => String(s || "").toUpperCase().replace(/\s/g, "");
const maintenant = () => new Date().toISOString();
const arrondi = (n) => Math.round(n * 100) / 100;
function egal(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

module.exports = {
  M, erreurMoteur, SHA_MOTEUR, regleDepot, erreurRegle,
  SHOP, API_SHOPIFY, appShopify, jetonShopify, shopify, REQ_COMMANDES, commandesOuvertes,
  cpNorm, maintenant, arrondi, egal,
};
