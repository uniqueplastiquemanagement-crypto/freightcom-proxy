"use strict";
// Table des prix Shopify Shipping (calculateur de l'admin : prix réels, avant taxes), mesurés par zone et par colis.
// Shopify n'a pas d'API de tarifs : cette table sert seulement à ESTIMER le prix Shopify d'une commande, sans crédit,
// pour le comparer au prix Freightcom réel du même colis (le connecteur fait la comparaison).
// Règles de prudence :
// - une estimation n'existe que pour un colis mesuré (même boîte, même poids, ou poids mesuré plus lourd = borne haute,
//   les prix ne baissant jamais avec le poids : la validation le vérifie) ;
// - RTA (3 premiers caractères du code postal) mesurée : sa zone. RTA non mesurée : seulement en ville (2e caractère
//   autre que 0) et seulement si son groupe (2 premiers caractères) est HOMOGÈNE : au moins 3 RTA mesurées, toutes aux
//   mêmes prix. Jamais d'extrapolation à une RTA rurale ni à une région hétérogène (le plus haut d'un groupe n'est pas une
//   borne sûre : l'étude l'a montré) ;
// - RTA trop vaste pour qu'un seul village la représente (villages par avion ou bateau : Basse-Côte-Nord, Nunavik…) :
//   seulement les codes postaux mesurés eux-mêmes (cp_seulement) ;
// - la table a été mesurée depuis une origine précise : autre origine = pas d'estimation ;
// - seuls les transporteurs permis par la règle des boîtes comptent (Purolator et DHL ne sont même pas dans la table) ;
// - après la date de validité (au plus 120 jours après la mesure) : pas d'estimation.
const fs = require("fs");
const path = require("path");

const FICHIER = process.env.TABLE_SHOPIFY_FICHIER || path.join(__dirname, "table_shopify.json");
// RTA canadienne : 1re lettre d'une province, chiffre, lettre permise (pas D, F, I, O, Q, U).
const RE_RTA = /^[ABCEGHJKLMNPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]$/;
const RE_BOITE = /^(\d{1,2})x(\d{1,2})x(\d{1,2})$/;
const RE_CLE = /^([a-z0-9]+(?:x[0-9]+)*)@([1-9]\d{0,2})$/;
const a = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const TRANSP = { UPS: "UPS", "Postes Canada": "Postes Canada" };
const MAX_VALIDITE_JOURS = 120;
const PRIX_MIN_CENTS = 200;      // le moteur refuse tout tarif sous 2 $ : une table en dollars au lieu de cents est refusée
const PRIX_MAX_CENTS = 100000;   // 1000 $

function charger(fichier = FICHIER) {
  const t = JSON.parse(fs.readFileSync(fichier, "utf8"));
  const err = valider(t);
  if (err.length) throw new Error("table Shopify invalide : " + err.slice(0, 5).join(" ; "));
  return t;
}

// Nom canonique d'une boîte : côtés en pouces entiers, triés du plus grand au plus petit (« 9x6x2 »).
function nomBoite(L, l, H) {
  const d = [L, l, H].map(Number);
  if (!d.every((x) => Number.isInteger(x) && x > 0 && x < 100)) return null;
  return d.sort((x, y) => y - x).join("x");
}

