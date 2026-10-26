function __upProgramme() {
  "use strict";
  // Programme fixe de lecture du calculateur de tarifs Shopify (Unique Plastique, magasinage 1.1.0).
  // Il fait seulement : fermer/ouvrir la fenetre "Calculateur de tarifs d'expedition", choisir "Dimensions personnalisees",
  // poser l'adresse et choisir la suggestion qui porte le code postal attendu, placer le curseur dans un champ,
  // cliquer "Calculer les tarifs reduits", lire le resultat et calculer son empreinte SHA-256 (controle de recopie :
  // elle detecte un texte mal recopie, pas une session malveillante ; c'est la passerelle qui verifie le contenu).
  // Aucun autre clic n'existe ici. Tout echec lance une erreur : la suite (saisie au clavier) s'arrete.
  // Le fichier est en ASCII seulement, sans aucune sequence d'echappement unicode : il se recopie tel quel (un point remplace chaque lettre accentuee
  // dans les textes de Shopify cherches ici, ex. "Tarifs r.duits").
  const VERSION = "magasinage-1.1.0";
  const CHEMIN = "/store/tavdii-zp/settings/shipping";
  // Jamais clique, en francais comme en anglais (texte visible ET etiquette d'accessibilite).
  const INTERDIT = /cr.er (?:des|une|l.) ?.tiquettes?|achet|achat|paiement|payer|confirmer|exporter|supprimer|enregistrer|\b(?:create|buy|purchase|pay|confirm|export|delete|save)\b/i;
  // Memes caracteres que la passerelle : une adresse hors de cette liste est refusee.
  const ADRESSE = /^[\p{L}\p{N} .,'#\/-]{3,120}$/u;
  const T_REDUITS = /Tarifs r.duits/, T_PERSO = /^Dimensions personnalis.es$/, T_CALCULER = /^Calculer les tarifs r.duits$/;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const propre = (s) => String(s == null ? "" : s).normalize("NFC").replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").trim();
  const cpN = (s) => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const tous = (racine) => { const a = []; (function w(r) { for (const e of r.querySelectorAll("*")) { a.push(e); if (e.shadowRoot) w(e.shadowRoot); } })(racine); return a; };
  const hote = (e) => { let n = e; while (n && !(n instanceof ShadowRoot)) n = n.parentNode; return n ? (n.host.getAttribute("label") || "") : ""; };
  const fenetre = () => document.querySelector("[role=dialog]");
  const boutonHote = (racine, texte) => tous(racine).find((e) => /^S-.*BUTTON$/.test(e.tagName) && (typeof texte === "string" ? propre(e.textContent) === texte : texte.test(propre(e.textContent))));
  const echec = (code, detail) => { throw new Error(code + " : " + String(detail || "").slice(0, 160)); };
  let attendu = null;

  function cliquer(el, quoi) {
    if (!el) echec("PAGE_CHANGEE", "element absent (" + quoi + ")");
    const t = propre((el.getAttribute("aria-label") || "") + " " + (el.textContent || ""));
    // Une suggestion d'adresse qui contient un mot interdit : ce colis seulement est abandonne (Freightcom pour cette commande).
    if (INTERDIT.test(t)) { if (quoi === "suggestion") echec("ADRESSE_INTROUVABLE", "suggestion refusee"); echec("CLIC_INTERDIT", t.slice(0, 40)); }
    el.click();
  }
  function cliquerHote(h, quoi) {
    if (!h) echec("PAGE_CHANGEE", "bouton absent (" + quoi + ")");
    const t = propre((h.getAttribute("aria-label") || "") + " " + (h.textContent || ""));
    if (INTERDIT.test(t)) echec("CLIC_INTERDIT", t.slice(0, 40));
    const b = h.shadowRoot && h.shadowRoot.querySelector("button");
    if (!b) echec("PAGE_CHANGEE", "bouton illisible (" + quoi + ")");
    if (b.disabled) echec("SAISIE", "bouton desactive (" + quoi + ")");
    b.click();
  }
  function champ(nom) {
    const f = fenetre(); if (!f) return null;
    const ins = tous(f).filter((e) => e.tagName === "INPUT");
    if (nom === "adresse") return ins.find((e) => e.name === "toAddress[fullAddress]") || null;
    if (nom === "poids") return ins.find((e) => e.type === "number" && !hote(e)) || null;
    const lab = { L: "Longueur de l'emballage", l: "Largeur de l'emballage", H: "Hauteur de l'emballage" }[nom];
    return lab ? ins.find((e) => hote(e) === lab) || null : null;
  }
  function unite(lab) { const f = fenetre(); const s = f && tous(f).find((e) => e.tagName === "SELECT" && lab.test(hote(e))); return s ? s.value : ""; }
  async function attendre(test, ms) { const fin = Date.now() + ms; while (Date.now() < fin) { const v = test(); if (v) return v; await pause(200); } return null; }
  async function sha(t) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }

  function verifierPage() {
    if (location.hostname !== "admin.shopify.com" || location.pathname !== CHEMIN) echec("PAGE", "page inattendue : " + location.pathname.slice(0, 80));
    if (document.querySelector("input[type=password]") || /accounts\.shopify\.com/.test(location.href)) echec("SESSION_SHOPIFY", "page de connexion");
    if (!fenetre() && !boutonHote(document, "Calculer les tarifs")) echec("PAGE_CHANGEE", "bouton Calculer les tarifs absent");
    return { ok: true, version: VERSION };
  }

  async function preparer(p) {
    attendu = null;
    if (!p || !/^[a-f0-9]{24}$/.test(String(p.ticket || ""))) echec("PARAMETRES", "ticket");
    const cp = cpN(p.cp);
    if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(cp)) echec("PARAMETRES", "code postal");
    const adresse = propre(p.adresse);
    if (!ADRESSE.test(adresse)) echec("PARAMETRES", "adresse");
    const n = [p.L, p.l, p.H, p.lb].map(Number);
    if (!n.every((x) => Number.isFinite(x) && x > 0 && x <= 200)) echec("PARAMETRES", "dimensions ou poids");
    verifierPage();
    if (fenetre()) { cliquer([...fenetre().querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Fermer"), "fermer"); await attendre(() => !fenetre(), 3000); }
    cliquerHote(boutonHote(document, "Calculer les tarifs"), "ouvrir");
    const f = await attendre(fenetre, 6000);
    if (!f) echec("PAGE_CHANGEE", "la fenetre du calculateur ne s'ouvre pas");
    if (!(await attendre(() => champ("adresse"), 5000))) echec("PAGE_CHANGEE", "champ d'adresse absent");
    if (!champ("L")) {
      cliquer(await attendre(() => [...f.querySelectorAll("button")].find((b) => { const t = propre(b.innerText); return /\bpo,/.test(t) || /^Dimensions personnalis.es/.test(t); }), 5000), "emballage");
      cliquer(await attendre(() => [...document.querySelectorAll("li button")].find((b) => T_PERSO.test(propre(b.innerText))), 3000), "dimensions personnalisees");
      if (!(await attendre(() => champ("L"), 3000))) echec("PAGE_CHANGEE", "champs de dimensions absents");
    }
    const a = champ("adresse");
    if (!a) echec("PAGE_CHANGEE", "champ d'adresse absent");
    a.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(a, adresse);
    a.dispatchEvent(new Event("input", { bubbles: true }));
    const s = await attendre(() => tous(document).find((e) => e.getAttribute("role") === "option" && cpN(e.innerText).includes(cp)), 8000);
    if (!s) echec("ADRESSE_INTROUVABLE", "aucune suggestion avec le code postal attendu");
    cliquer(s, "suggestion");
    if (!(await attendre(() => { const x = champ("adresse"); return x && cpN(x.value).includes(cp); }, 3000))) echec("ADRESSE_INTROUVABLE", "suggestion non retenue");
    attendu = { ticket: String(p.ticket), cp, L: n[0], l: n[1], H: n[2], lb: n[3] };
    return focus("L");
  }

  function focus(nom) {
    if (!attendu) { if (document.activeElement) document.activeElement.blur(); echec("ORDRE", "preparer d'abord"); }
    const e = champ(nom);
    if (!e) { if (document.activeElement) document.activeElement.blur(); echec("PAGE_CHANGEE", "champ absent : " + nom); }
    e.focus(); e.select();
    return { ok: true, champ: nom, a_taper: String({ L: attendu.L, l: attendu.l, H: attendu.H, poids: attendu.lb }[nom]) };
  }

  async function calculer() {
    if (!attendu) echec("ORDRE", "preparer d'abord");
    const att = attendu; attendu = null;
    verifierPage();
    const f = fenetre(); if (!f) echec("PAGE_CHANGEE", "fenetre fermee");
    const lu = { L: Number(champ("L").value), l: Number(champ("l").value), H: Number(champ("H").value), lb: Number(champ("poids").value) };
    for (const k of ["L", "l", "H", "lb"]) if (lu[k] !== att[k]) echec("SAISIE", k + " lu " + lu[k] + ", attendu " + att[k]);
    const uE = unite(/^Unit. de l'emballage$/), uP = unite(/^Unit. de poids$/);
    if (uE !== "INCHES" || uP !== "POUNDS") echec("UNITES", uE + " / " + uP);
    if (!cpN(champ("adresse").value).includes(att.cp)) echec("ADRESSE", "adresse changee");
    const origine = [...f.querySelectorAll("button")].find((b) => /[A-Z]\d[A-Z] ?\d[A-Z]\d/i.test(b.innerText || ""));
    cliquerHote(boutonHote(f, T_CALCULER), "calculer");
    // \s couvre aussi les espaces insecables (U+00A0, U+202F) que Shopify met dans les prix.
    const premier = await attendre(() => { const t = f.innerText || ""; return T_REDUITS.test(t) && /\d,\d{2}\s\$\sCAD/.test(t) ? t : null; }, 25000);
    if (!premier) echec("AUCUN_TARIF", propre(f.innerText).slice(-160));
    // Shopify affiche les transporteurs au fur et a mesure : on lit seulement quand la liste n'a pas bouge pendant 2 s (10 s au plus).
    let brut = premier, stable = 0;
    const finStable = Date.now() + 10000;
    while (stable < 4 && Date.now() < finStable) { await pause(500); const t = f.innerText || ""; if (t === brut) stable++; else { stable = 0; brut = t; } }
    if (stable < 4) echec("AUCUN_TARIF", "liste des tarifs instable");
    if (!T_REDUITS.test(brut)) echec("AUCUN_TARIF", "tarifs disparus");
    const i = brut.search(T_REDUITS);
    const lignes = brut.slice(i).split("\n").map(propre).filter(Boolean).filter((l) => !/^exporter|cr.er des .tiquettes/i.test(l));
    const texte = ["PROGRAMME: " + VERSION, "TICKET: " + att.ticket,
      "ORIGINE: " + propre(origine ? origine.innerText : "").replace(/\s*\n\s*/g, " | "),
      "DESTINATION: " + propre(champ("adresse").value),
      "EMBALLAGE: " + [lu.L, lu.l, lu.H].join(" x ") + " INCHES", "POIDS: " + lu.lb + " POUNDS",
      "LU_LE: " + new Date().toISOString()].concat(lignes).join("\n");
    const programme = await sha(String(window.__upProgramme));
    return "EMPREINTE: " + (await sha(programme + "\n" + texte)) + "\nPROGRAMME_SHA: " + programme + "\n-----\n" + texte;
  }

  return { version: VERSION, verifierPage, preparer, focus, calculer };
}
