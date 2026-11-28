// Lecteur vidéo thaï. Lit le lexique du constructeur (même site, même navigateur) sans jamais l'écrire.
const $ = id => document.getElementById(id);
const THAI_RE = /[฀-๿]/;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
};
const raw = k => { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } };
let toastT;
function toast(m) { const t = $("toast"); t.textContent = m; t.style.display = "block"; clearTimeout(toastT); toastT = setTimeout(() => t.style.display = "none", 4000); }

// ---------- Lexique ----------
let lexicon = [], index = new Map(), builderCount = 0, extraCount = 0;
const normThai = s => String(s || "").replace(/ํา/g, "ำ").replace(/[​-‍﻿]/g, "").normalize("NFC");

// N'ouvre la base du constructeur que si elle existe : la créer vide casserait le constructeur.
function readBuilderLexicon() {
  return new Promise(res => {
    let r;
    try { r = indexedDB.open("thai_hub"); } catch (e) { return res([]); }
    r.onupgradeneeded = () => r.transaction.abort();
    r.onerror = e => { e.preventDefault(); res([]); };
    r.onsuccess = () => {
      const db = r.result;
      try {
        const q = db.transaction("kv", "readonly").objectStore("kv").get("lexicon");
        q.onsuccess = () => { db.close(); res(Array.isArray(q.result) ? q.result : []); };
        q.onerror = () => { db.close(); res([]); };
      } catch (e) { db.close(); res([]); }
    };
  });
}
// Base propre à ce lecteur, pour les fichiers chargés ici.
function ownDB(mode, fn) {
  return new Promise((res, rej) => {
    const r = indexedDB.open("thai_video", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const db = r.result, t = db.transaction("kv", mode), q = fn(t.objectStore("kv"));
      t.oncomplete = () => { db.close(); res(q.result); };
      t.onerror = () => { db.close(); rej(t.error); };
    };
  });
}
function mergeLists(...lists) {
  const m = new Map();
  lists.flat().forEach(w => {
    if (!w || !w.thai) return;
    const k = normThai(w.thai) + "\u0001" + w.cat, old = m.get(k);
    if (!old || (w.modifiedAt || 0) >= (old.modifiedAt || 0)) m.set(k, w);
  });
  return [...m.values()];
}
async function loadLexicon() {
  const builder = await readBuilderLexicon();
  let extra = [];
  try { extra = (await ownDB("readonly", s => s.get("extra"))) || []; } catch (e) {}
  builderCount = builder.length; extraCount = extra.length;
  lexicon = mergeLists(extra, builder);
  index = new Map();
  lexicon.forEach(w => { const k = normThai(w.thai); if (!index.has(k)) index.set(k, []); index.get(k).push(w); });
  $("lexstate").textContent = lexicon.length
    ? `📚 ${lexicon.length} entrées disponibles (constructeur : ${builderCount}${extraCount ? ", fichiers chargés ici : " + extraCount : ""})`
    : "📚 Aucun lexique trouvé sur cet appareil. Importe-le dans le constructeur, ou charge des fichiers ici.";
  cues.forEach(c => c.tokens = null);
  pruneUnknown(); renderSub(); renderList(); if (selected) showWord(selected.word, selected.context);
}
async function importLexFiles(files) {
  const found = [], bad = [];
  for (const f of files) {
    try {
      const d = JSON.parse((await f.text()).replace(/^﻿/, ""));
      const a = Array.isArray(d) ? d : d.lexique;
      if (!Array.isArray(a)) throw 0;
      found.push(...a.filter(x => x && x.thai && x.cat));
    } catch (e) { bad.push(f.name); }
  }
  if (found.length) {
    try {
      const old = (await ownDB("readonly", s => s.get("extra"))) || [];
      await ownDB("readwrite", s => s.put(mergeLists(old, found), "extra"));
    } catch (e) { toast("Ce navigateur n'a pas pu enregistrer les fichiers."); return; }
  }
  await loadLexicon();
  toast(`${found.length} entrée(s) lue(s)` + (bad.length ? ". Non reconnu(s) : " + bad.join(", ") : "."));
}

