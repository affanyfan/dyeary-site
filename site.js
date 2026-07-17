// dyeary.ai — the landing page + the "test mood sensing" flow.
//
// The markup and CSS come from the design (dyeary Site.dc.html) essentially
// verbatim. This replaces the design tool's React runtime with the real thing:
// its <sc-if> conditions became [data-if] elements toggled from `state`, and its
// {{ handlers }} became [data-act] clicks.
//
// Where the prototype simulated (setTimeout → "listening", setTimeout → a
// result, a hand-drawn copy of Chrome's permission popup), this talks to the
// actual microphone, mood model, Claude, and the person's dyeary account — the
// same pipeline the app uses.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* ---- config (same backend + model the app uses) ---------------------- */
const SUPABASE_URL  = "https://bpzmbwgpudcijikdwrfw.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwem1id2dwdWRjaWppa2R3cmZ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5MDA3MzUsImV4cCI6MjA5NzQ3NjczNX0.gc3PFVWwiLxYITFhJltbygPm7E6prsNuc5idtz_XDrA";
const BACKEND       = "https://dyeary-backend.onrender.com";
const DETECT_URL    = "https://pack-playground.vercel.app/api/detect-mood";
// Deliberately /try/ and not "/?try=1": Supabase only honours redirect URLs on
// its allow-list and silently falls back to the Site URL otherwise — which looks
// like sign-in just doing nothing. /try/ is already on that list (it's what every
// link sent so far has used), and it now hands off to the flow with the token
// intact, so this needs no dashboard change and old links keep working.
const REDIRECT      = location.origin + "/try/";
const MAX_SECONDS   = 20;

const sb = createClient(SUPABASE_URL, SUPABASE_ANON);

/* ---- state ----------------------------------------------------------- */
const state = {
  tryOpen: false,
  step: "signin",          // signin | email | permission
  mic: "prompt",           // prompt | granted | denied
  phase: null,             // null | generating | result
  listening: false,
  asking: false,           // the browser's prompt is up — hold everything
  recSecs: 0,
  savedSecs: 0,
  result: null,            // { bucket, title, body }
};

// Derived exactly as the design had it, so the markup's conditions still mean
// what the designer meant by them.
function derive() {
  const inSession = state.step === "permission" && state.mic === "granted";
  return {
    tryOpen: state.tryOpen,
    isForm: state.step === "signin" || state.step === "email",
    isSignin: state.step === "signin",
    isEmail: state.step === "email",
    isPermission: state.step === "permission",
    micGranted: state.mic === "granted",
    micPending: state.step === "permission" && state.mic !== "granted",
    micDenied: state.mic === "denied",
    listening: inSession && state.listening && !state.phase,
    generating: inSession && state.phase === "generating",
    resultReady: inSession && state.phase === "result",
    notInSession: !inSession,
    // The arrow + handwriting point at the REAL prompt, so show it only while
    // one is actually up. Desktop only: mobile permission sheets are system UI
    // with no consistent anchor to point at.
    noteVisible: state.asking && window.innerWidth > 720,
  };
}

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function render() {
  const d = derive();
  $$("[data-if]").forEach((el) => {
    const on = !!d[el.getAttribute("data-if")];
    el.style.display = on ? "" : "none";
  });
  const bg = $("#lp-try-bg");
  if (bg) bg.classList.toggle("listening", d.listening);
  document.body.style.overflow = state.tryOpen ? "hidden" : "";
  const btn = $("#lp-mic-btn");
  if (btn) {
    // Paused: the prompt is the browser's, so we just wait for it.
    btn.textContent = state.asking ? "Waiting for permission…" : "Start Mood Sensing";
    btn.disabled = state.asking;
    btn.style.opacity = state.asking ? "0.55" : "";
    btn.style.cursor = state.asking ? "default" : "pointer";
  }
  const rl = $('[data-val="recLabel"]');
  if (rl) rl.textContent = fmt(state.recSecs);
  const ss = $('[data-val="savedSecs"]');
  if (ss) ss.textContent = String(state.savedSecs).padStart(2, "0");
  if (d.resultReady && state.result) paintResult(state.result);
}
const set = (patch) => { Object.assign(state, patch); render(); };
const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
const moodColor = (b) =>
  getComputedStyle(document.documentElement).getPropertyValue("--m-" + b).trim() || "var(--ink500)";