function valider(t) {
  const err = [];
  if (!t || typeof t !== "object" || Array.isArray(t)) return ["table absente"];
  if (!/^SHOPIFY-\d{4}-\d{2}-\d{2}/.test(String(t.version || ""))) err.push("version");
  for (const k of ["mesure_le", "valide_jusqu_au"]) if (!/^\d{4}-\d{2}-\d{2}$/.test(String(t[k] || "")) || isNaN(Date.parse(t[k]))) err.push(k);
  if (!err.length) {
    const jours = (Date.parse(t.valide_jusqu_au) - Date.parse(t.mesure_le)) / 864e5;
    if (!(jours >= 0 && jours <= MAX_VALIDITE_JOURS)) err.push(`valide_jusqu_au : au plus ${MAX_VALIDITE_JOURS} jours après la mesure`);
  }
  if (!/^[ABCEGHJKLMNPRSTVXY]\d[A-Z]\d[A-Z]\d$/.test(String(t.origine_cp || ""))) err.push("origine_cp");
  for (const k of ["services", "classes", "zones", "rta"]) if (!t[k] || typeof t[k] !== "object" || Array.isArray(t[k])) err.push(k);
  for (const k of ["groupes", "cp_seulement"]) if (t[k] !== undefined && (!t[k] || typeof t[k] !== "object" || Array.isArray(t[k]))) err.push(k);
  if (err.length) return err;
  for (const [code, s] of Object.entries(t.services)) {
    if (!/^[A-Z]{2,4}$/.test(code)) err.push("service " + code);
    if (!s || !a(TRANSP, s.transporteur) || typeof s.service !== "string" || !s.service.trim()) err.push("service " + code + " : transporteur ou nom");
  }
  const vues = new Set();
  for (const [cle, c] of Object.entries(t.classes)) {
    if (!/^[a-z0-9]+(?:x[0-9]+)*$/.test(cle) || !c || !Array.isArray(c.boites) || !c.boites.length) { err.push("classe " + cle); continue; }
    for (const b of c.boites) {
      const m = RE_BOITE.exec(String(b));
      if (!m || nomBoite(m[1], m[2], m[3]) !== b) err.push(`classe ${cle} : boîte ${b} (nom canonique attendu, côtés triés)`);
      if (vues.has(b)) err.push(`boîte ${b} dans deux classes`);
      vues.add(b);
    }
  }
  for (const [z, zone] of Object.entries(t.zones)) {
    if (!/^Z\d{2,3}$/.test(z) || !zone || typeof zone.prix !== "object" || !zone.prix) { err.push("zone " + z); continue; }
    const parClasse = {};
    for (const [k, px] of Object.entries(zone.prix)) {
      const m = RE_CLE.exec(k);
      if (!m || !a(t.classes, m[1])) { err.push(`zone ${z} : clé ${k}`); continue; }
      if (!px || typeof px !== "object" || !Object.keys(px).length) { err.push(`zone ${z} ${k} : vide`); continue; }
      for (const [code, v] of Object.entries(px)) {
        if (!a(t.services, code)) err.push(`zone ${z} ${k} : service ${code}`);
        if (!Array.isArray(v) || !(Number.isInteger(v[0]) && v[0] >= PRIX_MIN_CENTS && v[0] <= PRIX_MAX_CENTS) || !(Number.isInteger(v[1]) && v[1] >= 1 && v[1] <= 15)) err.push(`zone ${z} ${k} ${code} : valeur`);
      }
      (parClasse[m[1]] = parClasse[m[1]] || []).push([Number(m[2]), px]);
    }
    // Le prix ne baisse jamais avec le poids (sinon la « borne haute » serait fausse) : par service et pour le moins cher.
    for (const [cl, l] of Object.entries(parClasse)) {
      l.sort((x, y) => x[0] - y[0]);
      const min = (px) => Math.min(...Object.values(px).map((v) => v[0]));
      for (let i = 1; i < l.length; i++) {
        if (min(l[i][1]) < min(l[i - 1][1])) err.push(`zone ${z} ${cl} : le moins cher baisse de ${l[i - 1][0]} à ${l[i][0]} lb`);
        for (const [code, v] of Object.entries(l[i][1])) {
          const avant = l.slice(0, i).map((x) => x[1][code]).filter(Boolean).pop();
          if (avant && v[0] < avant[0]) err.push(`zone ${z} ${cl} ${code} : prix qui baisse à ${l[i][0]} lb`);
        }
      }
    }
  }
  for (const [rta, z] of Object.entries(t.rta)) if (!RE_RTA.test(rta) || !a(t.zones, z)) err.push("rta " + rta);
  for (const [g, v] of Object.entries(t.groupes || {})) {
    if (!/^[ABCEGHJKLMNPRSTVXY][1-9]$/.test(g) || !v || !Array.isArray(v.zones) || v.zones.length !== 1 || !a(t.zones, v.zones[0])) err.push("groupe " + g + " (une seule zone, ville seulement)");
    else if (!Array.isArray(v.rta_mesurees) || v.rta_mesurees.length < 3 || !v.rta_mesurees.every((r) => a(t.rta, r) && t.rta[r] === v.zones[0] && r.startsWith(g))) err.push("groupe " + g + " : au moins 3 RTA mesurées de la même zone");
    // TOUTES les RTA mesurées qui commencent par ces 2 caractères doivent être dans la zone du groupe (sinon il n'est pas homogène)
    else if (Object.keys(t.rta).some((r) => r.startsWith(g) && t.rta[r] !== v.zones[0])) err.push("groupe " + g + " : une RTA mesurée du groupe est dans une autre zone");
  }
  for (const [r, cps] of Object.entries(t.cp_seulement || {})) {
    if (!RE_RTA.test(r) || !Array.isArray(cps) || !cps.every((c) => /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(c) && c.startsWith(r))) err.push("cp_seulement " + r);
  }
  return err;
}

function classeDe(t, L, l, H) {
  const n = nomBoite(L, l, H);
  if (!n) return null;
  for (const [cle, c] of Object.entries(t.classes)) if (c.boites.includes(n)) return cle;
  return null;
}

