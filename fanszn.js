const fs       = require("fs");
const https    = require("https");
const readline = require("readline");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const ACCTS_FILE  = "akun.txt";
const REF         = "FAN-3CVF";
const FANDOM_ID   = "metal";           // genre default, bisa diganti
const FOLLOW_USER = "IPXExchange";
const BASE        = "fanszn.ipx.exchange";
const BASE_X      = "x.com";
const BASE_X_API  = "api.x.com";
const DELAY_MS    = 3000;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg, type = "info") {
  const icons = { info: "·", ok: "✓", err: "✗", warn: "⚠" };
  console.log(`[${icons[type] || "·"}] ${msg}`);
}

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const enc = res.headers["content-encoding"] || "";
        const decompress = (b) => {
          if (enc.includes("br"))      return require("zlib").brotliDecompressSync(b);
          if (enc.includes("gzip"))    return require("zlib").gunzipSync(b);
          if (enc.includes("deflate")) return require("zlib").inflateSync(b);
          return b;
        };
        let text;
        try { text = decompress(buf).toString("utf8"); } catch { text = buf.toString("utf8"); }
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers, raw: text });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function xHeaders(authToken, ct0, extra = {}) {
  return {
    authorization: "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
    cookie: `auth_token=${authToken}; ct0=${ct0}`,
    "x-csrf-token": ct0,
    "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    origin: "https://x.com",
    referer: "https://x.com/",
    ...extra,
  };
}

function fansznHeaders(sessionCookie, extra = {}) {
  return {
    "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/json",
    cookie: sessionCookie,
    origin: "https://fanszn.ipx.exchange",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-ch-ua": '"Mises";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
    "sec-ch-ua-mobile": "?1",
    "sec-ch-ua-platform": '"Android"',
    ...extra,
  };
}

function loadAccounts() {
  if (!fs.existsSync(ACCTS_FILE)) { console.error(`${ACCTS_FILE} tidak ditemukan!`); process.exit(1); }
  return fs.readFileSync(ACCTS_FILE, "utf8")
    .split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
    .map((block, i) => {
      const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
      return { authToken: lines[0], ct0: lines[1], index: i + 1 };
    }).filter(a => a.authToken && a.ct0);
}

// ─── TWITTER: CEK & FOLLOW ────────────────────────────────────────────────────
async function checkFollowing(authToken, ct0) {
  const res = await request({
    hostname: BASE_X_API,
    path: `/1.1/friendships/show.json?source_screen_name=me&target_screen_name=${FOLLOW_USER}`,
    method: "GET",
    headers: xHeaders(authToken, ct0),
  });
  return res.body?.relationship?.source?.following === true;
}

async function followUser(authToken, ct0) {
  const body = `screen_name=${FOLLOW_USER}&skip_status=true`;
  const res = await request({
    hostname: BASE_X_API,
    path: "/1.1/friendships/create.json",
    method: "POST",
    headers: xHeaders(authToken, ct0, {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": Buffer.byteLength(body),
    }),
  }, body);
  return res.status === 200;
}