// ---------- Découpage (même principe que le lecteur du constructeur) ----------
function segmentThai(text) {
  if (window.Intl && Intl.Segmenter) return [...new Intl.Segmenter("th", { granularity: "word" }).segment(text)].map(s => ({ t: s.segment, w: !!s.isWordLike }));
  return text.split(/([฀-๿]+)/).filter(Boolean).map(t => ({ t, w: THAI_RE.test(t) }));
}
function analyze(text) {
  const segs = segmentThai(normThai(text)), out = [];
  for (let i = 0; i < segs.length;) {
    const s = segs[i];
    if (!s.w || !THAI_RE.test(s.t)) { out.push({ t: s.t, plain: true }); i++; continue; }
    let done = false;
    for (let n = Math.min(8, segs.length - i); n >= 1 && !done; n--) {
      const part = segs.slice(i, i + n);
      if (!part.every(q => q.w && THAI_RE.test(q.t))) continue;
      const cand = part.map(q => q.t).join("");
      if (index.has(cand)) { out.push({ t: cand, entries: index.get(cand) }); i += n; done = true; }
    }
    if (!done) { out.push({ t: s.t, entries: null }); i++; }
  }
  return out;
}
const tokensOf = c => c.tokens || (c.tokens = analyze(c.text));
// Sens courts : mêmes règles que le constructeur.
const GLOSS_LABEL = /^(?:Adjectif|Adverbe|Nom|Verbe|Pronom|Particule|Classificateur|Connecteur|Expression|Préposition|Conjonction|Marqueur|Quantificateur|Démonstratif|Négation)\b[^:]{0,40}:\s*/i;
function glossItems(txt) {
  let s = String(txt || "").trim().replace(/^\d+\)\s*/, "").replace(GLOSS_LABEL, "");
  const cut = s.search(/\.(\s|$)|\s:\s|\sExemples?\s?:|\sEx\s?:|\s—\s|\sLittéralement|\sLittéral/);
  if (cut > 0) s = s.slice(0, cut);
  const noPar = s.replace(/\s*\([^)]*\)/g, "").trim();
  if (noPar) s = noPar;
  return s.split(/\s*[,;\/]\s*/).map(x => x.trim()).filter(Boolean);
}

function glossList(w) {
  if (!w) return [""];
  if (w.court && String(w.court).trim()) {
    return String(w.court).split(/\s*\/\s*|\s*;\s*/).map(x => x.trim()).filter(Boolean).slice(0, 5);
  }
  const full = String(w.sens || "").trim();
  let items;
  if (/^\s*1\)/.test(full)) {
    // sens numérotés (1) … 2) …) : tous les sens du premier, puis le premier de chacun des suivants
    const parts = full.split(/\s*\b\d+\)\s+/).filter(x => x.trim());
    const first = glossItems(parts[0]);
    const others = parts.slice(1).map(p => glossItems(p)[0]).filter(Boolean);
    items = first.slice(0, Math.max(1, 4 - others.length)).concat(others);
  } else {
    items = glossItems(full);
  }
  if (items.length === 0) items = [full];
  return items.slice(0, 4).map(p => p.length > 40 ? p.slice(0, 40).replace(/\s+\S*$/, "") + "…" : p);
}
// Sous les sous-titres, un seul sens ; dans la fiche, trois au maximum.
// Les parenthèses sont retirées d'abord : un « : » à l'intérieur coupait le sens en plein milieu.
const glosses = e => glossList(Object.assign({}, e, { sens: String(e.sens || "").replace(/\s*\([^()]*\)/g, "") }));
function shortSense(e) {
  const g = glosses(e)[0] || "";
  return g.length > 32 ? g.slice(0, 32) + "…" : g;
}
function entryHTML(e, color) {
  const short = glosses(e).slice(0, 3).join(" / ");
  const more = [e.sens && e.sens.trim() !== short ? `<div>${esc(e.sens)}</div>` : "", e.note ? `<div><em>${esc(e.note)}</em></div>` : ""].filter(Boolean).join("");
  const head = `<span class="badge" style="background:${esc(color || "#475569")}">${esc(e.cat)}</span><b>${esc(e.rom)}</b> : ${esc(short)}`;
  return more ? `<div class="entry"><details><summary>${head} <span class="muted">▾ détail</span></summary><div class="more">${more}</div></details></div>` : `<div class="entry">${head}</div>`;
}

// ---------- Sous-titres ----------
const toSec = s => s.replace(",", ".").split(":").reduce((a, x) => a * 60 + parseFloat(x), 0);
function parseSubs(text) {
  const lines = String(text).replace(/\r/g, "").split("\n").map(l => l.trim());
  let out = [];
  if (lines.some(l => l.includes("-->"))) {
    let cur = null;
    for (const l of lines) {
      const m = l.match(/^((?:\d+:)?\d+:\d+(?:[.,]\d+)?)\s*-->\s*((?:\d+:)?\d+:\d+(?:[.,]\d+)?)/);
      if (m) { cur = { start: toSec(m[1]), end: toSec(m[2]), text: "" }; out.push(cur); }
      else if (!l) cur = null;
      else if (cur) cur.text += (cur.text ? " " : "") + l.replace(/<[^>]*>/g, "");
    }
  } else {
    // Transcription copiée depuis YouTube : le temps puis le texte, sur une ou deux lignes.
    const unit = "(?:heures?|minutes?|secondes?|hours?|minutes?|seconds?|ชั่วโมง|นาที|วินาที)";
    const spoken = new RegExp(`^(?:\\d+\\s*${unit}(?:\\s*(?:et|and|,)?\\s*)?)+`, "i");
    let cur = null;
    for (const l of lines) {
      const m = l.match(/^((?:\d{1,2}:)?\d{1,2}:\d{2})\s*(.*)$/);
      let rest = l;
      if (m) { cur = { start: toSec(m[1]), end: null, text: "" }; out.push(cur); rest = m[2]; }
      rest = rest.replace(spoken, "").trim();
      if (cur && rest && THAI_RE.test(rest)) cur.text += (cur.text ? " " : "") + rest;
    }
  }
  out = out.filter(c => c.text && THAI_RE.test(c.text)).sort((a, b) => a.start - b.start);
  out.forEach((c, i) => {
    const n = out[i + 1];
    if (c.end === null) c.end = n ? n.start : c.start + 6;
    else if (n && n.start > c.start && n.start < c.end) c.end = n.start;
  });
  return out;
}

