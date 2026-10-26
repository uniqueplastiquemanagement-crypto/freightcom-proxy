"use strict";
// Magasinage Shopify encadré — Unique Plastique inc. — 2026-10-26 (revu après la relecture indépendante du 26 oct.)
//
// La passerelle est la seule autorité. Une session Claude lit le calculateur de tarifs de Shopify dans le Chrome de l'usine,
// mais elle ne décide rien. Elle n'a que la clé de LECTURE (en-tête x-cle-magasinage), qui n'ouvre que ces routes :
//   POST /magasinage/demande {lecture: "A"|"B"} -> la passerelle relit les commandes ouvertes dans Shopify, calcule les boîtes
//        (moteur v5 + règle du dépôt) et donne, pour chaque colis à lire, un ticket unique (45 min, une seule fois).
//        Un seul passage à la fois (il n'y a qu'un Chrome) ; un colis déjà donné à lire n'est pas redonné.
//   POST /magasinage/lecture (texte brut)      -> le bloc produit par programme_magasinage.js. Accepté seulement si :
//        programme exact (empreinte du code), empreinte du texte juste, ticket valide, origine = règle, destination = commande,
//        dimensions et poids = boîte calculée, prix lisibles par le moteur, et l'ordre A puis B (10 min au moins entre les deux).
//        Les empreintes détectent une erreur de recopie, PAS une session malveillante (elle pourrait les recalculer) :
//        la vraie protection, ce sont les contrôles ci-dessus et les deux lectures par deux passages séparés.
//   POST /magasinage/echec {ticket, code}     -> une lecture impossible ; 2 échecs = la commande reste « à vérifier ».
//   POST /magasinage/signal {type, code, passage_id} -> Chrome injoignable, Shopify déconnecté, page changée, fin de passage.
//        Types et codes d'une liste fermée : aucun texte libre n'est gardé.
//   GET  /magasinage/etat                     -> résumé (sans adresse).
//   GET  /magasinage/programme                -> le programme à injecter dans la page, et son empreinte.
// Un prix Shopify ne sert (au clic « Acheter » du Poste) que si deux lectures séparées, A puis B, donnent exactement les mêmes
// services et les mêmes prix. Rien ici n'achète ni n'écrit dans Shopify.
// Le journal et l'état ne contiennent ni nom, ni adresse, ni téléphone, ni code postal en clair : numéros de commande, prix,
// et une empreinte à clé (HMAC) du code postal pour vérifier la destination.
// L'état vit en mémoire, avec une copie dans un fichier local. Sur le plan gratuit de Render, les deux sont perdus quand la
// passerelle s'endort (15 min sans appel) ou redémarre : les prix Shopify sont alors à relire, et le connecteur prend Freightcom.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const pathMod = require("path");
const B = require("./base");

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const SOURCE = fs.readFileSync(pathMod.join(__dirname, "programme_magasinage.js"), "utf8").replace(/\r\n/g, "\n").trimEnd();
const SHA_PROGRAMME = sha(SOURCE);
const VERSION_PROGRAMME = (SOURCE.match(/const VERSION = "([^"]+)"/) || [])[1] || "?";
const TICKET_MS = 45 * 60e3;
// La lecture B se fait au moins 10 min après la A (donc dans un autre passage). Réglable seulement pour les essais automatisés.
const ECART_AB_MS = process.env.MAGASINAGE_ESSAIS === "oui" ? Math.max(0, Number(process.env.MAGASINAGE_ECART_AB_MS || 0)) : 10 * 60e3;
const PASSAGE_MAX_MS = 60 * 60e3;         // un passage dure au plus 60 min : au-delà, un autre peut commencer
// Deux demandes à moins de 2 min d'intervalle : refusées (chaque demande relit toutes les commandes ouvertes dans Shopify).
const INTERVALLE_DEMANDE_MS = process.env.MAGASINAGE_ESSAIS === "oui" ? 0 : 2 * 60e3;
const MAX_COLIS = 60;                     // par demande
const MAX_ECHECS = 2;                     // par commande (mêmes boîtes)
const FICHIER = process.env.MAGASINAGE_FICHIER || pathMod.join(os.tmpdir(), "magasinage-up.json");
const RE_TICKET = /^[a-f0-9]{24}$/, RE_PASSAGE = /^[a-f0-9]{12}$/;
// Adresse donnée à la session, qui la recopie dans un appel JavaScript entre guillemets : jamais de guillemet, de barre oblique
// inverse, de parenthèse, d'accolade, de point-virgule ni de retour de ligne. Une adresse hors de cette liste n'est pas lue
// dans Shopify (Freightcom seul pour cette commande). L'apostrophe typographique devient une apostrophe simple.
const CARACTERES_ADRESSE = /^[\p{L}\p{N} .,'#\/-]{3,120}$/u;
const CODES = new Set(["PAGE", "SESSION_SHOPIFY", "PAGE_CHANGEE", "PARAMETRES", "ADRESSE_INTROUVABLE", "ORDRE", "SAISIE", "UNITES", "ADRESSE",
  "AUCUN_TARIF", "CLIC_INTERDIT", "CHROME_INJOIGNABLE", "AUTRE"]);
const RAISONS_PERMISES = new Set(["REGLE_ESSAI", "INCOMPLET", "SEUIL"]);   // comme le connecteur : le reste bloque l'achat, donc la lecture
const SIGNAUX = new Set(["DEBUT", "FIN", "CHROME_INJOIGNABLE", "SESSION_SHOPIFY", "PAGE_CHANGEE", "PROGRAMME", "AUTRE"]);
const CODES_SIGNAL = new Set(["ORIGINE", "ECHECS_DE_SUITE", "LIMITE_TEMPS", "RIEN_A_LIRE", "ABSENT", "MUET", "CONNEXION", "PAGE",
  "PROGRAMME_DIFFERENT", "PROGRAMME_INCOHERENT", "AUTRE"]);

const iso = (t = Date.now()) => new Date(t).toISOString();
const vide = () => Object.create(null);   // objets sans prototype : un ticket « __proto__ » ou « constructor » n'y trouve rien
const estObjet = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const dateOk = (x) => typeof x === "string" && Number.isFinite(Date.parse(x));
const validiteMs = () => Math.min((B.regleDepot && B.regleDepot.validite_tarifs_heures) || 3, 6) * 3600e3;
const fraiche = (x, t) => !!x && t - Date.parse(x.lu_le) < validiteMs();
class Refus extends Error { constructor(statut, code, message) { super(message); this.statut = statut; this.code = code; } }
const refus = (statut, code, message) => { throw new Refus(statut, code, message); };
// Empreintes à clé (HMAC) du code postal de destination et de la clé de plan : comparables, jamais lisibles. La clé de plan
// (empreinte courte, sans clé, de la destination, des boîtes et du poids) permettait de retrouver le code postal par essais.
const SEL = crypto.createHmac("sha256", process.env.PROXY_KEY || crypto.randomBytes(32)).update("magasinage-cp-v1").digest();
const hCp = (cp) => crypto.createHmac("sha256", SEL).update(B.cpNorm(cp)).digest("hex").slice(0, 32);
const hCle = (cle) => crypto.createHmac("sha256", SEL).update("cle:" + String(cle)).digest("hex").slice(0, 32);

// ---------- État (mémoire + fichier local ; voir plus haut pour le plan gratuit de Render) ----------
let S = { tickets: vide(), commandes: vide(), signaux: [], passages: [] };
const lectureValide = (x) => estObjet(x) && dateOk(x.lu_le) && Array.isArray(x.tarifs) && x.tarifs.every((t) => estObjet(t) && typeof t.service === "string" && typeof t.prix === "number");
function charger() {
  let j; try { if (!fs.existsSync(FICHIER)) return; j = JSON.parse(fs.readFileSync(FICHIER, "utf8")); } catch { return; }
  if (!estObjet(j)) return;
  const T = vide(), C = vide();
  for (const [k, v] of Object.entries(estObjet(j.tickets) ? j.tickets : {})) {
    if (RE_TICKET.test(k) && estObjet(v) && dateOk(v.emis) && typeof v.cpH === "string" && /^\d{3,7}$/.test(String(v.no)) && (v.lecture === "A" || v.lecture === "B")) T[k] = Object.assign(vide(), v);
  }
  for (const [k, v] of Object.entries(estObjet(j.commandes) ? j.commandes : {})) {
    if (!/^\d{3,7}$/.test(k) || !estObjet(v) || !Number.isInteger(v.colis) || v.colis < 1 || v.colis > 20 || typeof v.cle !== "string") continue;
    const c = Object.assign(vide(), v, { A: vide(), B: vide(), echecs: Number.isInteger(v.echecs) && v.echecs >= 0 ? v.echecs : 0, erreur: estObjet(v.erreur) ? v.erreur : null, maj: dateOk(v.maj) ? v.maj : iso() });
    for (const l of ["A", "B"]) for (const [i, x] of Object.entries(estObjet(v[l]) ? v[l] : {})) if (/^\d{1,2}$/.test(i) && Number(i) < v.colis && lectureValide(x)) c[l][i] = x;
    C[k] = c;
  }
  const liste = (x) => (Array.isArray(x) ? x.filter(estObjet).slice(-30) : []);
  S = { tickets: T, commandes: C, signaux: liste(j.signaux), passages: liste(j.passages) };
}
charger();
// Écrit d'un coup (fichier temporaire puis renommage) : un arrêt au milieu ne laisse jamais un fichier tronqué.
function sauver() { try { const tmp = FICHIER + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(S)); fs.renameSync(tmp, FICHIER); } catch { /* au mieux */ } }
function purger(t = Date.now()) {
  for (const [k, v] of Object.entries(S.tickets)) if (t - Date.parse(v.emis) > 3 * TICKET_MS) delete S.tickets[k];
  for (const [k, v] of Object.entries(S.commandes)) if (t - Date.parse(v.maj) > 48 * 3600e3) delete S.commandes[k];
  S.signaux = S.signaux.slice(-30); S.passages = S.passages.slice(-30);
}
const empreinteTarifs = (ts) => JSON.stringify(ts.map((t) => [t.service, t.prix, t.delai || ""]).sort());

