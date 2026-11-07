const fs       = require("fs");
const https    = require("https");
const readline = require("readline");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const ACCTS_FILE  = "akun.txt";
const REF         = "FAN-3CVF";
const FANDOM_ID   = "metal";
const FOLLOW_USER = "IPXExchange";
const BASE_FANSZN = "fanszn.ipx.exchange";
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

// ─── CONNECT X (dari file lo yang jalan) ─────────────────────────────────────
async function connectX(account) {
  const { authToken, ct0, index } = account;

  // Step 1: GET auth/x/start → redirect ke Twitter
  const startRes = await request({
    hostname: BASE_FANSZN,
    path: `/api/fanszn/auth/x/start?returnTo=%2Ffanszn%2Fconnect&ref=${REF}`,
    method: "GET",
    headers: {
      accept: "*/*",
      "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      referer: `https://${BASE_FANSZN}/fanszn/pick?ref=${REF}`,
    },
  });

  let xAuthUrl = startRes.headers?.location;
  if (!xAuthUrl) throw new Error(`auth/x/start gagal (${startRes.status})`);
  xAuthUrl = xAuthUrl.replace("https://twitter.com/", "https://x.com/");

  const urlObj = new URL(xAuthUrl);
  const state  = urlObj.searchParams.get("state");
  log(`Akun #${index} — Twitter URL ok`);

  // Step 2: GET /i/api/2/oauth2/authorize → auth_code
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

  // Step 3: POST api.x.com/2/oauth2/authorize → redirect_uri
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

  // Step 4: GET callback (sama persis kayak versi lo yang jalan)
  const cbState = new URL(redirectUri).searchParams.get("state") || state;
  const cbRes = await request({
    hostname: BASE_FANSZN,
    path: `/api/fanszn/auth/x/callback?state=${encodeURIComponent(cbState)}&code=${encodeURIComponent(oauthCode)}`,
    method: "GET",
    headers: {
      accept: "*/*",
      "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      referer: "https://x.com/",
    },
  });

  log(`Akun #${index} — callback [${cbRes.status}]: loc=${cbRes.headers?.location?.slice(0,80) || "none"}`);

  // Ambil session cookie (mungkin kosong, tapi tetap lanjut)
  const rawCookies = [].concat(cbRes.headers?.["set-cookie"] || []);
  const sessionCookie = rawCookies.map(c => c.split(";")[0]).join("; ");

  // Step 5: Verifikasi /me
  const meRes = await request({
    hostname: BASE_FANSZN,
    path: "/api/fanszn/me",
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      cookie: sessionCookie,
      referer: `https://${BASE_FANSZN}/fanszn/connect`,
    },
  });

  log(`Akun #${index} — me [${meRes.status}]: ${JSON.stringify(meRes.body)?.slice(0,150)}`);

  if (meRes.status === 200 && meRes.body?.success !== false) {
    const handle = meRes.body?.me?.handle || meRes.body?.handle || "?";
    log(`Akun #${index} — ✓ Connected! (@${handle})`, "ok");
    return { ok: true, sessionCookie, handle };
  }

  const loc = cbRes.headers?.location || "";
  if (loc.includes("fanszn")) {
    log(`Akun #${index} — ✓ Callback redirect ke FansZN`, "ok");
    return { ok: true, sessionCookie, handle: "?" };
  }

  throw new Error(`Connect X gagal: me=${meRes.status}`);
}

