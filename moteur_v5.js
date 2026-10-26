#!/usr/bin/env node
"use strict";
// Moteur de comparaison des étiquettes — Unique Plastique inc. — version 3 (colis B2C par Freightcom, règle des boîtes d'Alexandre)
// Aucune dépendance. Ne fait AUCUN achat : il produit un plan et une décision.
//
//   node moteur.js plan            commandes.json regle_boites.json                > plan.json
//   node moteur.js demande-freightcom plan.json regle_boites.json <no> <AAAA-MM-JJ>  > demande.json (corps de POST /rate)
//   node moteur.js ajouter-freightcom plan.json tarifs.json <no> reponse.json         (ajoute les tarifs de GET /rate/<id>)
//   node moteur.js ajouter-shopify plan.json tarifs.json <no> brut.txt             (ancien : calculateur Shopify)
//   node moteur.js decision        plan.json tarifs.json regle_boites.json         > decision.json
//
// Garde-fous codés en dur (une règle modifiée dans Drive ne peut pas les dépasser) :
const LIMITES = Object.freeze({
  SEUIL_MAX: 25,                                   // $ avant taxes : au-delà, jamais d'achat automatique (B2C)
  SEUIL_MAX_B2B: 150,                              // $ avant taxes : plafond absolu pour le B2B (le plafond réel est dans la règle)
  TRANSPORTEURS: ["UPS", "GLS", "Postes Canada"],  // seuls transporteurs admissibles
  VALIDITE_MAX_H: 6,
  PRIX_PLANCHER: 2,                                // un tarif sous 2 $ est jugé illisible
  DECALAGE_HORLOGE_MS: 5 * 60e3,
  LIGNES_MAX: 50,
  COLIS_MAX: 6,                                    // au-delà : à traiter à la main
});
const fs = require("fs");
const crypto = require("crypto");
const G_PAR_LB = 453.59237;
const R = (code, texte) => ({ code, texte });

// ---------- Utilitaires ----------
function norm(s) {
  return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’']/g, "'").trim();
}
// Exactement UN montant avec 2 décimales (ex. « 10,84 $ CAD », « $12.34 », « 1 234,50 $ »). Sinon null.
function prix(texte) {
  if (typeof texte === "number") return Number.isFinite(texte) && texte >= LIMITES.PRIX_PLANCHER ? Math.round(texte * 100) / 100 : null;
  const t = String(texte || "").replace(/[  ]/g, " ");
  const toks = t.match(/(?<![\d.,])\d{1,3}(?:[ ,]\d{3})*[.,]\d{2}(?![\d])|(?<![\d.,])\d+[.,]\d{2}(?![\d])/g) || [];
  const uniques = [...new Set(toks)];
  if (uniques.length !== 1) return null;
  let s = uniques[0];
  const dec = s.slice(-3, -2);
  s = s.slice(0, -3).replace(/[ ,.]/g, "") + "." + s.slice(-2);
  if (dec !== "," && dec !== ".") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= LIMITES.PRIX_PLANCHER ? Math.round(n * 100) / 100 : null;
}
function cpNorm(s) { return String(s || "").toUpperCase().replace(/\s/g, ""); }
function cle(origineCp, dest, boite, lb) {
  const base = [cpNorm(origineCp), cpNorm(dest.code_postal), dest.pays, dest.type_lieu, boite.nom, boite.longueur_po, boite.largeur_po, boite.hauteur_po, lb].join("|");
  return crypto.createHash("sha256").update(base).digest("hex").slice(0, 16);
}
function transporteurCanonique(nom) {
  const n = norm(nom);
  if (!n) return "Inconnu";
  if (/purolator/.test(n)) return "Purolator";
  if (/fedex/.test(n)) return "FedEx";
  if (/\bdhl\b/.test(n)) return "DHL";
  if (/canpar/.test(n)) return "Canpar";
  if (/loomis/.test(n)) return "Loomis";
  if (/\bics\b/.test(n)) return "ICS";
  if (/\bups\b/.test(n)) return "UPS";
  if (/\bgls\b|dicom/.test(n)) return "GLS";
  if (/postes canada|canada post|expedited parcel|regular parcel|xpresspost|colis acceleres|colis standard|colis prioritaire|petit paquet|small packet|^priority$|^prioritaire$/.test(n)) return "Postes Canada";
  return "Inconnu";
}
function joursDelai(d) { const m = norm(d).match(/(\d+)/g); return m ? Math.max(...m.map(Number)) : 99; }
function isoValide(s, maintenant, validiteMs) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(s)) return false;
  const d = Date.parse(s);
  return Number.isFinite(d) && d <= maintenant.getTime() + LIMITES.DECALAGE_HORLOGE_MS && maintenant.getTime() - d <= validiteMs;
}

// ---------- Validation de la règle (rejette, ne corrige jamais) ----------
// ---------- Remplissage des boîtes (feuille d'Alexandre, 2026-10-23) ----------
function rentre(b, n) {
  const P = n.P || 0, M = n.M || 0, G = n.G || 0;
  if (P < 0 || M < 0 || G < 0) return false;
  if (G > 0 && !b.max.G) return false;
  if (G > (b.max.G || 0)) return false;
  // Moyennes : dans l'espace principal si la boîte les accepte seules, sinon seulement comme objet de trou
  let Mprincipal = M, Mtrou = 0;
  if (!b.max.M) { if (!b.trou_accepte_M) { if (M) return false; } Mprincipal = 0; Mtrou = M; }
  if (b.max.M && M > b.max.M) return false;
  if (b.max.P && P > b.max.P) return false;
  const f = (G ? G / b.max.G : 0) + (Mprincipal ? Mprincipal / b.max.M : 0);
  // trou disponible selon ce qui remplit la boîte
  const trouPlein = G && Mprincipal ? Math.min(b.trou.G, b.trou.M) : G ? b.trou.G : Mprincipal ? b.trou.M : 0;
  // Les trous (petites glissées dans les espaces) n'existent que dans une boîte presque pleine (≥ 75 %).
  // Pour qu'enlever une pince ne fasse jamais « déborder » une boîte, on prend le meilleur des deux :
  // la place libre réelle, ou ce qu'on aurait à 75 % de remplissage (place libre + trous).
  const SEUIL = b.seuil_trous != null ? b.seuil_trous : 0.75;   // seuil_trous (par boîte) : 6x4x2 = 1, les trous n'existent que boîte pleine (3 M + 3 P ne rentrent pas, 26 oct.)
  const pPlace = b.max.P || b.p_melange || 0;   // p_melange : petites qui tiennent dans l'espace libre d'une boîte non utilisée pour des petites seules
  const placeA = x => (pPlace ? Math.floor((1 - x) * pPlace + 1e-9) : 0);
  const trou = trouPlein;
  if (f <= 1 + 1e-9) {
    const permis = f >= SEUIL - 1e-9 ? placeA(f) + trou : Math.max(placeA(f), placeA(SEUIL) + trou);
    if (!G && !Mprincipal) return (P + Mtrou) <= (b.max.P || 0) && Mtrou === 0;   // petites seules
    return P + Mtrou <= permis;
  }
  // dépassement : seulement des moyennes en plus de grandes, dans la limite permise
  if (!(G && Mprincipal)) return false;
  const exces = f - 1;
  if (exces > (b.depassement_M || 0) / b.max.M + 1e-9) return false;
  const coutTrou = Math.ceil(exces * (b.max.P || b.p_melange || b.max.M * 2) - 1e-9);
  return P + Mtrou <= Math.max(0, trou - coutTrou);
}