// ─── FANSZN: CONNECT X (OAuth2 PKCE) ─────────────────────────────────────────
async function connectX(authToken, ct0, index) {
  // Step 1: GET auth/x/start → redirect ke Twitter
  const startRes = await request({
    hostname: BASE,
    path: `/api/fanszn/auth/x/start?returnTo=%2Ffanszn%2Fconnect&ref=${REF}`,
    method: "GET",
    headers: {
      accept: "*/*",
      "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      referer: `https://${BASE}/fanszn/pick?ref=${REF}`,
    },
  });

  let xAuthUrl = startRes.headers?.location;
  if (!xAuthUrl) throw new Error(`auth/x/start gagal (${startRes.status}): ${JSON.stringify(startRes.body)?.slice(0,100)}`);
  xAuthUrl = xAuthUrl.replace("https://twitter.com/", "https://x.com/");

  const urlObj = new URL(xAuthUrl);
  const state  = urlObj.searchParams.get("state");
  log(`Akun #${index} — Twitter URL ok, state: ${state?.slice(0,20)}...`);

  // Step 2: GET /i/api/2/oauth2/authorize → dapat auth_code (JSON)
  const getRes = await request({
    hostname: BASE_X,
    path: `/i/api/2/oauth2/authorize?${urlObj.searchParams.toString()}`,
    method: "GET",
    headers: xHeaders(authToken, ct0, {
      accept: "application/json",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    }),
  });

  const authCode = getRes.body?.auth_code;
  if (!authCode) throw new Error(`Tidak dapat auth_code (${getRes.status}): ${JSON.stringify(getRes.body)?.slice(0,150)}`);
  log(`Akun #${index} — auth_code ok`);

  // Step 3: POST api.x.com/2/oauth2/authorize → dapat redirect_uri
  const approveBody = new URLSearchParams({
    approval:     "true",
    code:         authCode,
    consent_flow: "web_consent",
  }).toString();

  const approveRes = await request({
    hostname: BASE_X_API,
    path: "/2/oauth2/authorize",
    method: "POST",
    headers: xHeaders(authToken, ct0, {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": Buffer.byteLength(approveBody),
    }),
  }, approveBody);

  const redirectUri = approveRes.body?.redirect_uri;
  if (!redirectUri) throw new Error(`Tidak dapat redirect_uri (${approveRes.status}): ${JSON.stringify(approveRes.body)?.slice(0,150)}`);

  const oauthCode = new URL(redirectUri).searchParams.get("code");
  if (!oauthCode) throw new Error("Tidak ada code di redirect_uri");
  log(`Akun #${index} — oauth code ok`);

  // Step 4: GET /api/fanszn/auth/x/callback → ikutin redirect sampai dapat session cookie
  const cbState = new URL(redirectUri).searchParams.get("state") || state;
  let cookieJar  = "";
  let currentPath = `/api/fanszn/auth/x/callback?state=${encodeURIComponent(cbState)}&code=${encodeURIComponent(oauthCode)}`;
  let currentHost = BASE;

  for (let hop = 0; hop < 6; hop++) {
    const cbRes = await request({
      hostname: currentHost,
      path: currentPath,
      method: "GET",
      headers: {
        accept: "*/*",
        "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        referer: "https://x.com/",
        ...(cookieJar ? { cookie: cookieJar } : {}),
      },
    });

    // Kumpulin cookies dari tiap hop
    const hopCookies = [].concat(cbRes.headers?.["set-cookie"] || [])
      .map(c => c.split(";")[0]);
    if (hopCookies.length) {
      const incoming = hopCookies.join("; ");
      cookieJar = cookieJar ? `${cookieJar}; ${incoming}` : incoming;
    }

    log(`Akun #${index} — cb hop${hop} [${cbRes.status}] cookies: ${hopCookies.length}`);

    // Kalau bukan redirect, selesai
    if (cbRes.status < 300 || cbRes.status >= 400) break;

    const loc = cbRes.headers?.location;
    if (!loc) break;

    // Resolve redirect URL
    if (loc.startsWith("http")) {
      const u = new URL(loc);
      currentHost = u.hostname;
      currentPath = u.pathname + u.search;
    } else {
      currentPath = loc;
    }
  }

  if (!cookieJar) throw new Error(`Callback tidak return cookie`);

  // Pastiin fanszn_session ada
  const sessionCookie = cookieJar;
  if (!sessionCookie.includes("fanszn_session") && !sessionCookie.includes("fanszn_x_at")) {
    log(`Akun #${index} — cookie jar: ${sessionCookie.slice(0,100)}`, "warn");
  }
  log(`Akun #${index} — session cookie ok`);

  return sessionCookie;
}

// ─── FANSZN: CEK ME ───────────────────────────────────────────────────────────
async function getMe(sessionCookie) {
  const res = await request({
    hostname: BASE,
    path: "/api/fanszn/me",
    method: "GET",
    headers: fansznHeaders(sessionCookie, { referer: `https://${BASE}/fanszn/connect` }),
  });
  return res.body;
}

// ─── FANSZN: PILIH FANDOM ─────────────────────────────────────────────────────
async function pickFandom(sessionCookie, fandomId = FANDOM_ID) {
  const body = JSON.stringify({ fandomId });
  const res = await request({
    hostname: BASE,
    path: "/api/fanszn/fandom",
    method: "POST",
    headers: fansznHeaders(sessionCookie, {
      "content-length": Buffer.byteLength(body),
      referer: `https://${BASE}/fanszn/pick?connected=1&new=1`,
    }),
  }, body);
  return res.status === 200 && res.body?.success;
}

