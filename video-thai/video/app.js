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
function shortSense(e) {
  const s = String(e.court || e.sens || "").split(e.court ? /\s*[\/;]\s*/ : /[.,;(:]/)[0].trim();
  return s.length > 32 ? s.slice(0, 32) + "…" : s;
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
const opts = Object.assign({ rom: false, sens: false, blur: false, autopause: false, loop: false }, store.get("thai_video_opts", {}));
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
function renderSub() {
  const el = $("sub");
  el.className = (opts.rom ? "show-rom " : "") + (opts.sens ? "show-sens " : "") + (opts.blur ? "hidden-th" : "");
  if (!cues.length) el.innerHTML = '<span class="muted">Ajoute les sous-titres thaïs ci-dessous.</span>';
  else el.innerHTML = cur >= 0 ? wordsHTML(cues[cur], cur) : '<span class="muted">▶ Lance la vidéo ou choisis une phrase.</span>';
}
function renderList() {
  $("nunk").textContent = Object.keys(unknown).length;
  $("tab-t").className = tab === "t" ? "on" : "sec"; $("tab-u").className = tab === "u" ? "on" : "sec";
  const el = $("list");
  if (tab === "t") {
    el.innerHTML = cues.length ? cues.map((c, i) => {
      const s = Math.floor(c.start);
      return `<div class="cue${i === cur ? " cur" : ""}" data-cue="${i}"><time>${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}</time><span lang="th">${esc(c.text)}</span></div>`;
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
  if (es) h += es.map(e => `<div class="entry"><span class="badge" style="background:${esc(colors[e.cat] || "#475569")}">${esc(e.cat)}</span><b>${esc(e.rom)}</b>${e.court ? " : " + esc(e.court) : ""}
      <div style="margin-top:5px">${esc(e.sens)}</div>${e.note ? `<div class="muted" style="margin-top:5px"><em>${esc(e.note)}</em></div>` : ""}</div>`).join("");
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
const AUDIO_DIR = "../constructeur/audio_thai/";
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
function saveVideo() {
  if (!videoId) return;
  if (!store.set("thai_video_v_" + videoId, { subs: $("subs").value, offset })) toast("Mémoire du navigateur pleine : ces sous-titres ne seront pas gardés.");
  store.set("thai_video_last", videoId);
}
async function loadVideo(id) {
  videoId = id; stopAt = null;
  const saved = store.get("thai_video_v_" + id, null);
  $("subs").value = saved ? saved.subs : ""; offset = saved ? saved.offset : 0;
  applySubs(false); store.set("thai_video_last", id);
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
  cues = parseSubs($("subs").value); cur = -1; stopAt = null;
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
function goTo(i) {
  if (!cues.length) return;
  i = Math.max(0, Math.min(cues.length - 1, i));
  setCur(i);
  stopAt = i;
  if (ready) { player.seekTo(Math.max(0, cues[i].start + offset), true); player.playVideo(); }
}
function tick() {
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

// ---------- Commandes ----------
function toggleBtns() {
  [["t-rom", "rom"], ["t-sens", "sens"], ["t-blur", "blur"], ["autopause", "autopause"], ["loop", "loop"]].forEach(([id, k]) => { $(id).className = opts[k] ? "on" : "sec"; $(id).setAttribute("aria-pressed", opts[k]); });
}
[["t-rom", "rom"], ["t-sens", "sens"], ["t-blur", "blur"], ["autopause", "autopause"], ["loop", "loop"]].forEach(([id, k]) => $(id).onclick = () => {
  opts[k] = !opts[k]; store.set("thai_video_opts", opts); toggleBtns(); renderSub();
});
$("load").onclick = () => { const id = parseId($("url").value); id ? loadVideo(id) : toast("Je ne reconnais pas ce lien YouTube."); };
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
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  const id = { a: "prev", s: "replay", d: "next", " ": "play" }[e.key.toLowerCase()];
  if (id) { e.preventDefault(); $(id).click(); }
});
// Au retour depuis le constructeur, relit le lexique.
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadLexicon(); });

toggleBtns(); renderSub(); renderList();
loadLexicon().then(() => {
  const last = store.get("thai_video_last", "");
  if (last) { $("url").value = "https://www.youtube.com/watch?v=" + last; loadVideo(last); }
});