// Gros formats (feuille « Choix des boîtes d'expédition ») : paliers de 18 pinces, avec ou sans présentoir.
// Au-delà du plus gros palier : autant de cartons du plus gros palier que nécessaire, puis le palier du reste.
function grosFormat(regle, n, avec) {
  const paliers = [...(regle.gros_formats || [])].sort((a, b) => a.pinces - b.pinces);
  if (!paliers.length) return null;
  const choix = (p) => { const v = avec ? p.avec : p.sans; const b = (regle.cartons || []).find(c => c.nom === v.carton); return b ? { boite: b, pinces: p.pinces, kg: v.kg, consigne: v.consigne || "", a_confirmer: v.a_confirmer || null, avec } : null; };
  const max = paliers[paliers.length - 1];
  const out = []; let reste = n;
  while (reste > max.pinces) { const c = choix(max); if (!c) return null; out.push(c); reste -= max.pinces; if (out.length >= LIMITES.COLIS_MAX) return null; }
  const p = paliers.find(x => x.pinces >= reste); const c = p && choix(p); if (!c) return null;
  out.push({ ...c, pinces: reste });
  return out.length > LIMITES.COLIS_MAX ? null : out;
}

// Boîtes de financement (B2C) : chaque boîte est une 9x6x2 scellée préparée d'avance.
// Les pinces en vrac sont regroupées en « boîtes équivalentes » 9x6x2. Une seule boîte part telle quelle ;
// sinon les boîtes sont empilées dans le carton de financement_empilage (par paliers), plusieurs cartons au-delà du plus gros.
function financementColis(regle, nbFin, finPieces, vrac) {
  const b962 = regle.boites.find(b => b.nom === "9x6x2");
  if (!b962) return null;
  const nV = vrac.P + vrac.M + vrac.G;
  const unitesVrac = nV ? ((repartir({ ...regle, boites: [b962] }, vrac) || []).length || Math.ceil(nV / 12)) : 0;
  const unites = nbFin + unitesVrac;
  const poidsPinces = ["P", "M", "G"].reduce((s, k) => s + (finPieces[k] + vrac[k]) * regle.poids_g[k], 0);
  const poidsUnites = poidsPinces + unites * b962.poids_vide_g;
  if (unites === 1) return { colis: [{ boite: "9x6x2", longueur_po: 9, largeur_po: 6, hauteur_po: 2, unites: 1, pieces: { ...finPieces }, poids_g: poidsUnites, poids_lb: Math.max(1, Math.ceil(poidsUnites / G_PAR_LB)) }], note: "boîte de financement seule : part telle quelle dans sa 9x6x2 scellée" };
  const paliers = [...(regle.financement_empilage || [])].sort((a, b) => a.max_boites - b.max_boites);
  if (!paliers.length) return null;
  const max = paliers[paliers.length - 1];
  const tailles = []; let reste = unites;
  while (reste > max.max_boites) { tailles.push(max.max_boites); reste -= max.max_boites; }
  tailles.push(reste);
  if (tailles.length > LIMITES.COLIS_MAX) return null;
  const colis = [];
  for (const n of tailles) {
    const p = paliers.find(x => x.max_boites >= n);
    const carton = p && (regle.cartons || []).find(c => c.nom === p.carton);
    if (!carton) return null;
    const g = Math.round(poidsUnites * n / unites) + (carton.poids_vide_g || 0);
    colis.push({ boite: carton.nom, longueur_po: carton.longueur_po, largeur_po: carton.largeur_po, hauteur_po: carton.hauteur_po, unites: n, pieces: null, poids_g: g, poids_lb: Math.max(1, Math.ceil(g / G_PAR_LB)) });
  }
  return { colis, note: `${nbFin} boîte(s) de financement${unitesVrac ? ` + ${unitesVrac} 9x6x2 de pinces en vrac` : ""} : ` + colis.map(c => `${c.unites} boîtes 9x6x2 empilées dans une ${c.boite}`).join(" + ") };
}

// Plus petite boîte (volume, puis contour) dans laquelle le contenu rentre ; null si aucune.
function choisirBoite(regle, n) {
  const vol = b => b.longueur_po * b.largeur_po * b.hauteur_po;
  const contour = b => b.longueur_po + 2 * (b.largeur_po + b.hauteur_po);
  return [...regle.boites].sort((x, y) => vol(x) - vol(y) || contour(x) - contour(y)).find(b => rentre(b, n)) || null;
}