/* ---- try flow -------------------------------------------------------- */
// Kept warm from boot and every auth change. openTry MUST NOT await before it
// reaches the microphone: awaiting ends the click's transient activation, and
// getUserMedia then gets rejected — which we'd report as "denied" to someone who
// had happily allowed it.
let sess = null;
sb.auth.getSession().then(({ data }) => { sess = data.session || null; });
async function session() {
  const { data } = await sb.auth.getSession();
  sess = data.session || null;
  return sess;
}

function openTry(e) {
  e?.preventDefault();
  // Signed in already? Straight to the mic — the account is the only reason the
  // gate exists.
  set({ tryOpen: true, step: sess ? "permission" : "signin" });
  // No prompt here: "Start Mood Sensing" raises it, so the click that asks is
  // always the person's. Firing it automatically is what got the site
  // auto-blocked (browsers block for good after repeated unprompted requests) —
  // and it's their call when to start recording anyway.
}

function closeTry(e) {
  e?.preventDefault();
  stopTracks();
  set({ tryOpen: false, step: "signin", mic: "prompt", asking: false, phase: null, listening: false, recSecs: 0, result: null });
}

const signIn = (e) => {
  const provider = e.currentTarget.textContent.toLowerCase().includes("apple") ? "apple" : "google";
  sb.auth.signInWithOAuth({ provider, options: { redirectTo: REDIRECT } });
};
const emailLink = (e) => { e.preventDefault(); set({ step: "email" }); };
const backToSignin = (e) => { e.preventDefault(); set({ step: "signin" }); };

async function sendEmailLink() {
  const input = $('#lp-try-bg input[type="email"]');
  const btn = $("#lp-email-send");
  const email = (input?.value || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { input?.focus(); return; }
  btn.disabled = true; btn.textContent = "Sending…";
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: REDIRECT } });
  btn.disabled = false;
  btn.textContent = error ? "Try again" : "Link sent — check your email";
}

// Signing in navigates away and comes back to ?try=1; pick the flow back up.
sb.auth.onAuthStateChange((_e, s) => {
  sess = s || null;
  if (s && state.tryOpen && state.step !== "permission") set({ step: "permission" });
});

/* ---- microphone ------------------------------------------------------ */
// No fake dialog: calling getUserMedia IS the prompt. The handwritten note is up
// while it's pending, pointing at where browsers actually put it.
let stream = null, rec = null, chunks = [], startedAt = 0, tick = null, stopAt = null;

