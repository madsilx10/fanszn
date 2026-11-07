const fs       = require("fs");
const https    = require("https");
const readline = require("readline");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const ACCTS_FILE = "akun.txt";
const REF        = "FAN-3CVF";
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

// ─── CORE: CONNECT X ──────────────────────────────────────────────────────────
async function connectX(account) {
  const { authToken, ct0, index } = account;
  log(`Akun #${index} — mulai...`);

  try {
    // ── Step 1: GET /api/fanszn/auth/x/start → dapat redirect ke Twitter ─────
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

    // Follow redirect manual (301 twitter.com → x.com)
    let xAuthUrl = startRes.headers?.location;
    if (!xAuthUrl) {
      log(`Akun #${index} — start status: ${startRes.status} | ${JSON.stringify(startRes.body)?.slice(0,200)}`, "warn");
      throw new Error("Tidak dapat redirect dari auth/x/start");
    }

    // Kalau masih twitter.com, resolve ke x.com
    xAuthUrl = xAuthUrl.replace("https://twitter.com/", "https://x.com/");
    log(`Akun #${index} — Twitter URL: ${xAuthUrl.slice(0, 70)}...`);

    const urlObj = new URL(xAuthUrl);
    const state  = urlObj.searchParams.get("state");

    // ── Step 2: GET /i/api/2/oauth2/authorize → dapat auth_code (JSON) ───────
    // KEY INSIGHT dari aka.js: path-nya /i/api/2/ bukan /i/
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

    log(`Akun #${index} — GET oauth2 [${getRes.status}]: ${JSON.stringify(getRes.body)?.slice(0, 200)}`);

    const authCode = getRes.body?.auth_code;
    if (!authCode) {
      throw new Error(`Tidak dapat auth_code (status=${getRes.status})`);
    }
    log(`Akun #${index} — auth_code: ${authCode.slice(0, 20)}...`);

    // ── Step 3: POST api.x.com/2/oauth2/authorize → dapat redirect_uri ───────
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

    log(`Akun #${index} — approve [${approveRes.status}]: ${JSON.stringify(approveRes.body)?.slice(0, 200)}`);

    const redirectUri = approveRes.body?.redirect_uri;
    if (!redirectUri) {
      throw new Error(`Tidak dapat redirect_uri (status=${approveRes.status})`);
    }

    const oauthCode = new URL(redirectUri).searchParams.get("code");
    if (!oauthCode) throw new Error("Tidak ada code di redirect_uri");

    log(`Akun #${index} — oauth code: ${oauthCode.slice(0, 20)}...`);

    // ── Step 4: GET /api/fanszn/auth/x/callback ───────────────────────────────
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

    log(`Akun #${index} — callback [${cbRes.status}]: loc=${cbRes.headers?.location?.slice(0,80) || "none"} | body=${JSON.stringify(cbRes.body)?.slice(0,150)}`);

    // Session cookie dari callback
    const rawCookies = [].concat(cbRes.headers?.["set-cookie"] || []);
    const sessionCookie = rawCookies.map(c => c.split(";")[0]).join("; ");

    // ── Step 5: Verifikasi via /api/fanszn/me ─────────────────────────────────
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

    log(`Akun #${index} — me [${meRes.status}]: ${JSON.stringify(meRes.body)?.slice(0, 200)}`);

    if (meRes.status === 200 && meRes.body?.success !== false) {
      const handle = meRes.body?.me?.handle || meRes.body?.handle || "?";
      log(`Akun #${index} — ✓ Connected! (@${handle})`, "ok");
      return { index, status: "ok", handle };
    }

    // Fallback: callback redirect ke fanszn = sukses
    const loc = cbRes.headers?.location || "";
    if (loc.includes("fanszn")) {
      log(`Akun #${index} — ✓ Callback redirect ke FansZN`, "ok");
      return { index, status: "ok" };
    }

    return { index, status: "unknown", detail: `me=${meRes.status}` };

  } catch (err) {
    log(`Akun #${index} — ERROR: ${err.message}`, "err");
    return { index, status: "err", detail: err.message };
  }
}

// ─── MENU ─────────────────────────────────────────────────────────────────────
async function showMenu(accounts) {
  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  console.log("\n╔══════════════════════════════╗");
  console.log("║   FansZN — Connect X Bot     ║");
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
    const result = await connectX(targets[i]);
    results.push(result);
    if (i < targets.length - 1) {
      const cd = Math.floor(Math.random() * 3000) + DELAY_MS;
      log(`Delay ${(cd/1000).toFixed(1)}s...`);
      await sleep(cd);
    }
  }

  console.log("\n══════════ SUMMARY ══════════");
  const ok  = results.filter(r => r.status === "ok").length;
  const err = results.filter(r => r.status === "err").length;
  const unk = results.filter(r => r.status === "unknown").length;
  console.log(`  ✓ Berhasil : ${ok}`);
  console.log(`  ✗ Error    : ${err}`);
  console.log(`  ⚠ Unknown : ${unk}`);
  if (err || unk) {
    results.filter(r => r.status !== "ok")
      .forEach(r => console.log(`  Akun #${r.index} [${r.status}]: ${r.detail || "-"}`));
  }
  console.log("═════════════════════════════\n");
}

main().catch(e => { log(`Fatal: ${e.message}`, "err"); process.exit(1); });