function validerRegle(r) {
  const err = [];
  const pos = v => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (!r || typeof r !== "object") throw new Error("Règle des boîtes invalide : fichier vide");
  if (typeof r.version !== "string" || !r.version.trim()) err.push("version manquante");
  if ("achats_permis" in r && typeof r.achats_permis !== "boolean") err.push("achats_permis doit être true ou false");
  if (!Array.isArray(r.boites) || !r.boites.length) err.push("aucune boîte définie");
  for (const b of r.boites || []) {
    if (!b || typeof b.nom !== "string" || !b.nom.trim()) { err.push("boîte sans nom"); continue; }
    for (const k of ["longueur_po", "largeur_po", "hauteur_po"]) if (!(Number.isInteger(b[k]) && b[k] > 0)) err.push(`boîte ${b.nom} : ${k} doit être un entier positif (Freightcom refuse les décimales)`);
    const entierOuNul = v => v === null || (Number.isInteger(v) && v > 0);
    if (!b.max || !["P", "M", "G"].every(k => entierOuNul(b.max[k]))) err.push(`boîte ${b.nom} : max.P, max.M et max.G doivent être des entiers positifs ou null`);
    else if (!b.max.P && !b.max.M && !b.max.G) err.push(`boîte ${b.nom} : aucun maximum défini`);
    if (!b.trou || !["G", "M"].every(k => Number.isInteger(b.trou[k]) && b.trou[k] >= 0)) err.push(`boîte ${b.nom} : trou.G et trou.M doivent être des entiers ≥ 0`);
    if (!(Number.isInteger(b.depassement_M || 0) && (b.depassement_M || 0) >= 0)) err.push(`boîte ${b.nom} : depassement_M invalide`);
    if (!(typeof b.poids_vide_g === "number" && b.poids_vide_g >= 0)) err.push(`boîte ${b.nom} : poids_vide_g manquant`);
    if (b.p_melange != null && !(Number.isInteger(b.p_melange) && b.p_melange > 0)) err.push(`boîte ${b.nom} : p_melange doit être un entier positif`);
    if (b.seuil_trous != null && !(typeof b.seuil_trous === "number" && b.seuil_trous >= 0.5 && b.seuil_trous <= 1)) err.push(`boîte ${b.nom} : seuil_trous doit être entre 0,5 et 1`);
    for (const e of b.exemples || []) if (!rentre(b, e)) err.push(`boîte ${b.nom} : l'exemple ${JSON.stringify(e)} ne rentre pas selon les paramètres (règle incohérente)`);
  }
  for (const k of ["P", "M", "G"]) if (!(r.poids_g && pos(r.poids_g[k]))) err.push(`poids ${k} manquant ou nul`);
  const fc = r.financement_contenu;
  if (!fc || !["P", "M", "G"].every(k => Number.isInteger(fc[k] || 0) && (fc[k] || 0) >= 0) || !((fc.P || 0) + (fc.M || 0) + (fc.G || 0))) err.push("financement_contenu manquant (pinces P/M/G d'une boîte de financement)");
  if (!(pos(r.seuil_signalement_dollars) && r.seuil_signalement_dollars <= LIMITES.SEUIL_MAX)) err.push(`seuil_signalement_dollars doit être entre 0 et ${LIMITES.SEUIL_MAX}`);
  if (r.seuil_signalement_dollars_b2b != null && !(pos(r.seuil_signalement_dollars_b2b) && r.seuil_signalement_dollars_b2b <= LIMITES.SEUIL_MAX_B2B)) err.push(`seuil_signalement_dollars_b2b doit être entre 0 et ${LIMITES.SEUIL_MAX_B2B}, ou null`);
  if (!Array.isArray(r.transporteurs_permis) || !r.transporteurs_permis.length) err.push("transporteurs_permis manquant");
  else for (const t of r.transporteurs_permis) if (!LIMITES.TRANSPORTEURS.includes(transporteurCanonique(t))) err.push(`transporteur non autorisé : ${t}`);
  if (!(pos(r.validite_tarifs_heures) && r.validite_tarifs_heures <= LIMITES.VALIDITE_MAX_H)) err.push(`validite_tarifs_heures doit être entre 0 et ${LIMITES.VALIDITE_MAX_H}`);
  if (!Array.isArray(r.plateformes_requises) || !r.plateformes_requises.length || r.plateformes_requises.some(p => !["shopify", "freightcom"].includes(p))) err.push("plateformes_requises invalide");
  for (const [k, v] of Object.entries(r.tailles_par_titre || {})) {
    if (!norm(k)) err.push("tailles_par_titre : clé vide");
    if (!["P", "M", "G"].includes(v)) err.push(`tailles_par_titre « ${k} » : valeur ${v} (P, M ou G attendu)`);
  }
  if (!r.origine || !/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(cpNorm(r.origine.code_postal))) err.push("origine.code_postal invalide");
  const cartons = new Map((r.cartons || []).map(c => [c.nom, c]));
  for (const c of r.cartons || []) for (const k of ["longueur_po", "largeur_po", "hauteur_po"]) if (!(Number.isInteger(c[k]) && c[k] > 0)) err.push(`carton ${c.nom} : ${k} doit être un entier positif`);
  if (!Array.isArray(r.gros_formats) || !r.gros_formats.length) err.push("gros_formats manquant (feuille des cartons)");
  for (const f of r.financement_empilage || []) if (!(Number.isInteger(f.max_boites) && f.max_boites > 1) || !cartons.has(f.carton)) err.push(`financement_empilage ${f.max_boites} : palier ou carton invalide`);
  for (const g of r.gros_formats || []) {
    if (!(Number.isInteger(g.pinces) && g.pinces > 0)) err.push("gros_formats : pinces doit être un entier positif");
    for (const k of ["avec", "sans"]) { const v = g[k]; if (!v || !cartons.has(v.carton)) err.push(`gros_formats ${g.pinces} ${k} : carton inconnu`); else if (!pos(v.kg)) err.push(`gros_formats ${g.pinces} ${k} : poids kg manquant`); }
  }
  if (err.length) throw new Error("Règle des boîtes invalide : " + err.join(" ; "));
}
const achatsPermis = r => r && r.achats_permis === true;


// Répartition en colis : une seule boîte si possible (la plus petite) ; sinon on remplit la plus grande boîte
// en priorité avec les grandes, puis les moyennes, puis les petites, et on recommence avec le reste.
function remplirAuMax(b, n) {
  let best = null;
  for (let G = Math.min(n.G, b.max.G || 0); G >= 0; G--) {
    for (let M = n.M; M >= 0; M--) {
      if (!rentre(b, { P: 0, M, G }) && !(M === 0 && G === 0)) continue;
      let P = n.P; while (P > 0 && !rentre(b, { P, M, G })) P--;
      if (!rentre(b, { P, M, G }) || P + M + G === 0) continue;
      const score = [G, M, P];
      if (!best || score[0] > best[0] || (score[0] === best[0] && (score[1] > best[1] || (score[1] === best[1] && score[2] > best[2])))) best = score;
      break;
    }
  }
  return best ? { G: best[0], M: best[1], P: best[2] } : null;
}
function repartir(regle, pieces) {
  const vol = b => b.longueur_po * b.largeur_po * b.hauteur_po;
  const parTaille = [...regle.boites].sort((x, y) => vol(y) - vol(x));
  const colis = []; let reste = { ...pieces };
  while (reste.P + reste.M + reste.G > 0) {
    if (colis.length >= LIMITES.COLIS_MAX) return null;
    const seule = choisirBoite(regle, reste);
    if (seule) { colis.push({ boite: seule, pieces: reste }); break; }
    let pris = null, boite = null;
    for (const b of parTaille) { const c = remplirAuMax(b, reste); if (c) { pris = c; boite = b; break; } }
    if (!pris) return null;
    colis.push({ boite, pieces: pris });
    reste = { P: reste.P - pris.P, M: reste.M - pris.M, G: reste.G - pris.G };
  }
  return colis;
}

// ---------- Classement des articles ----------
// Mêmes règles B2B que la tâche des bons d'expédition.
const PREFIXES_B2B = ["pinces distribution", "carton", "cartons de pinces", "presentoir", "ajustement de commande de distributeur", "collection classique - boutique", "collection classique - pharmacie"];
const MOTS_TAILLE = [["P", /^(petites?|small|s)$/], ["M", /^(moyennes?|medium|m)$/], ["G", /^(grandes?|large|l)$/]];