async function askMic() {
  // Called straight from the button click, so the gesture is intact and the
  // browser will actually raise its prompt. We pause here — no upsell screen, no
  // guessing at permission state — and pick up the moment it's answered.
  set({ mic: "prompt", asking: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    set({ asking: false });
    // Not every failure is a refusal. Only NotAllowedError means the person (or
    // a remembered Block) said no; NotFoundError is "no microphone",
    // NotReadableError is "something else is using it". Reporting all of them as
    // "denied" told people to enable a permission they'd already granted.
    console.warn("[dyeary] microphone unavailable:", err?.name, err?.message);
    // A remembered Block rejects instantly and never shows a prompt — no amount
    // of retrying gets past it, so the copy has to send people to site settings.
    const hint = $('[data-if="micDenied"] p');
    if (hint) {
      if (err?.name === "NotFoundError" || err?.name === "OverconstrainedError")
        hint.textContent = "No microphone found. Plug one in (or pick one in your system sound settings) and try again.";
      else if (err?.name === "NotReadableError")
        hint.textContent = "Another app is holding the microphone. Close it (Zoom, Meet, Voice Memos…) and try again.";
    }
    set({ mic: err?.name === "NotFoundError" || err?.name === "NotReadableError" ? "denied" : "denied" });
    return;
  }
  set({ mic: "granted", asking: false });
  warmup();
  startRecording();   // permission answered → the prototype resumes
}
const micRetry = () => askMic();


function stopTracks() {
  clearInterval(tick); clearTimeout(stopAt);
  try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
  stream = null;
}

function startRecording() {
  chunks = [];
  rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = process;
  rec.start();
  startedAt = Date.now();
  set({ listening: true, recSecs: 0, phase: null });
  tick = setInterval(() => set({ recSecs: (Date.now() - startedAt) / 1000 }), 200);
  stopAt = setTimeout(finish, MAX_SECONDS * 1000);   // the cap the design implies
}

// "Save entry" ends the take; everything after is real work, not a timer.
function finish() {
  if (!rec || rec.state === "inactive") return;
  clearInterval(tick); clearTimeout(stopAt);
  set({ savedSecs: Math.round((Date.now() - startedAt) / 1000), phase: "generating", listening: false });
  rec.stop();
  stopTracks();
}

/* ---- the real pipeline: mood model → Claude → the account ------------ */
function b64(buf) {
  const b = new Uint8Array(buf); let s = ""; const N = 0x8000;
  for (let i = 0; i < b.length; i += N) s += String.fromCharCode.apply(null, b.subarray(i, i + N));
  return btoa(s);
}
// 16 kHz mono PCM16 — the shape the mood model wants (same as the app).
async function toPcm16(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let decoded;
  try { decoded = await ctx.decodeAudioData((await blob.arrayBuffer()).slice(0)); } finally { ctx.close(); }
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const data = (await off.startRendering()).getChannelData(0);
  const pcm = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return b64(pcm.buffer);
}

let warmed = false;
function warmup() {
  if (warmed) return; warmed = true;
  fetch(DETECT_URL, { method: "POST", headers: { "content-type": "application/json" },
                      body: JSON.stringify({ warmup: true }) }).catch(() => {});
}

async function process() {
  const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
  if (state.savedSecs < 1) return fail();
  try {
    const det = await fetch(DETECT_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ audio_b64: await toPcm16(blob) }),
    });
    if (!det.ok) return fail();
    const { transcript = "", reading } = await det.json();
    if (!transcript.trim() || !reading) return fail();
    const entry = await saveEntry(transcript.trim(), reading);
    set({ phase: "result", result: { bucket: reading.bucket, ...entry } });
  } catch { fail(); }
}

function fail() {
  // Back to the start screen rather than a dead end — and NOT straight back into
  // getUserMedia: there's no gesture here, so that request would be rejected and
  // count against the site's standing with the browser. The button asks.
  stopTracks();
  set({ phase: null, listening: false, asking: false });
}

async function saveEntry(transcript, reading) {
  const s = await session();
  const fallback = { title: "Your entry", body: transcript };
  if (!s) return fallback;
  const auth = { Authorization: "Bearer " + s.access_token, "content-type": "application/json" };
  try {
    const r = await fetch(BACKEND + "/refine", { method: "POST", headers: auth,
                                                 body: JSON.stringify({ transcript }) });
    if (!r.ok) return fallback;
    const refined = await r.json();
    const content = {
      title: refined.title,
      refinedText: refined.refinedText,
      transcript: refined.cleanTranscript || transcript,
      summary: refined.summary || null,
      highlights: refined.highlights || null,
      mentions: refined.mentions || null,
      words: null,
    };
    // Send BOTH reads, matching the app: `emotions` is what was SAID (Claude's
    // blend from refine) and `tone` is how it SOUNDED (the mood model). The page
    // used to post the mood model's read as `emotions` and drop Claude's, which
    // now means the backend would blend one signal against nothing.
    await fetch(BACKEND + "/entry", {
      method: "POST", headers: auth,
      body: JSON.stringify({
        content,
        emotions: refined.feelings?.length ? [refined.feelings] : [reading.feelings],
        tone: reading.feelings ? [reading.feelings] : [],
        voiceSeconds: state.savedSecs,
      }),
    });
    return { title: refined.title, body: refined.refinedText || transcript };
  } catch {
    return fallback;
  }
}

