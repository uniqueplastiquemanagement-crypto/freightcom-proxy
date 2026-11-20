// Routes réservées au serveur de l'Espace Unique Plastique (clé de la passerelle exigée, comme le reste).
//   POST /espace/shopify {op, variables} : une des opérations du Poste, mot pour mot (operations_shopify_espace.json,
//        copie identique de celle de l'Espace) ; aucune requête libre. Réponse : la réponse GraphQL brute {data, errors}.
//   GET  /espace/regle-boites : la règle des boîtes du dépôt, la même que celle des achats (une seule source).
"use strict";
const B = require("./base");

const OPERATIONS = require("./operations_shopify_espace.json");
const ID_COMMANDE = /^gid:\/\/shopify\/Order\/\d{1,20}$/;
const FILTRE_PERMIS = /^[\w\s:#()"'.,\-<>=*@]{1,4000}$/;

class Refus extends Error { constructor(statut, m) { super(m); this.statut = statut; } }

// Même contrôle que l'Espace (défense en profondeur) : variables attendues seulement.
function verifierVariables(nom, v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Refus(400, "variables manquantes");
  const permis = (liste) => { for (const k of Object.keys(v)) if (!liste.includes(k)) throw new Refus(400, `variable non permise : ${k}`); };
  switch (nom) {
    case "commandes_ouvertes": case "commandes_recentes": case "commandes_traitees":
      permis(["q", "after", "first"]);
      if (typeof v.q !== "string" || !FILTRE_PERMIS.test(v.q)) throw new Refus(400, "filtre de recherche invalide");
      if (v.after != null && (typeof v.after !== "string" || v.after.length > 400)) throw new Refus(400, "curseur invalide");
      return;
    case "noms_commandes": case "noms_dictee": case "id_commande":
      permis(["q"]);
      if (typeof v.q !== "string" || !/^(name:#\d{3,10})( OR name:#\d{3,10}){0,49}$/.test(v.q)) throw new Refus(400, "recherche par numéros de commande seulement");
      return;
    case "commande_a_traiter": case "adresse_commande":
      permis(["id"]);
      if (!ID_COMMANDE.test(v.id)) throw new Refus(400, "identifiant de commande invalide");
      return;
    case "traiter_commande": {
      permis(["f"]);
      const f = v.f || {};
      if (!Array.isArray(f.lineItemsByFulfillmentOrder) || !f.lineItemsByFulfillmentOrder.length) throw new Refus(400, "traitement : commande à traiter absente");
      for (const x of f.lineItemsByFulfillmentOrder) if (!/^gid:\/\/shopify\/FulfillmentOrder\/\d{1,20}$/.test(String(x.fulfillmentOrderId))) throw new Refus(400, "traitement : identifiant invalide");
      return;
    }
    case "corriger_commande": {
      permis(["input"]);
      const i = v.input || {};
      if (!ID_COMMANDE.test(String(i.id))) throw new Refus(400, "identifiant de commande invalide");
      for (const k of Object.keys(i)) if (!["id", "shippingAddress", "note"].includes(k)) throw new Refus(400, `champ non permis : ${k}`);
      return;
    }
    default: throw new Refus(400, "opération inconnue");
  }
}

async function shopify(corps, fetchImpl = fetch) {
  const nom = corps && corps.op;
  const op = Object.prototype.hasOwnProperty.call(OPERATIONS, nom) ? OPERATIONS[nom] : null;
  if (!op) throw new Refus(400, "opération Shopify non permise");
  verifierVariables(nom, corps.variables);
  if (!B.appShopify()) throw new Refus(503, "app Shopify pas encore branchée");
  const r = await fetchImpl(`https://${B.SHOP}.myshopify.com/admin/api/${B.API_SHOPIFY}/graphql.json`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-shopify-access-token": await B.jetonShopify() },
    body: JSON.stringify({ query: op.query, variables: corps.variables }), redirect: "error", signal: AbortSignal.timeout(30000),
  });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok || !j) throw new Refus(502, `Shopify a répondu ${r.status}`);
  return { op: nom, ecriture: op.ecriture, reponse: j };
}

function regleBoites() {
  if (!B.regleDepot) throw new Refus(503, B.erreurRegle || "règle des boîtes absente");
  return B.regleDepot;
}

module.exports = { shopify, regleBoites, verifierVariables, Refus, OPERATIONS };