function tailleMot(v) { const n = norm(v); for (const [t, re] of MOTS_TAILLE) if (re.test(n)) return t; return null; }
function tailleDepuis(ligne, regle) {
  const opts = (ligne.variant && ligne.variant.selectedOptions) || [];
  for (const o of opts) if (/^(grandeur|taille|size|format)$/.test(norm(o.name))) { const t = tailleMot(o.value); if (t) return t; }
  const titre = norm(ligne.title) + " " + norm(ligne.variantTitle);
  for (const [k, t] of Object.entries(regle.tailles_par_titre || {})) if (norm(k) && titre.includes(norm(k))) return t;
  const debut = titre.match(/^(petites?|moyennes?|grandes?)(?=\s|-|$)/);
  if (debut) return tailleMot(debut[1]);
  if (/\bpetites? pinces?\b|\bpinces? petites?\b/.test(titre)) return "P";
  if (/\bmoyennes? pinces?\b|\bpinces? moyennes?\b/.test(titre)) return "M";
  if (/\bgrandes? pinces?\b|\bpinces? grandes?\b/.test(titre)) return "G";
  return null;
}
// « 6 pinces pour le prix de 4 », « 15 pour 9 », « 14 pour 9 - Grandes », « kit de 3 », « Promotion 5 pinces »
const RE_KIT = /\b(\d+)\s*(?:pinces?\s*)?(?:grandes?\s*|moyennes?\s*|petites?\s*)?(?:pinces?\s*)?pour\s*(?:le prix de\s*)?\d+\b|\b(?:kit|lot|trio|duo) de (\d+)\b|\b(?:promotion|promo)\s+(\d+)\s+pinces?\b/;

// Lignes B2B : pinces de distribution, présentoirs, lots de 18 ; les cartons de montage et lignes d'information ne prennent pas de place à part.
function classerB2B(ligne, titre, qte, regle) {
  const base = { b2b: true, titre: ligne.title, qte };
  if (/presentoir revendeur/.test(titre)) { const m = titre.match(/lot de (\d+)/); const n = m ? Number(m[1]) : 18; return { ...base, type: "pinces", pinces: { M: n * qte }, presentoirs: qte, note: `lot de ${n} avec présentoir` }; }
  if (/^presentoir/.test(titre)) return { ...base, type: "presentoir", presentoirs: qte };
  if (/^pinces distribution/.test(titre)) { const t = tailleDepuis(ligne, regle) || (() => { const m = titre.match(/\b(petites?|moyennes?|grandes?)\b/); return m ? tailleMot(m[1]) : null; })(); return { ...base, type: "pinces", pinces: { [t || "M"]: qte }, inconnu: !t }; }
  if (/^cartons de pinces/.test(titre)) return { ...base, type: "inconnu" };
  if (/^collection/.test(titre)) { const k = norm(ligne.title + " " + (ligne.variantTitle || "")).match(RE_KIT); return k ? { ...base, type: "pinces", pinces: { M: qte * Number(k[1] || k[2] || k[3]) } } : { ...base, type: "kit_inconnu" }; }
  return { ...base, type: "accessoire" };
}

function classerLigne(ligne, regle) {
  const titre = norm(ligne.title);
  const complet = titre + " " + norm(ligne.variantTitle);
  const qte = Number(ligne.unfulfilledQuantity || 0);
  if (PREFIXES_B2B.some(p => titre.startsWith(p)) || /presentoir revendeur/.test(titre)) return classerB2B(ligne, titre, qte, regle);
  // « Kit 3 grandeurs — 24 pinces revendeur » (B2B) : autant de petites, de moyennes et de grandes (8 + 8 + 8)
  if (/^kit 3 grandeurs\b/.test(titre)) { const n = Number((titre.match(/(\d+)\s*pinces/) || [])[1] || 24), k = Math.round(n / 3) * qte; return { b2b: true, titre: ligne.title, qte, type: "pinces", pinces: { P: k, M: k, G: k }, note: `kit 3 grandeurs : ${k} petites, ${k} moyennes, ${k} grandes` }; }
  if (titre.startsWith("campagne de financement")) {
    if (/boite de ?12/.test(titre)) return { type: "boite_financement", qte, titre: ligne.title, contenu: { ...regle.financement_contenu } };
    if (/boite grandes/.test(titre) && /9 pinces/.test(titre)) return { type: "boite_financement", qte, titre: ligne.title, contenu: { P: 0, M: 1, G: 8 }, note: "boîte grandes (9 pinces) : 8 grandes + 1 moyenne, scellée" };
    return { type: "inconnu", qte, titre: ligne.title };
  }
  if (/^boite (de )?financement\b/.test(titre)) return { type: "inconnu", qte, titre: ligne.title };
  if (/^prix coutant\b|^🔒|\binterne\b.*ne pas publier/.test(titre)) return { type: "accessoire", qte, titre: ligne.title };
  const taille = tailleDepuis(ligne, regle);
  const kit = complet.match(RE_KIT);
  if (kit && !ligne.lineItemGroup) {
    const n = Number(kit[1] || kit[2] || kit[3]);
    let t = taille;
    if (!t) { const m = complet.match(/\b(petites?|moyennes?|grandes?)\b/); if (m) t = tailleMot(m[1]); }
    return { type: "pinces", pinces: { [t || "G"]: qte * n }, titre: ligne.title, note: t ? `kit de ${n} compté en pinces` : `kit de ${n} : grandeur inconnue, compté en grandes`, inconnu: !t };
  }
  const parTitre = Object.keys(regle.tailles_par_titre || {}).some(k => norm(k) && complet.includes(norm(k)));
  const estPince = parTitre || /\bpinces?\b/.test(titre) || /^(petites?|moyennes?|grandes?)\s*(-|–|—|\s[a-z])/.test(titre);
  if (estPince && !/\bpour pinces?\b/.test(titre)) return { type: "pinces", pinces: { [taille || "G"]: qte }, titre: ligne.title, inconnu: !taille };
  if (/\b(kit|collection|lot|coffret|ensemble)\b/.test(titre)) return { type: "kit_inconnu", qte, titre: ligne.title };
  return { type: "inconnu", qte, titre: ligne.title };
}

// ---------- Adresse : ce qui sera tapé dans le calculateur ----------
const MOTS_SUSPECTS = /\b(claude|assistant|consigne|instruction|ignore|ignorez|system|prompt|achete|achetez|envoie|envoyez)\b|https?:|www\.|[<>{}]/;
function adresseSuspecte(a) {
  for (const k of ["name", "company", "address1", "address2", "city", "zip", "phone", "provinceCode"]) {
    const v = a[k];
    if (v == null) continue;
    const s = String(v);
    if (s.length > 80 || /[\r\n\t]/.test(s) || MOTS_SUSPECTS.test(norm(s))) return k;
  }
  return null;
}

// ---------- Plan par commande ----------
const CODES_SANS_SOUMISSION = new Set(["MALLET", "STATUT_EXPEDITION", "DEJA_ETIQUETEE", "ADRESSE", "HORS_CANADA", "CODE_POSTAL", "CUEILLETTE", "ADRESSE_SUSPECTE", "AUCUNE_BOITE", "LIGNES_TRONQUEES", "ARTICLE_INCONNU", "KIT_NON_RECONNU", "AUCUNE_PINCE"]);