function statut(c, t = Date.now()) {
  if (!c) return { code: "inconnue" };
  if (c.echecs >= MAX_ECHECS) return { code: "echec", detail: c.erreur ? c.erreur.code : null };
  for (let i = 0; i < c.colis; i++) {
    const a = c.A[i], b = c.B[i];
    if (!fraiche(a, t) || !fraiche(b, t) || Date.parse(b.lu_le) - Date.parse(a.lu_le) < ECART_AB_MS) return { code: "en_attente" };
  }
  for (let i = 0; i < c.colis; i++) if (empreinteTarifs(c.A[i].tarifs) !== empreinteTarifs(c.B[i].tarifs)) return { code: "desaccord" };
  return { code: "verifiee" };
}
// Un passage est ouvert pendant la préparation de sa liste, puis tant qu'il lui reste un ticket valide pas encore utilisé
// (au plus 60 min, et jusqu'à son signal FIN) : un passage qui a tout lu, ou qui s'est arrêté sans FIN, ne bloque pas le suivant.
const passageOuvert = (t) => S.passages.find((p) => !p.fin && t - Date.parse(p.debut) < PASSAGE_MAX_MS
  && (!p.pret || Object.values(S.tickets).some((k) => k.passage === p.id && !k.utilise && t - Date.parse(k.emis) <= TICKET_MS))) || null;