// ─── FANSZN: FOLLOW X ─────────────────────────────────────────────────────────
async function fansznFollow(sessionCookie) {
  const res = await request({
    hostname: BASE,
    path: "/api/fanszn/follow",
    method: "GET",
    headers: fansznHeaders(sessionCookie, { referer: `https://${BASE}/fanszn/connect` }),
  });
  return res.status === 200;
}

// ─── FANSZN: QUIZ (FAN CHECK) ─────────────────────────────────────────────────
async function doFanCheck(sessionCookie, index) {
  // Start quiz
  const startBody = JSON.stringify({ action: "start" });
  const startRes = await request({
    hostname: BASE,
    path: "/api/fanszn/check",
    method: "POST",
    headers: fansznHeaders(sessionCookie, {
      "content-length": Buffer.byteLength(startBody),
      referer: `https://${BASE}/fanszn/check?start=1`,
    }),
  }, startBody);

  if (!startRes.body?.success) {
    log(`Akun #${index} — check start: ${JSON.stringify(startRes.body)?.slice(0,100)}`, "warn");
    return false;
  }

  const total = startRes.body?.attempt?.total || 7;
  log(`Akun #${index} — quiz start, total: ${total} soal`);

  // Jawab tiap soal — jawab random, yang penting submit semua
  for (let i = 0; i < total; i++) {
    await sleep(Math.floor(Math.random() * 3000) + 2000); // simulate reading time 2-5s

    // Ambil jawaban yg benar dari response sebelumnya kalau ada
    // kalau ga ada, random pilih 0-3
    const chosen = Math.floor(Math.random() * 4);

    const ansBody = JSON.stringify({ action: "answer", index: i, chosen });
    const ansRes = await request({
      hostname: BASE,
      path: "/api/fanszn/check",
      method: "POST",
      headers: fansznHeaders(sessionCookie, {
        "content-length": Buffer.byteLength(ansBody),
        referer: `https://${BASE}/fanszn/check?start=1`,
      }),
    }, ansBody);

    const finished = ansRes.body?.attempt?.finished;
    const correct  = ansRes.body?.attempt?.correct ?? "?";
    const aura     = ansRes.body?.attempt?.baseAura ?? "?";
    log(`Akun #${index} — soal ${i+1}/${total} → chosen:${chosen} | correct:${correct} aura:${aura}`);

    if (finished) {
      log(`Akun #${index} — quiz selesai!`);
      break;
    }
  }

  return true;
}

// ─── FANSZN: GET CARD ─────────────────────────────────────────────────────────
async function getCard(sessionCookie) {
  const res = await request({
    hostname: BASE,
    path: "/api/fanszn/card",
    method: "GET",
    headers: fansznHeaders(sessionCookie, { referer: `https://${BASE}/fanszn/card?fresh=1` }),
  });
  return res.body;
}

// ─── FANSZN: CHECK IN ─────────────────────────────────────────────────────────
async function checkIn(sessionCookie) {
  const res = await request({
    hostname: BASE,
    path: "/api/fanszn/checkin",
    method: "POST",
    headers: fansznHeaders(sessionCookie, {
      "content-length": "0",
      referer: `https://${BASE}/fanszn/hub`,
    }),
  }, "");
  return res.body?.success === true;
}