function planCommande(c, regle) {
  const raisons = [], notes = [];
  const no = String(c.name || "").replace("#", "").trim();
  if (c.test) return { no, statut: "IGNORER", raisons: [R("TEST", "commande test")] };
  if (c.cancelledAt) return { no, statut: "IGNORER", raisons: [R("ANNULEE", "commande annulée")] };

  const toutes = (c.lineItems && c.lineItems.nodes) || [];
  const lignes = toutes.filter(l => l.requiresShipping !== false && Number(l.unfulfilledQuantity || 0) > 0);
  const classes = lignes.map(l => classerLigne(l, regle));
  const estB2B = (c.purchasingEntity && c.purchasingEntity.__typename === "PurchasingCompany") || classes.some(x => x.b2b);
  if (!lignes.length) return { no, statut: "IGNORER", raisons: [R("RIEN", "rien à expédier")] };
  if (toutes.length >= LIMITES.LIGNES_MAX) raisons.push(R("LIGNES_TRONQUEES", `${toutes.length} lignes ou plus : liste peut-être incomplète, à traiter à la main`));

  const mallet = (c.discountCodes || []).map(String).find(k => /mallet/i.test(k));
  if (mallet) raisons.push(R("MALLET", `NE PAS EXPÉDIER : code ${mallet} (campagne Marcelle-Mallet)`));
  if (c.displayFinancialStatus !== "PAID") {
    if (estB2B) notes.push(`B2B : paiement ${String(c.displayFinancialStatus || "inconnu").toLowerCase()} (modalités de paiement)`);
    else raisons.push(R("PAIEMENT", `paiement ${String(c.displayFinancialStatus || "inconnu").toLowerCase()}`));
  }
  if (c.displayFulfillmentStatus !== "UNFULFILLED") raisons.push(R("STATUT_EXPEDITION", `statut d'expédition ${String(c.displayFulfillmentStatus || "inconnu").toLowerCase()} : à traiter à la main`));
  if ((c.fulfillments || []).some(f => f.status !== "CANCELLED")) raisons.push(R("DEJA_ETIQUETEE", "un envoi existe déjà pour cette commande"));

  const a = c.shippingAddress;
  if (!a) raisons.push(R("ADRESSE", "aucune adresse d'expédition"));
  else {
    if (!a.address1 || !a.city || !a.zip || !a.provinceCode) raisons.push(R("ADRESSE", "adresse incomplète"));
    if (a.countryCodeV2 !== "CA") raisons.push(R("HORS_CANADA", `pays ${a.countryCodeV2 || "inconnu"} (Canada seulement)`));
    else if (a.zip && !/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(cpNorm(a.zip))) raisons.push(R("CODE_POSTAL", `code postal invalide (${String(a.zip).slice(0, 12)})`));
    const champ = adresseSuspecte(a);
    if (champ) raisons.push(R("ADRESSE_SUSPECTE", `adresse inhabituelle (champ ${champ}) : à vérifier à la main, rien n'est saisi`));
  }
  const sl = ((c.shippingLines && c.shippingLines.nodes) || []).map(s => norm(s.title));
  if (!sl.length || sl.some(t => /personnalis|custom/.test(t))) {
    if (estB2B) notes.push("B2B : aucun mode de livraison ou livraison personnalisée (commande créée à la main) : cotée quand même");
    else raisons.push(R("BROUILLON", "commande brouillon ou mode de livraison personnalisé"));
  }
  if (sl.some(t => /cueillette|ramassage|pick ?up|retrait|livraison locale|local delivery/.test(t))) raisons.push(R("CUEILLETTE", "cueillette ou livraison locale"));
  const express = sl.some(t => /express|xpresspost|prioritaire|priority/.test(t));
  if (express) notes.push("le client a payé un service rapide : seulement les services de 2 jours ou moins");

  const inconnus = classes.filter(x => x.type === "inconnu");
  if (inconnus.length) raisons.push(R("ARTICLE_INCONNU", "article non classé : " + inconnus.map(x => x.titre).join(", ")));
  const kitsInconnus = classes.filter(x => x.type === "kit_inconnu");
  if (kitsInconnus.length) raisons.push(R("KIT_NON_RECONNU", "kit dont le nombre de pinces est inconnu : " + kitsInconnus.map(x => x.titre).join(", ")));
  for (const x of classes) if (x.inconnu) notes.push(`grandeur inconnue pour « ${x.titre} » : comptée en grande`);
  for (const x of classes) if (x.note && !x.inconnu) notes.push(`« ${x.titre} » : ${x.note}`);

  const contenu = { P: 0, M: 0, G: 0, boite_financement: 0 };
  const finPieces = { P: 0, M: 0, G: 0 };
  for (const x of classes) {
    if (x.type === "pinces") for (const [t, n] of Object.entries(x.pinces)) contenu[t] += n;
    else if (x.type === "boite_financement") { contenu.boite_financement += x.qte; for (const k of ["P", "M", "G"]) finPieces[k] += (x.contenu[k] || 0) * x.qte; }
  }
  const fc = regle.financement_contenu;
  const vrac = { P: contenu.P, M: contenu.M, G: contenu.G };
  const pieces = { P: vrac.P + finPieces.P, M: vrac.M + finPieces.M, G: vrac.G + finPieces.G };
  const equiv = pieces.P + pieces.M + pieces.G;
  const presentoirs = classes.reduce((s, x) => s + (x.presentoirs || 0), 0);
  if (!equiv && !presentoirs && !inconnus.length && !kitsInconnus.length) raisons.push(R("AUCUNE_PINCE", "aucune pince ni présentoir à expédier : à vérifier à la main"));
  const nbFin = contenu.boite_financement;
  const seule = !estB2B && !nbFin && equiv > 0 ? choisirBoite(regle, pieces) : null;
  let colis = [], format = null;
  // Boîtes de financement : empilées dans les cartons de financement, aussi pour un organisme B2B qui n'achète que des boîtes
  // (ex. école, 48 boîtes) ; une commande B2B avec des pinces de distribution suit les gros formats.
  if (nbFin > 0 && (!estB2B || !classes.some(x => x.b2b))) {
    const f = financementColis(regle, nbFin, finPieces, vrac);
    if (!f) raisons.push(R("AUCUNE_BOITE", `boîtes de financement : aucun carton prévu pour ce nombre, à traiter à la main`));
    else { colis = f.colis; notes.push(f.note); }
  } else if (seule) {
    const g = ["P", "M", "G"].reduce((s, k) => s + pieces[k] * regle.poids_g[k], 0) + seule.poids_vide_g;
    colis = [{ boite: seule.nom, longueur_po: seule.longueur_po, largeur_po: seule.largeur_po, hauteur_po: seule.hauteur_po, pieces, poids_g: g, poids_lb: Math.max(1, Math.ceil(g / G_PAR_LB)) }];
  } else if (equiv > 0 || presentoirs > 0) {
    format = grosFormat(regle, Math.max(equiv, 1), presentoirs > 0);
    if (!format) raisons.push(R("AUCUNE_BOITE", `commande trop grosse (${equiv} pinces) : plus de ${LIMITES.COLIS_MAX} cartons, à traiter à la main`));
    else {
      // Poids : celui du tableau des cartons, ou le poids réel des pinces s'il est plus lourd (ex. 90 grandes à 60 g + carton > 5 kg)
      const gPinces = ["P", "M", "G"].reduce((s, k) => s + pieces[k] * regle.poids_g[k], 0);
      colis = format.map(f => { const g = Math.max(Math.round(f.kg * 1000), Math.round(gPinces * f.pinces / Math.max(equiv, 1)) + (f.boite.poids_vide_g || 0));
        return { boite: f.boite.nom, longueur_po: f.boite.longueur_po, largeur_po: f.boite.largeur_po, hauteur_po: f.boite.hauteur_po, pinces: f.pinces, avec_presentoir: f.avec, pieces: null, poids_g: g, poids_lb: Math.max(1, Math.ceil(g / G_PAR_LB)), consigne: f.consigne }; });
      notes.push(`gros format (${equiv} pinces${presentoirs ? `, ${presentoirs} présentoir(s)` : ""}) : ` + format.map(f => `${f.boite.nom} pour ${f.pinces} pinces ${f.avec ? "avec" : "sans"} présentoir — ${f.consigne}`).join(" + "));
      for (const f of format) if (f.a_confirmer) notes.push(`carton ${f.boite.nom} (${f.pinces} pinces ${f.avec ? "avec" : "sans"} présentoir) : ${f.a_confirmer}`);
    }
  }
  if (colis.length > 1) notes.push(`envoi en ${colis.length} colis : ${colis.map(c => c.boite).join(" + ")}`);
  const boite = colis.length === 1 ? { nom: colis[0].boite, nom_shopify: colis[0].boite, longueur_po: colis[0].longueur_po, largeur_po: colis[0].largeur_po, hauteur_po: colis[0].hauteur_po }
    : colis.length > 1 ? { nom: colis.map(c => c.boite).join(" + "), longueur_po: colis[0].longueur_po, largeur_po: colis[0].largeur_po, hauteur_po: colis[0].hauteur_po } : null;
  const poidsTotalG = colis.reduce((s, c) => s + c.poids_g, 0);
  const lb = colis.length > 1 ? colis.reduce((s, c) => s + c.poids_lb, 0) : Math.max(1, Math.ceil(poidsTotalG / G_PAR_LB));
  if (!achatsPermis(regle)) raisons.push(R("REGLE_ESSAI", "règle des boîtes en mode essai : aucun achat"));
  for (const k of regle.poids_a_confirmer || []) if ((pieces[k] || contenu[k] || 0) > 0) notes.push(`poids ${k} à confirmer`);

  const dest = a ? { ville: a.city, province: a.provinceCode, code_postal: cpNorm(a.zip), pays: a.countryCodeV2 || null, type_lieu: a.company ? "entreprise" : "residence" } : null;
  const aSoumissionner = !!(dest && boite && !raisons.some(r => CODES_SANS_SOUMISSION.has(r.code)));
  return {
    no, id: c.id, cree_le: c.createdAt, segment: estB2B ? "B2B" : "B2C", b2b: !!estB2B, presentoirs, express,
    statut: raisons.length ? "SIGNALER" : "A_COMPARER", raisons, notes,
    destination: dest, contenu, pieces, nb_pinces: equiv,
    boite: boite ? { nom: boite.nom, nom_shopify: boite.nom_shopify || boite.nom, longueur_po: boite.longueur_po, largeur_po: boite.largeur_po, hauteur_po: boite.hauteur_po } : null,
    poids_g: poidsTotalG, poids_lb: lb, poids_kg: Math.round(lb * G_PAR_LB / 10) / 100,
    origine_cp: cpNorm(regle.origine.code_postal),
    colis,
    cle: dest && boite ? cle(regle.origine.code_postal, dest, colis.length > 1 ? { ...boite, nom: colis.map(c => `${c.boite}/${c.poids_lb}`).join("+") } : boite, lb) : null,
    a_soumissionner: aSoumissionner,
    // Seuls champs à taper dans le calculateur (une ligne, tronqués) — jamais le nom ni le téléphone
    a_saisir: aSoumissionner ? {
      adresse1: String(a.address1).replace(/\s+/g, " ").slice(0, 60), ville: String(a.city).slice(0, 40),
      province: a.provinceCode, code_postal: String(a.zip).toUpperCase().replace(/\s/g, "").replace(/^(...)(...)$/, "$1 $2"), pays: "CA",
    } : null,
  };
}