// Prix d'un colis dans une zone : le service le moins cher parmi les transporteurs permis (« rapide » = 2 jours ou moins).
// Poids non mesuré : le prix mesuré au poids supérieur le plus proche = borne haute.
function prixZone(t, z, classe, lb, { rapide = false, permis = null } = {}) {
  const prix = (a(t.zones, z) && t.zones[z].prix) || {};
  let k = `${classe}@${lb}`, borne = false;
  if (!a(prix, k)) {
    const plus = Object.keys(prix).map((x) => RE_CLE.exec(x)).filter((m) => m && m[1] === classe && Number(m[2]) > lb).map((m) => Number(m[2])).sort((x, y) => x - y);
    if (!plus.length) return null;
    k = `${classe}@${plus[0]}`; borne = true;
  }
  let best = null;
  for (const [code, v] of Object.entries(prix[k])) {
    if (!a(t.services, code)) continue;
    if (permis && !permis.has(t.services[code].transporteur)) continue;
    if (rapide && v[1] > 2) continue;
    if (!best || v[0] < best.cents) best = { code, cents: v[0], jours: v[1] };
  }
  return best ? Object.assign(best, { cle: k, borne }) : null;
}

function zonePour(t, cp) {
  const c = String(cp || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(c)) return null;
  const rta = c.slice(0, 3);
  if (!RE_RTA.test(rta)) return null;
  // RTA trop vaste (villages sur la route et villages par avion ou bateau) : seulement les codes postaux mesurés.
  if (t.cp_seulement && a(t.cp_seulement, rta) && !t.cp_seulement[rta].includes(c)) return null;
  if (a(t.rta, rta)) return { zone: t.rta[rta], approx: false, rta };
  // RTA non mesurée : jamais en milieu rural (2e caractère 0) ; groupe homogène de 2 caractères seulement.
  const g = rta.slice(0, 2);
  if (rta[1] !== "0" && t.groupes && a(t.groupes, g)) return { zone: t.groupes[g].zones[0], approx: true, rta, groupe: g };
  return null;
}

// Transporteurs permis (noms canoniques du moteur : « UPS », « GLS », « Postes Canada ») -> ceux de la table.
function permisDe(transporteurs) {
  if (!Array.isArray(transporteurs)) return null;
  return new Set(transporteurs.map(String).filter((x) => a(TRANSP, x)));
}

// Estimation pour une commande : colis [{longueur_po, largeur_po, hauteur_po, poids_lb}], code postal, pays, origine,
// transporteurs permis, rapide. Réponse : { ok:true, montant (dollars, avant taxes), cents, service, transporteur, detail[],
// approx, borne } ou { ok:false, raison }.
function estimer(t, { colis, code_postal, pays = "CA", origine_cp, transporteurs = null, rapide = false, maintenant = new Date() }) {
  if (!t) return { ok: false, raison: "table Shopify absente" };
  if (String(pays || "").toUpperCase() !== "CA") return { ok: false, raison: "hors Canada" };
  if (maintenant.toISOString().slice(0, 10) > t.valide_jusqu_au) return { ok: false, raison: `table Shopify périmée (valide jusqu'au ${t.valide_jusqu_au})` };
  const o = String(origine_cp || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (o !== t.origine_cp) return { ok: false, raison: `table Shopify mesurée depuis une autre origine (${t.origine_cp} ; envoi depuis ${o || "?"}) : à remesurer` };
  const zp = zonePour(t, code_postal);
  if (!zp) return { ok: false, raison: "région absente de la table Shopify" };
  if (!Array.isArray(colis) || !colis.length) return { ok: false, raison: "aucun colis" };
  const permis = permisDe(transporteurs);
  if (permis && !permis.size) return { ok: false, raison: "aucun transporteur de la table permis par la règle" };
  // Chaque colis a sa propre étiquette : on additionne le service le moins cher de chacun.
  let total = 0, borne = false;
  const detail = [];
  for (const c of colis) {
    const lb = Number(c && c.poids_lb);
    if (!(Number.isInteger(lb) && lb >= 1 && lb <= 150)) return { ok: false, raison: "poids hors table" };
    const classe = classeDe(t, c.longueur_po, c.largeur_po, c.hauteur_po);
    if (!classe) return { ok: false, raison: `boîte ${nomBoite(c.longueur_po, c.largeur_po, c.hauteur_po) || "?"} absente de la table Shopify` };
    const p = prixZone(t, zp.zone, classe, lb, { rapide, permis });
    if (!p) return { ok: false, raison: `colis ${classe} à ${lb} lb non mesuré dans la table Shopify${rapide ? " (service rapide)" : ""}` };
    borne = borne || p.borne;
    total += p.cents;
    detail.push({ classe, poids_lb: lb, zone: zp.zone, mesure: p.cle, service: t.services[p.code].service, transporteur: t.services[p.code].transporteur, montant: p.cents / 100, jours: p.jours });
  }
  const services = [...new Set(detail.map((d) => d.service))];
  const transp = [...new Set(detail.map((d) => d.transporteur))];
  return { ok: true, cents: total, montant: total / 100, service: services.join(" + "), transporteur: transp.join(" + "), detail, approx: zp.approx, borne,
    rta: zp.rta, groupe: zp.groupe || null, table: t.version };
}

module.exports = { charger, valider, estimer, nomBoite, classeDe, zonePour, prixZone, permisDe, FICHIER, RE_RTA };