function paintResult(r) {
  const card = $('[data-if="resultReady"] div[style*="--m-calm"]') || $('[data-if="resultReady"]');
  const pill = card?.querySelector('div[style*="border-radius: 999px"]');
  const dot = pill?.querySelector("span");
  const title = card?.querySelector('div[style*="font-size: 26px"]');
  const body = card?.querySelector("p");
  if (dot) dot.style.background = moodColor(r.bucket);
  if (pill) pill.childNodes[pill.childNodes.length - 1].textContent = r.bucket;
  if (title) title.textContent = r.title;
  if (body) body.textContent = r.body;
  if (card && card.style) card.style.background = `color-mix(in srgb, ${moodColor(r.bucket)} var(--tint), var(--paper0))`;
}

/* ---- landing: year grid, phone screens, scroll choreography ---------- */
const MOODS = ["joy","calm","love","surprise","tired","sad","fear","anger"];
function yearGrid() {
  const grid = $("#yr-grid"), legend = $("#yr-legend");
  if (!grid) return;
  // Decorative: an illustration of what a year of moods looks like, not data.
  let s = 20260701;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pool = ["joy","joy","calm","calm","calm","joy","surprise","love","love","tired","tired","sad","fear","anger"];
  for (let i = 0; i < 371; i++) {
    const c = document.createElement("div");
    c.className = "yr-cell";
    c.style.cssText = "aspect-ratio:1;border-radius:5px;opacity:0;transform:scale(.55);transition:opacity .5s ease,transform .5s cubic-bezier(0.34,1.55,0.5,1);";
    c.style.background = rnd() < 0.17 ? "var(--paper3)" : `var(--m-${pool[Math.floor(rnd() * pool.length)]})`;
    grid.appendChild(c);
  }
  if (legend) legend.innerHTML = MOODS.map((m) =>
    `<div style="display:flex;align-items:center;gap:9px;">
       <span style="width:14px;height:14px;border-radius:5px;background:var(--m-${m});"></span>
       <span style="font-family:var(--font-ui);font-size:14px;font-weight:500;color:var(--ink700);text-transform:capitalize;">${m}</span>
     </div>`).join("");

  const reveal = () => $$("#yr-grid .yr-cell").forEach((el, i) => {
    setTimeout(() => { el.style.opacity = "1"; el.style.transform = "scale(1)"; }, (i % 53) * 13 + Math.floor(i / 53) * 6);
  });
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) { reveal(); io.disconnect(); }
    }), { threshold: 0.1 });
    io.observe(grid);
  } else reveal();
}

// The phone screens are real pages; inline them so relative assets still resolve.
function phoneScreens() {
  const dir = new URL("uploads/phone-assets/", document.baseURI).href;
  const map = { feed: "screen-embed-feed.html", talk: "screen-embed-talk.html" };
  $$("#lp-phone iframe[data-embed]").forEach(async (f) => {
    try {
      const html = await (await fetch(dir + map[f.getAttribute("data-embed")])).text();
      f.srcdoc = html.replace(/<head(\s[^>]*)?>/i, (m) => m + '<base href="' + dir + '">');
    } catch {}
  });
}