function plan(commandes, regle) {
  validerRegle(regle);
  const vus = new Set(), liste = [];
  for (const c of commandes) { const id = c.id || c.name; if (vus.has(id)) continue; vus.add(id); liste.push(planCommande(c, regle)); }
  liste.sort((x, y) => (Number(x.no) || 0) - (Number(y.no) || 0) || String(x.no).localeCompare(String(y.no)));
  return { genere_le: new Date().toISOString(), version_regle: regle.version, achats_permis: achatsPermis(regle), commandes: liste };
}

// ---------- Lecture du calculateur Shopify (le moteur lit le texte brut lui-même) ----------
// brut = innerText de la fenêtre « Calculateur de tarifs d'expédition » après le calcul.
function extraireShopify(brut, p) {
  const texte = String(brut || "").replace(/[  ]/g, " ");
  const erreurs = [];
  const sansEsp = texte.toUpperCase().replace(/\s/g, "");
  if (!p || !p.cle) return { tarifs: [], erreurs: ["commande absente du plan ou sans clé"] };
  if (!sansEsp.includes(p.destination.code_postal)) erreurs.push(`le texte lu ne contient pas le code postal ${p.destination.code_postal} (ancien résultat ?)`);
  if (!sansEsp.includes(p.origine_cp)) erreurs.push(`le texte lu ne contient pas l'origine ${p.origine_cp}`);
  const i = texte.indexOf("Tarifs réduits");
  if (i < 0) erreurs.push("section « Tarifs réduits » absente");
  if (erreurs.length) return { tarifs: [], erreurs };
  const lignes = texte.slice(i + "Tarifs réduits".length).split("\n").map(l => l.trim()).filter(Boolean)
    .filter(l => !/^exporter|cr[ée]er des [ée]tiquettes/i.test(l));
  const tarifs = [];
  let groupe = [];
  for (const l of lignes) {
    if (/^\d[\d ]*[.,]\d{2}\s*\$/.test(l) || /^\$\s*\d/.test(l)) {
      const service = groupe.find(g => !/jour|ouvrable|semaine|business day/i.test(g));
      const delai = groupe.find(g => /jour|ouvrable|semaine|business day/i.test(g)) || null;
      if (service) tarifs.push({ plateforme: "shopify", transporteur: service, service, prix: l, delai, taxes_incluses: false, origine_cp: p.origine_cp });
      else erreurs.push(`prix sans service : « ${l} »`);
      groupe = [];
    } else groupe.push(l);
  }
  if (!tarifs.length) erreurs.push("aucun tarif trouvé dans le texte");
  return { tarifs, erreurs };
}