// Heure de référence d'une lecture A pour l'écart A-B : la plus tardive entre l'heure de la page et l'heure de réception.
const heureA = (a) => Math.max(Date.parse(a.lu_le), Date.parse(a.recu_le || a.lu_le));

// ---------- Demande : quoi lire ----------
async function demande(corps) {
  if (!B.M) refus(503, "MOTEUR", B.erreurMoteur);
  if (!B.regleDepot) refus(503, "REGLE", B.erreurRegle);
  if (!B.appShopify()) refus(503, "SHOPIFY", "app Shopify pas encore branchée sur la passerelle");
  const lecture = corps && corps.lecture;
  if (lecture !== "A" && lecture !== "B") refus(400, "PARAMETRES", "lecture : « A » ou « B »");
  const t = Date.now(); purger(t);
  const ouvert = passageOuvert(t);
  if (ouvert) refus(409, "PASSAGE_EN_COURS", `un passage ${ouvert.lecture} est déjà en cours (commencé ${ouvert.debut}) : un seul à la fois dans le Chrome de l'usine`);
  const dernier = S.passages[S.passages.length - 1];
  if (dernier && t - Date.parse(dernier.debut) < INTERVALLE_DEMANDE_MS) refus(429, "TROP_TOT", "une demande toutes les 2 minutes au plus");
  // Le passage est noté AVANT la lecture de Shopify : deux demandes simultanées ne peuvent pas ouvrir deux passages.
  const passageId = crypto.randomBytes(6).toString("hex");
  const passage = { id: passageId, lecture, debut: iso(t), commandes: 0, colis: 0, lues: 0, echecs: 0, ecartees: 0, pret: false, fin: null };
  S.passages.push(passage);
  let plan;
  try { plan = B.M.plan(await B.commandesOuvertes(), B.regleDepot); }
  catch (e) { passage.fin = iso(); sauver(); throw e; }
  const liste = []; let n = 0, ecartees = 0;
  for (const p of plan.commandes) {
    if (p.statut === "IGNORER" || !p.a_soumissionner || !p.cle || !p.a_saisir || !Array.isArray(p.colis) || !p.colis.length) continue;
    if ((p.raisons || []).some((x) => !RAISONS_PERMISES.has(x.code))) continue;   // mêmes refus que le connecteur (non payée, adresse, grandeur…)
    if (!p.destination || p.destination.pays !== "CA" || p.colis.length > 20) continue;
    const adresse = `${p.a_saisir.adresse1}, ${p.a_saisir.ville}, ${p.a_saisir.province}`.normalize("NFC").replace(/[’‘`´]/g, "'").replace(/\s+/g, " ").trim();
    const cpA = String(p.a_saisir.code_postal || "").toUpperCase().replace(/\s+/g, " ").trim();
    if (!CARACTERES_ADRESSE.test(adresse) || !/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/.test(cpA) || B.cpNorm(cpA) !== B.cpNorm(p.destination.code_postal)) { ecartees++; continue; }
    const cleH = hCle(p.cle);
    let c = S.commandes[p.no];
    if (!c || c.cle !== cleH) c = S.commandes[p.no] = Object.assign(vide(), { cle: cleH, colis: p.colis.length, A: vide(), B: vide(), echecs: 0, erreur: null, maj: iso(t) });
    if (c.echecs >= MAX_ECHECS || statut(c, t).code === "verifiee") continue;
    const tickets = Object.values(S.tickets);
    const dejaDonne = (i) => tickets.some((k) => k.no === p.no && k.cle === cleH && k.lecture === lecture && k.index === i && !k.utilise && t - Date.parse(k.emis) <= TICKET_MS);
    const aLire = p.colis.map((x, i) => i).filter((i) => {
      if (dejaDonne(i) || fraiche(c[lecture][i], t)) return false;
      if (lecture === "B") { const a = c.A[i]; if (!fraiche(a, t) || t - heureA(a) < ECART_AB_MS) return false; }
      return true;
    });
    if (!aLire.length) continue;
    if (n + aLire.length > MAX_COLIS) break;
    const cpH = hCp(p.destination.code_postal);
    const colis = aLire.map((i) => {
      const x = p.colis[i], ticket = crypto.randomBytes(12).toString("hex");
      S.tickets[ticket] = Object.assign(vide(), { no: p.no, cle: cleH, lecture, index: i, cpH, L: x.longueur_po, l: x.largeur_po, H: x.hauteur_po, lb: x.poids_lb, emis: iso(t), utilise: false, envois: 0, passage: passageId });
      return { index: i, ticket, L: x.longueur_po, l: x.largeur_po, H: x.hauteur_po, lb: x.poids_lb };
    });
    n += colis.length;
    liste.push({ no: p.no, segment: p.segment, adresse, cp: cpA, colis });
  }
  // Rien à lire : le passage est fermé tout de suite (il ne bloque pas le suivant).
  Object.assign(passage, { commandes: liste.length, colis: n, ecartees, pret: true, fin: liste.length ? null : iso() });
  sauver();
  console.log(`${iso()} MAGASINAGE demande ${lecture} : ${liste.length} commande(s), ${n} colis${ecartees ? `, ${ecartees} adresse(s) écartée(s)` : ""}`);
  return { passage_id: passage.id, lecture, programme: { version: VERSION_PROGRAMME, sha256: SHA_PROGRAMME },
    origine_attendue: B.regleDepot.origine.code_postal, regle: B.regleDepot.version, ticket_minutes: TICKET_MS / 60e3, adresses_ecartees: ecartees, commandes: liste };
}

// ---------- Lecture : un bloc produit par le programme ----------
function lecture(bloc) {
  const t = Date.now();
  const lignes = String(bloc || "").replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
  const m1 = /^EMPREINTE: ([a-f0-9]{64})$/.exec(lignes[0] || ""), m2 = /^PROGRAMME_SHA: ([a-f0-9]{64})$/.exec(lignes[1] || "");
  if (!m1 || !m2 || lignes[2] !== "-----") refus(400, "FORMAT", "le bloc doit commencer par EMPREINTE, PROGRAMME_SHA puis -----, exactement comme le programme l'a rendu");
  if (m2[1] !== SHA_PROGRAMME) { signal({ type: "PROGRAMME", code: "PROGRAMME_DIFFERENT" }); refus(422, "PROGRAMME", "le programme injecté n'est pas celui de la passerelle : recopier GET /magasinage/programme tel quel"); }
  const texte = lignes.slice(3).join("\n");
  if (sha(m2[1] + "\n" + texte) !== m1[1]) refus(422, "EMPREINTE", "empreinte fausse : le texte a été modifié ou mal recopié (le renvoyer tel que le programme l'a rendu)");
  const L = texte.split("\n");
  const ligne = (i, nom) => { if (!L[i] || !L[i].startsWith(nom + ": ")) refus(422, "FORMAT", `ligne ${nom} absente`); return L[i].slice(nom.length + 2); };
  const [ticket, origine, dest, emb, poids, luLe] = [ligne(1, "TICKET"), ligne(2, "ORIGINE"), ligne(3, "DESTINATION"), ligne(4, "EMBALLAGE"), ligne(5, "POIDS"), ligne(6, "LU_LE")];
  if (ligne(0, "PROGRAMME") !== VERSION_PROGRAMME) refus(422, "PROGRAMME", "version du programme inattendue");
  if (!RE_TICKET.test(ticket)) refus(400, "TICKET", "ticket illisible");
  const tk = S.tickets[ticket];
  if (!tk) refus(404, "TICKET", "ticket inconnu (ou effacé) : redemander la liste");
  if (tk.utilise) {
    // Même bloc renvoyé : même réponse qu'au premier envoi (un refus reste un refus), sans rien compter deux fois.
    if (tk.empreinte === m1[1] && tk.resultat) {
      if (tk.resultat.ok) return Object.assign({ deja: true }, tk.resultat);
      throw new Refus(tk.resultat.statut, tk.resultat.code, tk.resultat.message + " (lecture déjà refusée)");
    }
    refus(409, "TICKET", "ticket déjà utilisé");
  }
  if (t - Date.parse(tk.emis) > TICKET_MS) refus(410, "TICKET", "ticket expiré : redemander la liste");
  tk.envois = (tk.envois || 0) + 1;
  // À partir d'ici, tout refus consomme le ticket et compte comme un échec de la commande.
  const c = S.commandes[tk.no];
  // compteEchec = false : refus d'ordre (DEJA_LUE, ORDRE_AB), qui ne dit rien de la commande ; le ticket est quand même consommé.
  const rejet = (code, message, compteEchec = true) => {
    tk.utilise = true; tk.empreinte = m1[1]; tk.resultat = { ok: false, statut: 422, code, message };
    if (compteEchec && c && c.cle === tk.cle) { c.echecs++; c.erreur = { code, le: iso(t) }; c.maj = iso(t); }
    compter(tk, "echecs"); sauver(); refus(422, code, message);
  };
  const lu = Date.parse(luLe);
  if (!Number.isFinite(lu) || lu < Date.parse(tk.emis) - 60e3 || lu > t + 5 * 60e3) rejet("HEURE", "heure de lecture hors de la période du ticket");
  const origineCp = B.cpNorm(B.regleDepot.origine.code_postal);
  if (!B.cpNorm(origine).includes(origineCp)) {
    signal({ type: "AUTRE", code: "ORIGINE" });
    rejet("ORIGINE", `l'origine affichée par Shopify n'est pas ${B.regleDepot.origine.code_postal} : l'emplacement Shopify n'est pas à jour`);
  }
  const cpLu = (String(dest).toUpperCase().match(/[A-Z]\d[A-Z] ?\d[A-Z]\d/g) || []).map(B.cpNorm).find((x) => hCp(x) === tk.cpH);
  if (!cpLu) rejet("DESTINATION", "code postal de destination différent de la commande");
  const me = /^(\d+(?:\.\d+)?) x (\d+(?:\.\d+)?) x (\d+(?:\.\d+)?) INCHES$/.exec(emb);
  if (!me || Number(me[1]) !== tk.L || Number(me[2]) !== tk.l || Number(me[3]) !== tk.H) rejet("EMBALLAGE", `dimensions lues différentes de la boîte calculée (${tk.L} x ${tk.l} x ${tk.H} po)`);
  const mp = /^(\d+(?:\.\d+)?) POUNDS$/.exec(poids);
  if (!mp || Number(mp[1]) !== tk.lb) rejet("POIDS", `poids lu différent du poids calculé (${tk.lb} lb)`);
  if (!c || c.cle !== tk.cle) rejet("PLAN", "la commande a changé depuis la demande : redemander");
  // Ordre des lectures : une seule lecture valide par colis et par lettre ; B seulement après une A valide, 10 min plus tard au moins.
  const ici = c[tk.lecture];
  if (fraiche(ici[tk.index], t)) rejet("DEJA_LUE", `ce colis a déjà une lecture ${tk.lecture} valide`, false);
  if (tk.lecture === "B") {
    const a = c.A[tk.index];
    if (!fraiche(a, t)) rejet("ORDRE_AB", "pas de lecture A valide pour ce colis : la lecture B doit suivre une lecture A", false);
    if (lu - Date.parse(a.lu_le) < ECART_AB_MS || t - heureA(a) < ECART_AB_MS) rejet("ORDRE_AB", "lecture B trop proche de la lecture A (10 minutes au moins)", false);
  }
  const r = B.M.extraireShopify(texte, { cle: tk.cle, destination: { code_postal: cpLu }, origine_cp: origineCp });
  if (r.erreurs.length) rejet("TARIFS", r.erreurs.join(" ; ").slice(0, 160));
  const tarifs = r.tarifs.map((x) => ({ service: String(x.service).slice(0, 60), prix: B.M.prix(x.prix), delai: x.delai ? String(x.delai).slice(0, 40) : null }));
  if (!tarifs.length || tarifs.some((x) => x.prix === null)) rejet("TARIFS", "prix illisible");
  tk.utilise = true; tk.empreinte = m1[1];
  ici[tk.index] = { tarifs, lu_le: iso(lu), recu_le: iso(t), empreinte: m1[1] };
  if (tk.lecture === "A") delete c.B[tk.index];   // une lecture B doit toujours suivre la lecture A qu'elle confirme
  c.maj = iso(t); c.erreur = null;
  compter(tk, "lues");
  const st = statut(c, t).code;
  tk.resultat = { ok: true, no: tk.no, lecture: tk.lecture, colis: tk.index, nb_tarifs: tarifs.length, statut: st };
  sauver();
  console.log(`${iso()} MAGASINAGE lecture ${tk.lecture} #${tk.no} colis ${tk.index} : ${tarifs.length} tarifs (${st})`);
  return Object.assign({}, tk.resultat);
}
function compter(tk, champ) { const p = S.passages.find((x) => x.id === tk.passage); if (p) p[champ]++; }

// Lecture impossible (signalée par la session) : le ticket est consommé, la commande compte un échec.
function echec(corps) {
  const ticket = String((corps && corps.ticket) || "");
  if (!RE_TICKET.test(ticket)) refus(400, "TICKET", "ticket illisible");
  const tk = S.tickets[ticket];
  if (!tk) refus(404, "TICKET", "ticket inconnu");
  if (tk.utilise) refus(409, "TICKET", "ticket déjà utilisé");
  const code = CODES.has(corps.code) ? corps.code : "AUTRE";
  tk.utilise = true; tk.resultat = { ok: false, statut: 409, code: "ECHEC_SIGNALE", message: "lecture déclarée impossible (" + code + ")" };
  const c = S.commandes[tk.no];
  if (c && c.cle === tk.cle) { c.echecs++; c.erreur = { code, le: iso() }; c.maj = iso(); }
  compter(tk, "echecs"); sauver();
  return { ok: true, no: tk.no, echecs: c ? c.echecs : null, abandon: !!(c && c.echecs >= MAX_ECHECS) };
}

// Signal d'un passage : type et code d'une liste fermée. Un texte libre (detail) est ignoré : il pourrait contenir un nom ou une adresse.
function signal(corps) {
  const type = corps && SIGNAUX.has(corps.type) ? corps.type : "AUTRE";
  const code = corps && CODES_SIGNAL.has(corps.code) ? corps.code : null;
  const pid = corps && RE_PASSAGE.test(String(corps.passage_id || "")) ? String(corps.passage_id) : null;
  S.signaux.push({ type, code, le: iso() });
  if (type === "FIN" && pid) { const p = S.passages.find((x) => x.id === pid); if (p && !p.fin) p.fin = iso(); }
  purger(); sauver();
  return { ok: true };
}

// ---------- Pour le connecteur et le Poste ----------
// Tarifs Shopify utilisables par le moteur pour une commande, seulement s'ils sont contre-vérifiés et faits pour les mêmes boîtes.
function tarifsVerifies(no, cle, t = Date.now()) {
  const c = S.commandes[String(no)];
  if (!c) return { ok: false, raison: "prix Shopify pas encore lus" };
  if (c.cle !== hCle(cle)) return { ok: false, raison: "prix Shopify lus pour d'autres boîtes ou un autre poids" };
  const st = statut(c, t);
  if (st.code !== "verifiee") return { ok: false, raison: { en_attente: "prix Shopify pas encore contre-vérifiés", desaccord: "les deux lectures Shopify ne concordent pas : à vérifier", echec: `lecture Shopify impossible (${st.detail || "?"})` }[st.code] || st.code };
  let releve = Infinity, communs = null;
  const somme = new Map();
  for (let i = 0; i < c.colis; i++) {
    releve = Math.min(releve, Date.parse(c.A[i].lu_le), Date.parse(c.B[i].lu_le));
    const ici = new Set();
    for (const x of c.A[i].tarifs) {
      if (ici.has(x.service)) continue; ici.add(x.service);
      const s = somme.get(x.service) || { prix: 0, delai: null, jours: -1 };
      s.prix += x.prix;
      const j = Math.max(...(String(x.delai || "").match(/\d+/g) || ["99"]).map(Number));
      if (j > s.jours) { s.jours = j; s.delai = x.delai; }
      somme.set(x.service, s);
    }
    communs = communs ? new Set([...communs].filter((k) => ici.has(k))) : ici;
  }
  const origine = B.cpNorm(B.regleDepot.origine.code_postal);
  const tarifs = [...(communs || [])].map((k) => ({ no: String(no), cle, plateforme: "shopify", transporteur: k, service: k, prix: B.arrondi(somme.get(k).prix),
    delai: somme.get(k).delai, taxes_incluses: false, origine_cp: origine, releve_le: iso(releve) }));
  return tarifs.length ? { ok: true, tarifs, releve_le: iso(releve) } : { ok: false, raison: "aucun service Shopify commun à tous les colis" };
}
// Pour le Poste : statut par commande (le Poste donne ses propres clés de plan).
function etatCommandes(liste) {
  const permis = new Set(((B.regleDepot && B.regleDepot.transporteurs_permis) || []).map((x) => B.M.transporteurCanonique(x)));
  const out = {};
  for (const x of (Array.isArray(liste) ? liste : []).slice(0, 100)) {
    const no = String(x && x.no || ""), cle = String(x && x.cle || "");
    if (!/^\d{3,7}$/.test(no)) continue;
    const c = S.commandes[no];
    const st = c && c.cle === hCle(cle) ? statut(c).code : c ? "autres_boites" : "pas_lue";
    const v = st === "verifiee" ? tarifsVerifies(no, cle) : null;
    const meilleur = v && v.ok ? v.tarifs.filter((t) => permis.has(B.M.transporteurCanonique(t.service))).sort((a, b) => a.prix - b.prix)[0] || null : null;
    out[no] = { statut: st, meilleur: meilleur ? { service: meilleur.service, montant: meilleur.prix, delai: meilleur.delai } : null, lu_le: v && v.ok ? v.releve_le : null, erreur: c && c.erreur ? c.erreur.code : null };
  }
  return out;
}
function etat() {
  const t = Date.now();
  const compte = { verifiee: 0, desaccord: 0, en_attente: 0, echec: 0 };
  let derniere = null;
  for (const c of Object.values(S.commandes)) {
    const k = statut(c, t).code; if (k in compte) compte[k]++;
    for (const l of ["A", "B"]) for (const x of Object.values(c[l])) if (!derniere || x.lu_le > derniere) derniere = x.lu_le;
  }
  const ouvert = passageOuvert(t);
  return { programme: { version: VERSION_PROGRAMME, sha256: SHA_PROGRAMME }, regle: B.regleDepot ? B.regleDepot.version : null, erreur_regle: B.erreurRegle,
    origine_attendue: B.regleDepot ? B.regleDepot.origine.code_postal : null, validite_heures: validiteMs() / 3600e3, derniere_lecture: derniere,
    passage_en_cours: ouvert ? { lecture: ouvert.lecture, debut: ouvert.debut } : null, commandes: compte, passages: S.passages.slice(-4), signaux: S.signaux.slice(-6) };
}
function etatPublic() { const e = etat(); return { programme: e.programme.version, regle: e.regle, derniere_lecture: e.derniere_lecture, commandes: e.commandes }; }
const programme = () => ({ version: VERSION_PROGRAMME, sha256: SHA_PROGRAMME, source: SOURCE });

module.exports = { demande, lecture, echec, signal, etat, etatPublic, etatCommandes, tarifsVerifies, programme, Refus, SHA_PROGRAMME, _test: { S: () => S, statut, purger, hCp, hCle } };