function choreography() {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let headW = null, headH = null, talkOn = false, moodT = null, ticking = false;

  function positionHead() {
    const head = $("#lp-head"), phone = $("#lp-phone"), nav = $("nav");
    if (!head || !phone) return;
    if (headW === innerWidth && headH === innerHeight) return;
    headW = innerWidth; headH = innerHeight;
    const rendered = (phone.offsetHeight || 0) * (innerWidth <= 720 ? 1 : 1.85);
    const navBottom = nav ? nav.getBoundingClientRect().bottom : 64;
    const mid = (navBottom + (innerHeight - rendered / 2)) / 2;
    head.style.top = Math.max(mid, navBottom + (head.offsetHeight || 120) / 2 + 16).toFixed(1) + "px";
  }

  function update() {
    ticking = false;
    if (!$("#lp-sticky")) return;
    const p = Math.max(0, Math.min(1, scrollY / (innerHeight * 2.2)));
    const rise = Math.min(1, p / 0.4);
    const eased = 1 - Math.pow(1 - rise, 3);

    const phone = $("#lp-phone");
    const start = innerWidth <= 720 ? 1 : 1.85;
    if (phone) phone.style.transform =
      `translate(-50%, calc(-50% + ${((1 - eased) * 50).toFixed(1)}vh)) scale(${(start - eased * (start - 1)).toFixed(4)})`;

    const head = $("#lp-head");
    if (head) {
      head.style.transform = `translateY(calc(-50% - ${(eased * 130).toFixed(1)}px))`;
      head.style.opacity = String(1 - rise);
    }

    $$(".lp-float").forEach((el) => {
      const shown = p > (parseFloat(el.getAttribute("data-appear")) || 0.5);
      if (el._shown === shown) return;
      el._shown = shown;
      el.style.transition = "opacity .4s ease, transform .55s cubic-bezier(0.34,1.55,0.5,1)";
      el.style.opacity = shown ? "1" : "0";
      el.style.transform = shown ? "translateY(0) scale(1)" : "translateY(14px) scale(0.6)";
    });

    const cue = $("#lp-cue");
    if (cue) cue.style.opacity = String(Math.max(0, 1 - p * 6));

    // Halfway through the pin, the phone switches to the recording screen and is
    // told to start its own little performance.
    const talk = $("#lp-screen-talk");
    if (talk) {
      const on = p > 0.5;
      if (talkOn !== on) {
        talkOn = on;
        talk.style.opacity = on ? "1" : "0";
        clearTimeout(moodT);
        if (on) moodT = setTimeout(() => { try { talk.contentWindow.postMessage("dyeary:record", "*"); } catch {} }, 650);
        else { try { talk.contentWindow.postMessage("dyeary:reset", "*"); } catch {} }
      }
    }
  }
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", () => { headH = null; positionHead(); onScroll(); }, { passive: true });
  requestAnimationFrame(() => { positionHead(); if (!reduce) update(); });
}

/* ---- theme ----------------------------------------------------------- */
function theme() {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => document.documentElement.classList.toggle("dyeary-dark", mq.matches);
  apply(); mq.addEventListener("change", apply);
}

/* ---- boot ------------------------------------------------------------ */
// micAllow/micDeny aren't here on purpose: those belonged to the design's mocked
// permission popup. The browser's own prompt is the only thing that grants a mic.
const ACTS = { testMood: openTry, closeTry, signIn, emailLink, backToSignin, micRetry,
               saveEntry: finish };
$$("[data-act]").forEach((el) =>
  el.addEventListener("click", (e) => ACTS[el.getAttribute("data-act")]?.(e)));
$("#lp-email-send")?.addEventListener("click", sendEmailLink);

theme();
yearGrid();
phoneScreens();
choreography();
render();

// Coming back from a sign-in link (or /try) drops you straight into the flow.
// Arriving from a sign-in link (or /try): no click happened, so only start the
// mic if it's already granted; otherwise the button provides the gesture.
if (new URLSearchParams(location.search).get("try") === "1") {
  session().then(() => {
    set({ tryOpen: true, step: sess ? "permission" : "signin" });
  });
}