// ---------- Décision ----------
function decision(planJson, tarifs, regle, maintenant = new Date()) {
  validerRegle(regle);
  const permis = new Set(regle.transporteurs_permis.map(transporteurCanonique).filter(t => LIMITES.TRANSPORTEURS.includes(t)));
  const validiteMs = Math.min(regle.validite_tarifs_heures, LIMITES.VALIDITE_MAX_H) * 3600e3;
  const achatOk = achatsPermis(regle) && planJson.achats_permis === true && planJson.version_regle === regle.version;
  const sortie = [];
  for (const p of planJson.commandes) {
    if (p.statut === "IGNORER") { sortie.push({ no: p.no, segment: p.segment || null, statut: "IGNORER", raisons: p.raisons }); continue; }
    const raisons = [...p.raisons], notes = [...(p.notes || [])];
    const valides = [];
    for (const t of tarifs.filter(t => String(t.no) === String(p.no))) {
      const montant = prix(t.prix);
      const transp = t.transporteur_code ? transporteurCanonique(t.transporteur_code) : transporteurCanonique(t.transporteur);
      const nom = `${t.plateforme} ${String(t.service || t.transporteur || "").slice(0, 40)}`;
      if (montant === null) { notes.push(`tarif illisible ignoré (${nom} « ${String(t.prix).slice(0, 30)} »)`); continue; }
      if (t.cle !== p.cle) { notes.push(`tarif ${nom} ignoré : relevé pour un autre colis`); continue; }
      if (t.taxes_incluses !== false) { notes.push(`tarif ${nom} ignoré : taxes incluses ou non précisées (comparer avant taxes)`); continue; }
      if (cpNorm(t.origine_cp) !== p.origine_cp) { notes.push(`tarif ${nom} ignoré : origine ${t.origine_cp || "absente"} ≠ ${p.origine_cp}`); continue; }
      if (!isoValide(t.releve_le, maintenant, validiteMs)) { notes.push(`tarif ${nom} ignoré : heure de relevé invalide, future ou trop vieille`); continue; }
      if (transp === "Inconnu") { notes.push(`transporteur non reconnu pour « ${nom} » : écarté`); continue; }
      if (!permis.has(transp)) continue; // Purolator, FedEx… : exclus exprès
      valides.push({ ...t, transporteur_canonique: transp, montant });
    }
    const pool = p.express ? valides.filter(v => joursDelai(v.delai) <= 2) : valides;
    if (p.express && valides.length && !pool.length) raisons.push(R("EXPRESS_INDISPONIBLE", "le client a payé un service rapide, mais aucun tarif de 2 jours ou moins"));
    const gagnant = meilleur(pool);
    const b2b = (p.segment || (p.b2b ? "B2B" : "B2C")) === "B2B";
    const seuil = b2b ? regle.seuil_signalement_dollars_b2b : regle.seuil_signalement_dollars;
    if (b2b && !seuil && p.a_soumissionner) raisons.push(R("SEUIL", "plafond d'achat B2B pas encore fixé dans la règle : à approuver"));
    else if (gagnant && gagnant.montant >= seuil) raisons.push(R("SEUIL", `meilleure étiquette à ${gagnant.montant.toFixed(2)} $ (seuil ${b2b ? "B2B " : ""}${seuil} $) : à approuver`));
    if (p.a_soumissionner) {
      const manquantes = regle.plateformes_requises.filter(pl => !valides.some(v => v.plateforme === pl));
      if (manquantes.length) raisons.push(R("INCOMPLET", "comparaison incomplète : aucun tarif valide de " + manquantes.join(" et ")));
      if (!gagnant) raisons.push(R("AUCUN_TARIF", "aucun tarif admissible"));
    }
    if (!achatOk && !raisons.some(r => r.code === "REGLE_ESSAI")) raisons.push(R("REGLE_ESSAI", "achats non permis par la règle : aucun achat"));
    const acheter = raisons.length === 0 && p.statut === "A_COMPARER" && p.a_soumissionner && achatOk && !!gagnant;
    sortie.push({
      no: p.no, id: p.id, segment: p.segment || (p.b2b ? "B2B" : "B2C"), statut: acheter ? "ACHETER" : "SIGNALER", raisons, notes,
      [acheter ? "gagnant" : "meilleur_indicatif"]: resume(gagnant),
      deuxieme: resume(meilleur(pool.filter(v => v !== gagnant))),
      boite: p.boite ? p.boite.nom : null, poids_lb: p.poids_lb, cle: p.cle,
      ville: p.destination ? p.destination.ville : null, code_postal: p.destination ? p.destination.code_postal : null,
      cle_idempotence: p.id ? "UP-" + String(p.id).split("/").pop() : null,
    });
  }
  const achats = sortie.filter(s => s.statut === "ACHETER");
  return {
    genere_le: maintenant.toISOString(), version_regle: planJson.version_regle, achats_permis: achatOk,
    sommaire: {
      a_acheter: achats.length,
      cout_prevu: Math.round(achats.reduce((s, x) => s + x.gagnant.montant, 0) * 100) / 100,
      par_plateforme: achats.reduce((o, x) => (o[x.gagnant.plateforme] = (o[x.gagnant.plateforme] || 0) + 1, o), {}),
      a_signaler: sortie.filter(s => s.statut === "SIGNALER").length,
      par_segment: ["B2C", "B2B"].reduce((o, seg) => { const l = sortie.filter(s => s.segment === seg); o[seg] = { commandes: l.length, cotees: l.filter(s => s.gagnant || s.meilleur_indicatif).length, a_la_main: l.filter(s => s.raisons.some(r => CODES_SANS_SOUMISSION.has(r.code))).length, cout_indicatif: Math.round(l.reduce((t, s) => t + ((s.gagnant || s.meilleur_indicatif || {}).montant || 0), 0) * 100) / 100 }; return o; }, {}),
      ignorees: sortie.filter(s => s.statut === "IGNORER").length,
    },
    commandes: sortie,
  };
}
function meilleur(liste) {
  if (!liste || !liste.length) return null;
  const ordre = { freightcom: 0, shopify: 1 };
  return [...liste].sort((a, b) => a.montant - b.montant || joursDelai(a.delai) - joursDelai(b.delai) || (ordre[a.plateforme] ?? 9) - (ordre[b.plateforme] ?? 9))[0];
}
// ---------- Freightcom (par la passerelle freightcom-proxy.onrender.com) ----------
// Corps de la demande de tarifs. Aucune donnée personnelle : ni nom, ni téléphone, ni courriel du client.
function demandeFreightcom(p, regle, dateIso) {
  if (!p || !p.a_soumissionner || !p.a_saisir || !p.boite) throw new Error("commande absente du plan ou non soumissionnable");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateIso))) throw new Error("date d'expédition invalide (AAAA-MM-JJ)");
  const o = regle.origine || {};
  if (!o.adresse || !o.ville || !o.province) throw new Error("origine incomplète dans la règle des boîtes");
  const [y, m, d] = dateIso.split("-").map(Number);
  return {
    details: {
      origin: { name: String(o.nom || "Unique Plastique inc.").slice(0, 60), residential: false,
        address: { address_line_1: o.adresse, city: o.ville, region: o.province, country: o.pays || "CA", postal_code: cpNorm(o.code_postal) } },
      destination: { name: "Client", residential: !(p.b2b || (p.destination && p.destination.type_lieu === "entreprise")),
        address: { address_line_1: p.a_saisir.adresse1, city: p.a_saisir.ville, region: p.a_saisir.province, country: "CA", postal_code: cpNorm(p.a_saisir.code_postal) } },
      expected_ship_date: { year: y, month: m, day: d },
      packaging_type: "package",
      packaging_properties: { packages: (p.colis && p.colis.length ? p.colis : [{ poids_lb: p.poids_lb, longueur_po: p.boite.longueur_po, largeur_po: p.boite.largeur_po, hauteur_po: p.boite.hauteur_po }]).map(c => ({ description: "Pinces a cheveux",
        measurements: { weight: { unit: "lb", value: c.poids_lb }, cuboid: { unit: "in", l: c.longueur_po, w: c.largeur_po, h: c.hauteur_po } } })) },
    },
  };
}
// Lecture de la réponse GET /rate/<id>. Montants en cents (schéma Money) ; on compare AVANT taxes (total − taxes).
function extraireFreightcom(rep, p) {
  const erreurs = [], tarifs = [];
  if (!p || !p.cle) return { tarifs, erreurs: ["commande absente du plan ou sans clé"] };
  if (!rep || !rep.status || rep.status.done !== true) return { tarifs, erreurs: ["réponse Freightcom incomplète (status.done n'est pas true)"] };
  for (const r of Array.isArray(rep.rates) ? rep.rates : []) {
    const t = r && r.total;
    if (!t || t.currency !== "CAD" || !/^\d+$/.test(String(t.value))) { erreurs.push(`tarif illisible (${r && r.service_id})`); continue; }
    let taxes = 0, ok = true;
    for (const x of Array.isArray(r.taxes) ? r.taxes : []) {
      const a = x && x.amount;
      if (!a || a.currency !== "CAD" || !/^\d+$/.test(String(a.value))) { ok = false; break; }
      taxes += Number(a.value);
    }
    if (!ok) { erreurs.push(`taxes illisibles (${r.service_id})`); continue; }
    const avantTaxes = (Number(t.value) - taxes) / 100;
    tarifs.push({
      plateforme: "freightcom", transporteur: String(r.carrier_name || ""), transporteur_code: String(r.carrier_name || ""),
      service: `${r.carrier_name || ""} ${r.service_name || ""}`.trim(), service_id: String(r.service_id || ""),
      prix: Math.round(avantTaxes * 100) / 100, total_taxes_incluses: Number(t.value) / 100,
      delai: r.transit_time_not_available ? null : (r.transit_time_days != null ? `${r.transit_time_days} jours` : null),
      taxes_incluses: false, origine_cp: p.origine_cp,
    });
  }
  if (!tarifs.length) erreurs.push("aucun tarif dans la réponse Freightcom");
  return { tarifs, erreurs };
}