// ---------- État et affichage ----------
let cues = [], cur = -1, videoId = "", offset = 0, tab = "t", selected = null;
let tr = {}, summary = "", title = "", renamed = false, appliedSubs = "";
const opts = Object.assign({ rom: false, sens: false, blur: false, fr: true, autopause: false, loop: false }, store.get("thai_video_opts", {}));
let unknown = store.get("thai_video_unknown", {}), ignored = new Set(store.get("thai_video_ignored", []));

function wordsHTML(c, ci) {
  return tokensOf(c).map((t, i) => {
    if (t.plain) return esc(t.t);
    const e = t.entries && t.entries[0];
    const cls = e || ignored.has(t.t) ? "" : " unk";
    const sel = selected && selected.word === t.t ? " sel" : "";
    return `<span class="w${cls}${sel}" data-c="${ci}" data-i="${i}">${esc(t.t)}<small class="r">${e ? esc(e.rom) : ""}</small><small class="s">${e ? esc(shortSense(e)) : ""}</small></span>`;
  }).join("");
}
// ---------- Traduction (copier-coller avec Claude) ----------
const BATCH = 60;
const cueKey = c => c.start + "|" + c.text;
// Empreinte des sous-titres : évite d'importer la réponse d'une autre vidéo.
function trCode() {
  let h = 0x811c9dc5;
  for (const ch of videoId + cues.map(cueKey).join("\n")) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h.toString(36);
}
const missing = () => cues.map((c, i) => i).filter(i => !tr[cueKey(cues[i])]);
function trHTML(c) {
  const t = c && tr[cueKey(c)];
  if (!opts.fr || !t) return "";
  return `<span class="fr">${esc(t.fr)}</span>${t.doute ? `<span class="doubt">⚠️ ${esc(t.doute)}</span>` : ""}`;
}
function renderTrState() {
  $("trbox").hidden = tab !== "t" || !cues.length;
  const left = missing().length, done = cues.length - left;
  $("trcopy").hidden = !left;
  $("trcopy").textContent = left > BATCH || done ? `🌐 Copier la demande (${Math.min(BATCH, left)} phrases)` : "🌐 Copier la demande de traduction";
  $("trstate").textContent = !cues.length ? "" : !left ? `✅ Les ${cues.length} lignes sont traduites.` : `${done} ligne(s) traduite(s) sur ${cues.length}.`;
}
function translatePrompt() {
  const ids = missing().slice(0, BATCH);
  const before = cues.slice(Math.max(0, ids[0] - 3), ids[0]).map(c => c.text).join("\n");
  const p = raw("thai_profile_text_v1");
  return `${p.trim() ? p : DEFAULT_PROFILE}

DEMANDE : traduis en français ces sous-titres d'une vidéo YouTube thaïe.
${summary ? `\nRésumé des passages déjà traduits : ${summary}\n` : ""}${before ? `\nLignes précédentes, pour le contexte (ne pas les traduire) :\n${before}\n` : ""}
Lignes à traduire :
${ids.map(i => `${i + 1}. ${cues[i].text}`).join("\n")}

Réponds UNIQUEMENT avec un objet JSON dans un bloc de code (rien après) :
{"code": "${trCode()}", "resume": "...", "phrases": [{"n": ${ids[0] + 1}, "fr": "...", "doute": ""}]}
- resume : le sens général de la vidéo en 2 à 4 phrases${summary ? ", en complétant le résumé précédent" : ""}.
- phrases : une entrée pour chaque ligne numérotée, avec le même numéro n.
- fr : français naturel. Une phrase peut être coupée entre plusieurs lignes : comprends-la en entier, puis donne à chaque ligne la partie qui lui correspond.
- doute : vide en général. Si la ligne semble mal transcrite ou ambiguë, explique-le brièvement au lieu d'inventer un sens.`;
}
function importTranslation(text) {
  let d;
  try { d = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch (e) { d = null; }
  if (!d || !Array.isArray(d.phrases)) return toast("Réponse non reconnue. Copie tout le bloc de code de la réponse, ou demande-la à nouveau si elle est incomplète.");
  if (d.code !== trCode()) return toast("Cette réponse correspond à une autre vidéo ou à d'autres sous-titres.");
  let n = 0;
  d.phrases.forEach(x => { const c = x && cues[x.n - 1]; if (c && typeof x.fr === "string" && x.fr.trim()) { tr[cueKey(c)] = { fr: x.fr.trim(), doute: String(x.doute || "").trim() }; n++; } });
  if (!n) return toast("Aucune phrase traduite dans cette réponse.");
  if (typeof d.resume === "string" && d.resume.trim()) summary = d.resume.trim();
  opts.fr = true; store.set("thai_video_opts", opts);
  $("transwer").value = ""; $("trmanual").hidden = true;
  toast(`${n} ligne(s) traduite(s).` + (missing().length ? ` Il en reste ${missing().length}.` : ""));
  saveVideo(); toggleBtns(); renderSub(); renderList(); $("list").scrollTop = 0;
}
function explainPrompt() {
  const c = cues[cur], p = raw("thai_profile_text_v1");
  const around = cues.slice(Math.max(0, cur - 2), cur + 3).map(x => x.text).join("\n");
  return `${p.trim() ? p : DEFAULT_PROFILE}

DEMANDE : explique-moi cette ligne d'une vidéo YouTube thaïe.
Ligne : ${c.text}

Contexte (lignes autour) :
${around}

Réponds en trois parties courtes :
1. Sens naturel en français.
2. Mot à mot avec romanisation.
3. La structure grammaticale et ce qui est difficile. Signale une éventuelle erreur de sous-titrage.`;
}

function renderSub() {
  const el = $("sub");
  el.className = (opts.rom ? "show-rom " : "") + (opts.sens ? "show-sens " : "") + (opts.blur ? "hidden-th" : "");
  if (!cues.length) el.innerHTML = '<span class="muted">Ajoute les sous-titres thaïs ci-dessous.</span>';
  else el.innerHTML = cur >= 0 ? wordsHTML(cues[cur], cur) : '<span class="muted">▶ Lance la vidéo ou choisis une phrase.</span>';
  $("trans").innerHTML = cur >= 0 ? trHTML(cues[cur]) : "";
}
function renderList() {
  $("nunk").textContent = Object.keys(unknown).length;
  $("tab-t").className = tab === "t" ? "on" : "sec"; $("tab-u").className = tab === "u" ? "on" : "sec";
  const el = $("list");
  renderTrState();
  if (tab === "t") {
    el.innerHTML = cues.length ? (summary && opts.fr ? `<div id="summary"><b>Sens général</b><br>${esc(summary)}</div>` : "") + cues.map((c, i) => {
      const s = Math.floor(c.start);
      return `<div class="cue${i === cur ? " cur" : ""}" data-cue="${i}"><time>${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}</time><div><span lang="th">${esc(c.text)}</span>${trHTML(c)}</div></div>`;
    }).join("") : '<p class="muted">La transcription apparaîtra ici.</p>';
    return;
  }
  const words = Object.keys(unknown);
  el.innerHTML = words.length ? `<div class="row" style="margin-bottom:6px"><button class="claude" data-act="copy">🤖 Copier la demande pour Claude (${Math.min(25, words.length)})</button><button class="sec" data-act="clear">Vider</button></div>
    <p class="muted">Colle la réponse dans le constructeur (« Coller la réponse de Claude et importer »), exporte ton lexique, puis reviens ici.</p>` +
    words.map(w => `<div class="unkrow"><div><span lang="th" style="font-size:20px">${esc(w)}</span><br><span class="muted">${esc(unknown[w])}</span></div><button class="sec" data-del="${esc(w)}" aria-label="Retirer">✕</button></div>`).join("")
    : '<p class="muted">Clique sur un mot souligné en rouge, puis ajoute-le à cette liste.</p>';
}
function saveUnknown() { if (!store.set("thai_video_unknown", unknown)) toast("Mémoire du navigateur pleine : la liste ne sera pas gardée."); }
function pruneUnknown() { Object.keys(unknown).forEach(w => { if (index.has(w)) delete unknown[w]; }); saveUnknown(); }

function showWord(word, context) {
  selected = { word, context };
  const es = index.get(word), colors = (store.get("thai_grammar_config_v1", {}) || {}).CAT_COLORS || {};
  let h = `<div class="big" lang="th">${esc(word)}</div><div class="row"><button data-act="say">🔊 Écouter</button><button class="sec" data-act="slow">🐢 Lentement</button></div>`;
  if (es) h += es.map(e => entryHTML(e, colors[e.cat])).join("");
  else h += `<div class="entry"><p class="muted">Pas dans ton lexique, ou mal découpé. Tu peux corriger le mot avant de l'ajouter.</p>
      <div class="row" style="margin-top:8px"><input id="fix" lang="th" value="${esc(word)}" style="flex:1;min-width:140px;font-size:20px"><button data-act="add">➕ Ajouter à la liste</button><button class="sec" data-act="ignore">Ignorer (nom propre)</button></div></div>`;
  $("detail").innerHTML = h;
}

// Même demande que celle du constructeur, pour que la réponse s'y importe telle quelle.
const DEFAULT_PROFILE = `FICHE D'APPRENTISSAGE
- Francophone, apprend le thaï.
- Réponds en français, en tutoyant, de façon concise, avec des exemples.
- Tout ce que tu proposes est « proposé » : seul mon prof valide.
- Catégories de mon outil : Sujet, Négation, Marqueur, Temps, Connecteur, Verbe (Transitif), Verbe (Intransitif), Nom, Adjectif, Adverbe, Particule, Particule finale, Classificateur, Quantificateur, Démonstratif.`;
function buildPrompt(words) {
  const p = raw("thai_profile_text_v1");
  const list = words.map(w => `${w} : pas encore dans mon lexique\n   contexte lu : « ${unknown[w]} »`).join("\n");
  return `${p.trim() ? p : DEFAULT_PROFILE}

DEMANDE : prépare l'entrée de lexique pour ${words.length > 1 ? "ces mots" : "ce mot"} :
${list}

Réponds UNIQUEMENT avec un tableau JSON dans un bloc de code (rien après), un objet par mot, au format enrichi :
[{"thai": "...", "rom": "...", "sens": "...", "court": "...", "cat": "...", "theme": "...", "type": "mot", "note": "...", "modifiedAt": ${Date.now()}}]
- sens : développé (décomposition ou étymologie, nuances, exemple d'usage dans la phrase, registre).
- court : le sens à afficher dans mes phrases, 1 à 3 sens séparés par « / ».
- cat : une des catégories de mon outil (liste ci-dessus).
- Les sous-titres peuvent contenir des erreurs : si un mot paraît mal transcrit ou mal découpé, signale-le dans "note".`;
}
function copyText(text, ok) {
  const fallback = () => {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    const done = document.execCommand("copy"); ta.remove();
    done ? toast(ok) : prompt("Copie impossible automatiquement. Copie ce texte :", text);
  };
  navigator.clipboard ? navigator.clipboard.writeText(text).then(() => toast(ok), fallback) : fallback();
}

// ---------- Voix : fichiers audio_thai du constructeur, puis voix de l'appareil, puis Google ----------
// Fonctionne que le dossier soit publié en « video/ » ou en « video-thai/video/ ».
const AUDIO_DIR = new URL(location.pathname.replace(/(video-thai\/)?video\/[^\/]*$/, "constructeur/audio_thai/"), location.href).href;
let voiceAudio = null, voices = [], voiceToken = 0;
const loadVoices = () => voices = window.speechSynthesis ? speechSynthesis.getVoices().filter(v => /^th([-_]|$)/i.test(v.lang)) : [];
if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
async function say(text, slow) {
  const my = ++voiceToken;
  if (voiceAudio) voiceAudio.pause();
  if (window.speechSynthesis) speechSynthesis.cancel();
  if (ready) player.pauseVideo();
  const prefs = Object.assign({ voice: "", rate: 0.85 }, store.get("thai_tts_v1", {}));
  const name = encodeURIComponent(text.replace(/[\\/*?:"<>|]/g, "").trim().slice(0, 100));
  for (const ext of ["mp3", "wav"]) {
    const url = AUDIO_DIR + name + "." + ext;
    let ok = false;
    try { ok = (await fetch(url, { method: "HEAD" })).ok; } catch (e) {}
    if (my !== voiceToken) return;
    if (ok) { voiceAudio = new Audio(url); voiceAudio.playbackRate = slow ? 0.7 : 1; voiceAudio.play().catch(() => toast("Lecture bloquée : touche à nouveau le bouton.")); return; }
  }
  const rate = slow ? Math.min(0.6, prefs.rate) : prefs.rate;
  if (voices.length || /android/i.test(navigator.userAgent)) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "th-TH"; u.rate = rate;
    const v = voices.find(x => x.name === prefs.voice) || voices.find(x => x.localService) || voices[0];
    if (v) u.voice = v;
    speechSynthesis.speak(u); return;
  }
  voiceAudio = new Audio("https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=th&ttsspeed=" + (slow ? "0.3" : "1") + "&q=" + encodeURIComponent(text.slice(0, 190)));
  voiceAudio.play().catch(() => toast("Aucune voix thaï disponible sur cet appareil."));
}

// ---------- Lecteur YouTube ----------
let player = null, ready = false, stopAt = null;
function parseId(u) {
  u = u.trim();
  const m = u.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : /^[\w-]{11}$/.test(u) ? u : "";
}
function youTubeAPI() {
  return new Promise((res, rej) => {
    if (window.YT && YT.Player) return res();
    window.onYouTubeIframeAPIReady = res;
    const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; s.onerror = () => { s.remove(); rej(); };
    document.head.appendChild(s);
  });
}
// ---------- Bibliothèque : une fiche par vidéo dans la base propre à ce lecteur ----------
const vKey = id => "video:" + id;
const getVideo = id => ownDB("readonly", s => s.get(vKey(id)));
const putVideo = v => ownDB("readwrite", s => s.put(v, vKey(v.id)));
const allVideos = () => ownDB("readonly", s => s.getAll(IDBKeyRange.bound("video:", "video:\uffff")));
function saveVideo() {
  if (!videoId || !cues.length) return;
  const rec = { id: videoId, title, renamed, subs: appliedSubs, offset, tr, summary, total: cues.length, done: cues.length - missing().length, updated: Date.now() };
  store.set("thai_video_last", videoId);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  return putVideo(rec).catch(() => toast("Enregistrement impossible : ce navigateur refuse le stockage (navigation privée ou disque plein ?)."));
}
// Reprend les vidéos enregistrées par la version précédente ; l'ancienne copie n'est effacée qu'après écriture.
async function migrate() {
  let keys = [];
  try { keys = Object.keys(localStorage).filter(k => k.startsWith("thai_video_v_")); } catch (e) {}
  for (const k of keys) {
    const id = k.slice("thai_video_v_".length), old = store.get(k, null);
    try {
      if (old && old.subs && !(await getVideo(id))) {
        const list = parseSubs(old.subs), t = old.tr || {};
        await putVideo({ id, title: "", renamed: false, subs: old.subs, offset: old.offset || 0, tr: t, summary: old.summary || "", total: list.length, done: list.filter(c => t[cueKey(c)]).length, updated: Date.now() });
      }
      localStorage.removeItem(k);
    } catch (e) {}
  }
}
// YouTube ne donne le titre qu'une fois la vidéo prête.
function fetchTitle() {
  if (!ready || title || !player.getVideoData) return;
  const d = player.getVideoData();
  if (d && d.video_id === videoId && d.title) { title = d.title; saveVideo(); }
}
let loadToken = 0;
async function loadVideo(id) {
  const my = ++loadToken;
  let saved = null;
  try { saved = await getVideo(id); } catch (e) { toast("La bibliothèque est illisible dans ce navigateur."); }
  if (my !== loadToken) return;
  // Sous-titres collés avant d'avoir chargé une vidéo : on les garde pour elle.
  const keep = !saved && !videoId && cues.length;
  videoId = id; stopAt = null;
  title = (saved && saved.title) || ""; renamed = !!(saved && saved.renamed);
  if (!keep) {
    $("subs").value = saved ? saved.subs : ""; offset = saved ? saved.offset : 0;
    tr = (saved && saved.tr) || {}; summary = (saved && saved.summary) || "";
  }
  $("transwer").value = ""; $("trmanual").hidden = true;
  applySubs(false); store.set("thai_video_last", id);
  if (keep) saveVideo();
  try { await youTubeAPI(); } catch (e) { toast("YouTube est inaccessible. Vérifie la connexion."); return; }
  if (player) { player.cueVideoById(id); return; }
  $("player-box").innerHTML = '<div id="yt"></div>';
  player = new YT.Player("yt", {
    videoId: id, playerVars: { playsinline: 1, rel: 0, cc_load_policy: 0 },
    events: {
      onReady: () => { ready = true; player.setPlaybackRate(+$("speed").value); },
      onError: e => toast("YouTube ne peut pas lire cette vidéo ici (code " + e.data + ").")
    }
  });
}
function applySubs(announce) {
  appliedSubs = $("subs").value;
  cues = parseSubs(appliedSubs); cur = -1; stopAt = null;
  $("offset").textContent = offset.toLocaleString("fr") + " s";
  $("subsbox").open = !cues.length;
  renderSub(); renderList();
  if (announce) toast(cues.length ? `${cues.length} lignes de sous-titres.` : "Aucune ligne thaïe avec un temps n'a été reconnue.");
}
function setCur(i) {
  if (i === cur) return;
  cur = i; renderSub();
  if (tab !== "t") return;
  const list = $("list"); list.querySelector(".cue.cur")?.classList.remove("cur");
  const el = list.querySelector(`[data-cue="${i}"]`);
  if (el) { el.classList.add("cur"); list.scrollTop += el.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientHeight / 3; }
}
const needSubs = () => { toast("Il manque les sous-titres : colle la transcription dans « Sous-titres thaïs », puis « Utiliser ces sous-titres »."); $("subsbox").open = true; $("subsbox").scrollIntoView({ behavior: "smooth", block: "nearest" }); };
function goTo(i) {
  if (!cues.length) return needSubs();
  i = Math.max(0, Math.min(cues.length - 1, i));
  setCur(i);
  stopAt = i;
  if (ready) { player.seekTo(Math.max(0, cues[i].start + offset), true); player.playVideo(); }
}
function tick() {
  fetchTitle();
  if (!ready || !cues.length || !player.getCurrentTime) return;
  const t = player.getCurrentTime() - offset, playing = player.getPlayerState() === 1;
  // Fin de la phrase suivie : pause ou boucle.
  if (playing && stopAt !== null && cues[stopAt]) {
    const c = cues[stopAt];
    if (t >= c.end - 0.12 && t < c.end + 0.8) {
      if (opts.loop) { player.seekTo(Math.max(0, c.start + offset), true); return; }
      if (opts.autopause) { player.pauseVideo(); stopAt = null; return; }
    }
    if (t >= c.start - 1 && t < c.end - 0.12) { setCur(stopAt); return; }
  }
  let i = -1;
  for (let k = 0; k < cues.length && cues[k].start <= t + 0.05; k++) i = k;
  if (i >= 0 && t > cues[i].end + 1.5) i = -1;
  if (playing) { stopAt = i >= 0 && t < cues[i].end - 0.12 ? i : null; if (i >= 0) setCur(i); }
  else if (i >= 0 && cur < 0) setCur(i);
}
setInterval(tick, 100);

// ---------- Page « Mes vidéos » ----------
let library = [];
const plain = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const nameOf = v => v.title || "Vidéo " + v.id;
async function openLibrary() {
  if (ready) player.pauseVideo();
  try { library = (await allVideos()).sort((a, b) => b.updated - a.updated); }
  catch (e) { return toast("La bibliothèque est illisible dans ce navigateur."); }
  $("lib").hidden = false; document.querySelector("main").hidden = true;
  renderLibrary();
}
function closeLibrary() { $("lib").hidden = true; document.querySelector("main").hidden = false; }
function renderLibrary() {
  const q = plain($("libsearch").value), list = library.filter(v => plain(nameOf(v)).includes(q));
  $("libstate").textContent = library.length ? `${library.length} vidéo(s) enregistrée(s) sur cet appareil. Exporte de temps en temps pour garder une copie de secours.` : "Aucune vidéo enregistrée. Charge une vidéo et ses sous-titres : elle apparaîtra ici.";
  $("libgrid").innerHTML = list.map(v => `<div class="card vid" data-id="${esc(v.id)}">
    <img src="https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg" alt="" loading="lazy" data-do="open">
    <b>${esc(nameOf(v))}</b>
    <span class="muted">Traduction : ${v.done || 0} / ${v.total || 0} lignes<br>Modifiée le ${new Date(v.updated).toLocaleDateString("fr-CH")}</span>
    <div class="row"><button data-do="open">▶ Ouvrir</button><button class="sec" data-do="rename">✏️ Renommer</button><button class="sec" data-do="delete" aria-label="Supprimer">🗑️</button></div>
  </div>`).join("");
}
$("libgrid").onclick = async e => {
  const what = e.target.closest("[data-do]")?.dataset.do; if (!what) return;
  const v = library.find(x => x.id === e.target.closest("[data-id]").dataset.id); if (!v) return;
  if (what === "open") { closeLibrary(); $("url").value = "https://www.youtube.com/watch?v=" + v.id; return loadVideo(v.id); }
  if (what === "rename") {
    const n = prompt("Nouveau titre :", nameOf(v)); if (!n || !n.trim()) return;
    v.title = n.trim(); v.renamed = true;
    if (v.id === videoId) { title = v.title; renamed = true; }
    await putVideo(v); renderLibrary();
  }
  if (what === "delete" && confirm(`Supprimer « ${nameOf(v)} » avec ses sous-titres et ses traductions ?`)) {
    await ownDB("readwrite", s => s.delete(vKey(v.id)));
    library = library.filter(x => x.id !== v.id);
    if (v.id === videoId) { $("subs").value = ""; tr = {}; summary = ""; offset = 0; applySubs(false); }
    if (store.get("thai_video_last", "") === v.id) store.set("thai_video_last", "");
    renderLibrary();
  }
};
async function exportLibrary() {
  const videos = await allVideos();
  if (!videos.length) return toast("Rien à exporter pour l'instant.");
  const data = { app: "thai_video", version: 1, exportedAt: new Date().toISOString(), videos, unknown, ignored: [...ignored] };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  a.download = "videos_thai_" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(`${videos.length} vidéo(s) exportée(s) dans tes téléchargements.`);
}
// Fusionne sans rien effacer : la version la plus récente l'emporte, les traductions des deux sont réunies.
async function importLibrary(file) {
  let d;
  try { d = JSON.parse(await file.text()); } catch (e) { d = null; }
  if (!d || d.app !== "thai_video" || !Array.isArray(d.videos)) return toast("Ce fichier n'est pas un export de « Mes vidéos ».");
  let added = 0, merged = 0;
  try {
    for (const v of d.videos) {
      if (!v || !/^[\w-]{11}$/.test(v.id) || typeof v.subs !== "string") continue;
      const old = await getVideo(v.id);
      const [first, last] = old && old.updated > v.updated ? [v, old] : [old, v];
      const rec = Object.assign({}, first, last, { tr: Object.assign({}, first && first.tr, last.tr) });
      rec.title = last.title || (first && first.title) || "";
      rec.summary = last.summary || (first && first.summary) || "";
      const list = parseSubs(rec.subs);
      rec.total = list.length; rec.done = list.filter(c => rec.tr[cueKey(c)]).length;
      await putVideo(rec); old ? merged++ : added++;
    }
  } catch (e) { return toast("L'import s'est interrompu : le navigateur refuse l'enregistrement."); }
  unknown = Object.assign({}, d.unknown, unknown); (d.ignored || []).forEach(w => ignored.add(w));
  store.set("thai_video_ignored", [...ignored]); pruneUnknown(); renderList();
  if (videoId && d.videos.some(v => v && v.id === videoId)) await loadVideo(videoId);
  await openLibrary();
  toast(`${added} vidéo(s) ajoutée(s), ${merged} fusionnée(s).`);
}
$("openlib").onclick = () => $("lib").hidden ? openLibrary() : closeLibrary();
$("libclose").onclick = closeLibrary;
$("libsearch").oninput = renderLibrary;
$("libexport").onclick = () => exportLibrary().catch(() => toast("Export impossible dans ce navigateur."));
$("libimport").onchange = async e => { const f = e.target.files[0]; if (f) await importLibrary(f); e.target.value = ""; };

// ---------- Commandes ----------
function toggleBtns() {
  [["t-rom", "rom"], ["t-sens", "sens"], ["t-blur", "blur"], ["t-fr", "fr"], ["autopause", "autopause"], ["loop", "loop"]].forEach(([id, k]) => { $(id).className = opts[k] ? "on" : "sec"; $(id).setAttribute("aria-pressed", opts[k]); });
}
[["t-rom", "rom"], ["t-sens", "sens"], ["t-blur", "blur"], ["t-fr", "fr"], ["autopause", "autopause"], ["loop", "loop"]].forEach(([id, k]) => $(id).onclick = () => {
  opts[k] = !opts[k]; store.set("thai_video_opts", opts); toggleBtns(); renderSub(); if (k === "fr") renderList();
});
$("load").onclick = () => { const id = parseId($("url").value); if (id) closeLibrary(); id ? loadVideo(id) : toast("Je ne reconnais pas ce lien YouTube."); };
$("url").onkeydown = e => { if (e.key === "Enter") $("load").click(); };
$("apply").onclick = () => { applySubs(true); if (cues.length) saveVideo(); };
$("subfile").onchange = async e => { const f = e.target.files[0]; if (f) { $("subs").value = await f.text(); $("apply").click(); } e.target.value = ""; };
$("lexfiles").onchange = async e => { await importLexFiles([...e.target.files]); e.target.value = ""; };
$("prev").onclick = () => goTo(cur - 1);
$("next").onclick = () => goTo(cur + 1);
$("replay").onclick = () => goTo(cur < 0 ? 0 : cur);
$("play").onclick = () => { if (!ready) return; if (player.getPlayerState() === 1) player.pauseVideo(); else { if (cur >= 0 && player.getCurrentTime() - offset < cues[cur].end - 0.2) stopAt = cur; player.playVideo(); } };
$("speed").onchange = () => ready && player.setPlaybackRate(+$("speed").value);
const shift = d => { offset = Math.round((offset + d) * 10) / 10; $("offset").textContent = offset.toLocaleString("fr") + " s"; saveVideo(); };
$("om").onclick = () => shift(-0.5); $("op").onclick = () => shift(0.5);
$("trcopy").onclick = () => copyText(translatePrompt(), "Demande copiée. Colle-la dans Claude, puis reviens avec « Coller la réponse ».");
// Le presse-papiers peut être refusé (surtout sur tablette) : une zone de collage reste alors disponible.
$("trpaste").onclick = async () => {
  let t = "";
  try { t = await navigator.clipboard.readText(); } catch (e) {}
  if (t.includes('"phrases"')) importTranslation(t);
  else { $("trmanual").hidden = false; $("transwer").focus(); }
};
$("trimport").onclick = () => importTranslation($("transwer").value);
$("explain").onclick = () => {
  if (!cues.length) return needSubs();
  if (cur < 0) return toast("Choisis d'abord une phrase.");
  if (ready) player.pauseVideo();
  copyText(explainPrompt(), "Demande copiée. Colle-la dans Claude.");
};
$("tab-t").onclick = () => { tab = "t"; renderList(); };
$("tab-u").onclick = () => { tab = "u"; renderList(); };
$("sub").onclick = e => {
  if (opts.blur && $("sub").classList.contains("hidden-th")) { $("sub").classList.remove("hidden-th"); return; }
  const w = e.target.closest(".w"); if (!w) return;
  const c = cues[+w.dataset.c], t = tokensOf(c)[+w.dataset.i];
  if (ready) player.pauseVideo();
  showWord(t.t, c.text); renderSub();
};
$("list").onclick = e => {
  const c = e.target.closest("[data-cue]"); if (c) return goTo(+c.dataset.cue);
  const del = e.target.closest("[data-del]"); if (del) { delete unknown[del.dataset.del]; saveUnknown(); return renderList(); }
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "copy") { const w = Object.keys(unknown).slice(0, 25); copyText(buildPrompt(w), `Demande copiée (mots : ${w.length}). Colle-la dans Claude.`); }
  if (act === "clear" && confirm("Vider la liste des mots inconnus ?")) { unknown = {}; saveUnknown(); renderList(); }
};
$("detail").onclick = e => {
  const act = e.target.closest("[data-act]")?.dataset.act; if (!act || !selected) return;
  const { word, context } = selected;
  if (act === "say" || act === "slow") say(word, act === "slow");
  if (act === "add") {
    const w = normThai($("fix").value).trim();
    if (!THAI_RE.test(w)) return toast("Écris un mot en thaï.");
    if (index.has(w)) { toast("Ce mot est déjà dans ton lexique."); return showWord(w, context); }
    unknown[w] = context; saveUnknown(); renderList(); toast("Ajouté à la liste.");
  }
  if (act === "ignore") { ignored.add(word); store.set("thai_video_ignored", [...ignored]); delete unknown[word]; saveUnknown(); renderSub(); renderList(); toast("Ce mot ne sera plus souligné."); }
};
document.addEventListener("keydown", e => {
  if (!$("lib").hidden || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  const id = { a: "prev", s: "replay", d: "next", " ": "play" }[e.key.toLowerCase()];
  if (id) { e.preventDefault(); $(id).click(); }
});
// Au retour depuis le constructeur, relit le lexique.
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadLexicon(); });

toggleBtns(); renderSub(); renderList();
loadLexicon().then(migrate).then(() => {
  const last = store.get("thai_video_last", "");
  if (last) { $("url").value = "https://www.youtube.com/watch?v=" + last; loadVideo(last); }
});