// ─── PROCESS 1 AKUN ───────────────────────────────────────────────────────────
async function processAccount(account) {
  const { authToken, ct0, index } = account;
  log(`\n${"─".repeat(45)}`);
  log(`Akun #${index} — mulai...`);

  try {
    // 1. Twitter follow (pakai xHeaders langsung, tanpa fanszn session)
    log(`Akun #${index} — cek follow @${FOLLOW_USER}...`);
    const alreadyFollow = await checkFollowing(authToken, ct0).catch(() => false);
    if (alreadyFollow) {
      log(`Akun #${index} — sudah follow @${FOLLOW_USER}`, "warn");
    } else {
      const followed = await followUser(authToken, ct0);
      log(`Akun #${index} — follow @${FOLLOW_USER}: ${followed ? "✓" : "gagal"}`, followed ? "ok" : "warn");
      await sleep(1500);
    }

    // 2. Connect X → dapat session cookie
    log(`Akun #${index} — connect X...`);
    const sessionCookie = await connectX(authToken, ct0, index);
    await sleep(1000);

    // 3. Cek me
    const me = await getMe(sessionCookie);
    const handle = me?.me?.handle || me?.handle;
    if (handle) log(`Akun #${index} — logged in as @${handle}`, "ok");
    else log(`Akun #${index} — me: ${JSON.stringify(me)?.slice(0,100)}`, "warn");

    // 4. Pilih fandom
    log(`Akun #${index} — pilih fandom: ${FANDOM_ID}...`);
    const fandomOk = await pickFandom(sessionCookie);
    log(`Akun #${index} — fandom: ${fandomOk ? "✓" : "gagal/sudah dipilih"}`, fandomOk ? "ok" : "warn");
    await sleep(1000);

    // 5. FansZN follow (trigger endpoint /api/fanszn/follow)
    log(`Akun #${index} — fanszn follow trigger...`);
    await fansznFollow(sessionCookie);
    await sleep(1000);

    // 6. Fan check (quiz 7 soal)
    log(`Akun #${index} — mulai fan check quiz...`);
    await doFanCheck(sessionCookie, index);
    await sleep(1500);

    // 7. Get card (trigger setelah quiz selesai)
    const card = await getCard(sessionCookie);
    if (card?.success) {
      log(`Akun #${index} — card: aura=${card.card?.aura} rank=${card.card?.rank} fandom=${card.card?.fandom?.name}`, "ok");
    }
    await sleep(1000);

    // 8. Check in
    log(`Akun #${index} — check in...`);
    const checkedIn = await checkIn(sessionCookie);
    log(`Akun #${index} — checkin: ${checkedIn ? "✓" : "gagal/sudah checkin hari ini"}`, checkedIn ? "ok" : "warn");

    log(`Akun #${index} — ✓ DONE!`, "ok");
    return { index, status: "ok", handle: handle || "?" };

  } catch (e) {
    log(`Akun #${index} — ERROR: ${e.message}`, "err");
    return { index, status: "err", detail: e.message };
  }
}

// ─── MENU ─────────────────────────────────────────────────────────────────────
async function showMenu(accounts) {
  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  console.log("\n╔══════════════════════════════╗");
  console.log("║   FansZN Full Auto Bot       ║");
  console.log(`║   ref: ${REF}             ║`);
  console.log("╚══════════════════════════════╝");
  console.log(`  Total akun: ${accounts.length}\n`);
  console.log("  [1] 1 Akun");
  console.log("  [2] Semua akun");
  console.log("  [3] From X to end\n");

  const choice = await ask("Pilih (1/2/3): ");
  let targets  = [];

  if (choice === "1") {
    const num = await ask(`Nomor akun (1-${accounts.length}): `);
    const idx = parseInt(num);
    if (isNaN(idx) || idx < 1 || idx > accounts.length) { console.log("Invalid."); process.exit(1); }
    targets = [accounts[idx - 1]];
  } else if (choice === "2") {
    targets = accounts;
  } else if (choice === "3") {
    const from  = await ask(`From akun (1-${accounts.length}): `);
    const start = parseInt(from) - 1;
    if (isNaN(start) || start < 0 || start >= accounts.length) { console.log("Invalid."); process.exit(1); }
    targets = accounts.slice(start);
    console.log(`  → Akun #${start + 1} sampai #${accounts.length} (${targets.length} akun)`);
  } else {
    console.log("Invalid."); process.exit(1);
  }

  rl.close();
  return targets;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const accounts = loadAccounts();
  if (!accounts.length) { log("Tidak ada akun!", "err"); process.exit(1); }

  const targets = await showMenu(accounts);
  console.log(`\n→ Proses ${targets.length} akun...\n`);

  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const result = await processAccount(targets[i]);
    results.push(result);
    if (i < targets.length - 1) {
      const cd = Math.floor(Math.random() * 5000) + DELAY_MS;
      log(`Delay ${(cd/1000).toFixed(1)}s...`);
      await sleep(cd);
    }
  }

  console.log("\n══════════ SUMMARY ══════════");
  const ok  = results.filter(r => r.status === "ok").length;
  const err = results.filter(r => r.status === "err").length;
  console.log(`  ✓ Berhasil : ${ok}`);
  console.log(`  ✗ Error    : ${err}`);
  if (err) {
    results.filter(r => r.status !== "ok")
      .forEach(r => console.log(`  Akun #${r.index}: ${r.detail?.slice(0,80) || "-"}`));
  }
  console.log("═════════════════════════════\n");
}

main().catch(e => { log(`Fatal: ${e.message}`, "err"); process.exit(1); });