function resume(t) {
  return t ? { plateforme: t.plateforme, transporteur: t.transporteur_canonique, service: String(t.service || t.transporteur).slice(0, 60), montant: t.montant, delai: t.delai || null, releve_le: t.releve_le, service_id: t.service_id || null, ref: t.ref || null } : null;
}

module.exports = { rentre, choisirBoite, repartir, grosFormat, LIMITES, prix, norm, cle, transporteurCanonique, classerLigne, planCommande, plan, extraireShopify, demandeFreightcom, extraireFreightcom, decision, validerRegle, G_PAR_LB };

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  const lire = f => JSON.parse(fs.readFileSync(f, "utf8"));
  try {
    if (cmd === "plan") {
      const brut = lire(args[0]);
      const commandes = Array.isArray(brut) ? brut : (brut.orders || brut.commandes || (brut.data && brut.data.orders && brut.data.orders.nodes) || []);
      console.log(JSON.stringify(plan(commandes, lire(args[1])), null, 2));
    } else if (cmd === "demande-freightcom") {
      const [fPlan, fRegle, no, dateIso] = args;
      const regle = lire(fRegle); validerRegle(regle);
      const p = lire(fPlan).commandes.find(x => String(x.no) === String(no).replace("#", ""));
      console.log(JSON.stringify(demandeFreightcom(p, regle, dateIso), null, 2));
    } else if (cmd === "ajouter-freightcom") {
      const [fPlan, fTarifs, no, fRep] = args;
      const p = lire(fPlan).commandes.find(x => String(x.no) === String(no).replace("#", ""));
      const { tarifs, erreurs } = extraireFreightcom(lire(fRep), p);
      const existants = fs.existsSync(fTarifs) ? lire(fTarifs) : [];
      const garde = existants.filter(t => !(String(t.no) === String(p && p.no) && t.plateforme === "freightcom"));
      const releve = new Date().toISOString();
      const ajout = tarifs.length ? tarifs.map(t => ({ no: p.no, cle: p.cle, ...t, releve_le: releve })) : [];
      fs.writeFileSync(fTarifs, JSON.stringify(garde.concat(ajout), null, 2));
      console.log(ajout.length ? `OK #${no} : ${ajout.length} tarifs Freightcom ajoutés` + (erreurs.length ? ` (${erreurs.length} écartés : ${erreurs.join(" ; ")})` : "") : `REFUSÉ #${no} : ${erreurs.join(" ; ")}`);
      if (!ajout.length) process.exit(3);
    } else if (cmd === "ajouter-shopify") {
      const [fPlan, fTarifs, no, fBrut] = args;
      const pl = lire(fPlan);
      const p = pl.commandes.find(x => String(x.no) === String(no).replace("#", ""));
      const { tarifs, erreurs } = extraireShopify(fs.readFileSync(fBrut, "utf8"), p);
      const existants = fs.existsSync(fTarifs) ? lire(fTarifs) : [];
      const garde = existants.filter(t => !(String(t.no) === String(p && p.no) && t.plateforme === "shopify"));
      const releve = new Date().toISOString();
      const ajout = erreurs.length ? [] : tarifs.map(t => ({ no: p.no, cle: p.cle, ...t, releve_le: releve }));
      fs.writeFileSync(fTarifs, JSON.stringify(garde.concat(ajout), null, 2));
      console.log(erreurs.length ? `REFUSÉ #${no} : ${erreurs.join(" ; ")}` : `OK #${no} : ${ajout.length} tarifs Shopify ajoutés`);
      if (erreurs.length) process.exit(3);
    } else if (cmd === "decision") {
      console.log(JSON.stringify(decision(lire(args[0]), lire(args[1]), lire(args[2])), null, 2));
    } else if (cmd === "prix") {
      console.log(prix(args[0]));
    } else { console.error("usage : node moteur.js plan|demande-freightcom|ajouter-freightcom|ajouter-shopify|decision|prix …"); process.exit(2); }
  } catch (e) { console.error("ERREUR : " + e.message); process.exit(1); }
}