// ─── FANSZN API HELPERS ───────────────────────────────────────────────────────
function fansznReq(sessionCookie, path, method, body, referer) {
  const bodyStr = body ? JSON.stringify(body) : null;
  return request({
    hostname: BASE_FANSZN,
    path,
    method,
    headers: {
      "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      accept: "*/*",
      "accept-encoding": "gzip, deflate, br, zstd",
      "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      "content-type": "application/json",
      "content-length": bodyStr ? Buffer.byteLength(bodyStr) : 0,
      cookie: sessionCookie,
      origin: "https://fanszn.ipx.exchange",
      referer: `https://${BASE_FANSZN}${referer}`,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "sec-ch-ua": '"Mises";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      "sec-ch-ua-mobile": "?1",
      "sec-ch-ua-platform": '"Android"',
    },
  }, bodyStr);
}

// ─── PROCESS 1 AKUN ───────────────────────────────────────────────────────────
async function processAccount(account) {
  const { authToken, ct0, index } = account;
  log(`\n${"─".repeat(45)}`);
  log(`Akun #${index} — mulai...`);

  try {
    // 1. Cek & follow Twitter
    log(`Akun #${index} — cek follow @${FOLLOW_USER}...`);
    const alreadyFollow = await checkFollowing(authToken, ct0).catch(() => false);
    if (alreadyFollow) {
      log(`Akun #${index} — sudah follow @${FOLLOW_USER}`, "warn");
    } else {
      const followed = await followUser(authToken, ct0);
      log(`Akun #${index} — follow: ${followed ? "✓" : "gagal"}`, followed ? "ok" : "warn");
      await sleep(1500);
    }

    // 2. Connect X
    log(`Akun #${index} — connect X...`);
    const { sessionCookie, handle } = await connectX(account);
    await sleep(1000);

    // 3. Pilih fandom
    log(`Akun #${index} — pilih fandom: ${FANDOM_ID}...`);
    const fandomRes = await fansznReq(sessionCookie, "/api/fanszn/fandom", "POST", { fandomId: FANDOM_ID }, "/fanszn/pick?connected=1&new=1");
    log(`Akun #${index} — fandom [${fandomRes.status}]: ${JSON.stringify(fandomRes.body)?.slice(0,80)}`, fandomRes.status === 200 ? "ok" : "warn");
    await sleep(1000);

    // 4. FansZN follow trigger
    log(`Akun #${index} — fanszn follow trigger...`);
    const followRes = await fansznReq(sessionCookie, "/api/fanszn/follow", "GET", null, "/fanszn/connect");
    log(`Akun #${index} — fanszn follow [${followRes.status}]`, followRes.status === 200 ? "ok" : "warn");
    await sleep(1000);

    // 5. Fan check quiz
    log(`Akun #${index} — mulai fan check quiz...`);
    const startRes = await fansznReq(sessionCookie, "/api/fanszn/check", "POST", { action: "start" }, "/fanszn/check?start=1");
    if (!startRes.body?.success) {
      log(`Akun #${index} — check start: ${JSON.stringify(startRes.body)?.slice(0,100)}`, "warn");
    } else {
      const total = startRes.body?.attempt?.total || 7;
      log(`Akun #${index} — quiz: ${total} soal`);

      for (let i = 0; i < total; i++) {
        await sleep(Math.floor(Math.random() * 3000) + 2000);
        const chosen = Math.floor(Math.random() * 4);
        const ansRes = await fansznReq(sessionCookie, "/api/fanszn/check", "POST",
          { action: "answer", index: i, chosen },
          "/fanszn/check?start=1"
        );
        const att = ansRes.body?.attempt;
        log(`Akun #${index} — soal ${i+1}/${total} chosen:${chosen} correct:${att?.correct ?? "?"} aura:${att?.baseAura ?? "?"}`);
        if (att?.finished) { log(`Akun #${index} — quiz selesai!`); break; }
      }
    }
    await sleep(1500);

    // 6. Get card
    const cardRes = await fansznReq(sessionCookie, "/api/fanszn/card", "GET", null, "/fanszn/card?fresh=1");
    if (cardRes.body?.success) {
      const c = cardRes.body.card;
      log(`Akun #${index} — card: aura=${c?.aura} rank=${c?.rank} fandom=${c?.fandom?.name}`, "ok");
    }
    await sleep(1000);

    // 7. Check in
    log(`Akun #${index} — check in...`);
    const ciRes = await fansznReq(sessionCookie, "/api/fanszn/checkin", "POST", null, "/fanszn/hub");
    log(`Akun #${index} — checkin [${ciRes.status}]: ${JSON.stringify(ciRes.body)?.slice(0,80)}`, ciRes.body?.success ? "ok" : "warn");

    log(`Akun #${index} — ✓ DONE! (@${handle})`, "ok");
    return { index, status: "ok", handle };

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
  if (err) results.filter(r => r.status !== "ok")
    .forEach(r => console.log(`  Akun #${r.index}: ${r.detail?.slice(0,80) || "-"}`));
  console.log("═════════════════════════════\n");
}

main().catch(e => { log(`Fatal: ${e.message}`, "err"); process.exit(1); });
