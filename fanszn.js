const fs = require("fs");
const readline = require("readline");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const REF_LINK = "https://fanszn.ipx.exchange/i/FAN-3CVF";
const ACCTS_FILE = "akun.txt";
const DELAY_MS = 2000; // jeda antar akun (ms)
const DEBUG = process.argv.includes("--debug");

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg, type = "info") {
  const icons = { info: "·", ok: "✓", err: "✗", warn: "⚠" };
  console.log(`[${icons[type] || "·"}] ${msg}`);
}

function loadAccounts() {
  if (!fs.existsSync(ACCTS_FILE)) {
    console.error(`File ${ACCTS_FILE} tidak ditemukan!`);
    process.exit(1);
  }

  const raw = fs.readFileSync(ACCTS_FILE, "utf8");

  // Split per blok (dipisah baris kosong)
  const blocks = raw
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const accounts = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const authToken = lines[0];
    const ct0 = lines[1];
    if (authToken && ct0) {
      accounts.push({ authToken, ct0, index: accounts.length + 1 });
    }
  }

  return accounts;
}

// ─── DEBUG: PROBE ENDPOINTS ───────────────────────────────────────────────────
async function probeEndpoints() {
  const BASE = "https://fanszn.ipx.exchange";
  const UA = "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

  // Step 1: Ambil HTML halaman, extract semua _next/static JS chunk URLs
  console.log("Fetching page HTML...");
  const pageRes = await fetch(`${BASE}/fanszn/pick`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  const html = await pageRes.text();

  // Extract semua script src
  const scriptMatches = [...html.matchAll(/src="([^"]*\.js[^"]*)"/g)];
  const scriptUrls = scriptMatches
    .map((m) => m[1])
    .filter((u) => u.includes("_next") || u.includes("chunk") || u.includes("app") || u.includes("page"))
    .map((u) => u.startsWith("http") ? u : `${BASE}${u}`);

  console.log(`\nFound ${scriptUrls.length} script(s):\n${scriptUrls.join("\n")}`);

  // Step 2: Download tiap chunk, cari string auth/twitter/signin/oauth
  console.log("\n══ Scanning JS bundles for auth endpoints ══");
  const keywords = ["signin", "twitter", "oauth", "auth", "/api/", "callback", "csrf", "token"];

  for (const url of scriptUrls) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      const src = await r.text();

      // Cari semua string yang mirip API path
      const paths = [...src.matchAll(/["'`](\/[a-zA-Z0-9/_\-\.?=&%]+)["'`]/g)]
        .map((m) => m[1])
        .filter((p) => keywords.some((k) => p.toLowerCase().includes(k)));

      if (paths.length) {
        console.log(`\n[${url.split("/").pop()}]`);
        // Dedup dan print
        [...new Set(paths)].slice(0, 30).forEach((p) => console.log(`  ${p}`));
      }
    } catch (e) {
      console.log(`ERR fetching ${url}: ${e.message}`);
    }
  }
  console.log("\n═════════════════════════\n");
}

// ─── CORE: CONNECT X ──────────────────────────────────────────────────────────
async function connectX(account) {
  const { authToken, ct0, index } = account;
  const BASE  = "https://fanszn.ipx.exchange";
  const UA    = "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
  const REF   = "FAN-3CVF";

  // Cookie jar FansZN session
  let jar = "";

  const setCookies = (res) => {
    const raw = res.headers.getSetCookie?.() ||
      (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
    if (raw.length) jar = mergeCookies(jar, raw.map(c => c.split(";")[0]).join("; "));
  };

  log(`Akun #${index} — mulai...`);

  try {
    // ── Step 1: GET /api/fanszn/auth/x/start → redirect ke Twitter OAuth ─────
    // URL persis dari fungsi kq() di source: /api/fanszn/auth/x/start?returnTo=...&ref=...
    const startUrl = `${BASE}/api/fanszn/auth/x/start?returnTo=%2Ffanszn%2Fconnect&ref=${REF}`;

    const startRes = await fetch(startUrl, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,*/*",
        Referer: `${BASE}/fanszn/pick?ref=${REF}`,
        Cookie: jar,
      },
      redirect: "manual",
    });

    setCookies(startRes);

    let twitterAuthUrl = startRes.headers.get("location");

    if (!twitterAuthUrl) {
      const body = await startRes.text().catch(() => "");
      log(`Akun #${index} — start status: ${startRes.status} | body: ${body.slice(0, 300)}`, "warn");
      throw new Error("Tidak dapat redirect Twitter dari /auth/x/start");
    }

    // Resolve relative URL kalau ada
    if (twitterAuthUrl.startsWith("/")) twitterAuthUrl = `${BASE}${twitterAuthUrl}`;

    log(`Akun #${index} — Twitter URL: ${twitterAuthUrl.slice(0, 80)}...`);

    // ── Step 2: GET halaman OAuth Twitter, follow redirect sampai dapat form ──
    const twitterHeaders = {
      "User-Agent": UA,
      Cookie: `auth_token=${authToken}; ct0=${ct0}`,
      "X-Csrf-Token": ct0,
      Accept: "text/html,application/xhtml+xml,*/*",
      "Accept-Language": "en-US,en;q=0.5",
      Referer: "https://x.com/",
    };

    // Follow redirect manual sampai dapat halaman yang bukan twitter.com -> x.com redirect
    // atau sampai dapat callback ke fanszn
    let currentUrl = twitterAuthUrl;
    let oauthPageRes, oauthHtml = "", twitterCookies = "";
    let callbackUrl = null;

    for (let hop = 0; hop < 5; hop++) {
      oauthPageRes = await fetch(currentUrl, {
        method: "GET",
        headers: { ...twitterHeaders, Referer: hop === 0 ? `${BASE}/fanszn/pick` : currentUrl },
        redirect: "manual",
      });

      const loc = oauthPageRes.headers.get("location");
      const rawCookies = oauthPageRes.headers.getSetCookie?.() ||
        (oauthPageRes.headers.get("set-cookie") ? [oauthPageRes.headers.get("set-cookie")] : []);
      if (rawCookies.length) {
        twitterCookies = mergeCookies(twitterCookies, rawCookies.map(c => c.split(";")[0]).join("; "));
      }

      log(`Akun #${index} — hop${hop} [${oauthPageRes.status}] ${currentUrl.slice(0, 60)}... → ${loc ? loc.slice(0, 60) + "..." : "no-redirect"}`);

      if (!loc) {
        // Dapat halaman HTML — ini halaman OAuth authorize
        oauthHtml = await oauthPageRes.text().catch(() => "");
        break;
      }

      const resolvedLoc = loc.startsWith("/") ? new URL(loc, currentUrl).href : loc;

      // Kalau redirect ke callback FansZN (harus ada ?code= atau /callback)
      if (resolvedLoc.includes("fanszn.ipx.exchange") && (resolvedLoc.includes("code=") || resolvedLoc.includes("/callback"))) {
        callbackUrl = resolvedLoc;
        log(`Akun #${index} — langsung dapat callback FansZN!`);
        break;
      }

      currentUrl = resolvedLoc;
    }

    if (!callbackUrl) {
      // oauthHtml & twitterCookies sudah di-set di dalam loop di atas
      log(`Akun #${index} — OAuth2 PKCE flow (status: ${oauthPageRes.status})`);

      // POST approve ke Twitter OAuth2
      const authUrl = new URL(currentUrl);
      const state   = authUrl.searchParams.get("state") || "";

      const approveRes = await fetch("https://x.com/i/oauth2/authorize", {
        method: "POST",
        headers: {
          ...twitterHeaders,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `auth_token=${authToken}; ct0=${ct0}; ${twitterCookies}`,
          "X-Csrf-Token": ct0,
          Origin: "https://x.com",
          Referer: currentUrl,
        },
        body: new URLSearchParams({
          approval:              "true",
          code_challenge:        authUrl.searchParams.get("code_challenge")        || "",
          code_challenge_method: authUrl.searchParams.get("code_challenge_method") || "S256",
          client_id:             authUrl.searchParams.get("client_id")             || "",
          redirect_uri:          authUrl.searchParams.get("redirect_uri")          || "",
          response_type:         "code",
          scope:                 authUrl.searchParams.get("scope")                 || "",
          state,
        }).toString(),
        redirect: "manual",
      });

      callbackUrl = approveRes.headers.get("location");
      log(`Akun #${index} — approve [${approveRes.status}] loc: ${callbackUrl?.slice(0, 80) || "none"}`);

      if (!callbackUrl) {
        const approveBody = await approveRes.text().catch(() => "");
        // Twitter OAuth2 kadang return JSON dengan redirect_uri atau auth_code
        try {
          const j = JSON.parse(approveBody);
          if (j.redirect_uri || j.location || j.url) {
            callbackUrl = j.redirect_uri || j.location || j.url;
          } else if (j.auth_code) {
            const redir = authUrl.searchParams.get("redirect_uri") || "";
            callbackUrl = `${redir}?code=${j.auth_code}&state=${encodeURIComponent(state)}`;
          }
        } catch (_) {}

        if (!callbackUrl) {
          log(`Akun #${index} — approve body: ${approveBody.slice(0, 400)}`, "warn");
          throw new Error(`Gagal approve OAuth2 Twitter (status ${approveRes.status})`);
        }
      }

      if (callbackUrl.startsWith("/")) callbackUrl = `https://x.com${callbackUrl}`;
    }

    log(`Akun #${index} — callback: ${callbackUrl?.slice(0, 100)}...`);

    // ── Step 3: Follow callback → FansZN /auth/handle ────────────────────────
    const callbackRes = await fetch(callbackUrl, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        Cookie: jar,
        Accept: "text/html,application/xhtml+xml,*/*",
        Referer: "https://x.com/",
      },
      redirect: "follow",
    });

    setCookies(callbackRes);

    const finalUrl  = callbackRes.url;
    const finalBody = await callbackRes.text().catch(() => "");

    log(`Akun #${index} — final URL: ${finalUrl}`);

    // ── Step 4: Verifikasi session via /api/fanszn/me ─────────────────────────
    const meRes  = await fetch(`${BASE}/api/fanszn/me`, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Cookie: jar,
        Referer: `${BASE}/fanszn/connect`,
      },
    });
    const meData = await meRes.json().catch(() => null);

    if (meRes.ok && meData?.success !== false) {
      const handle = meData?.me?.handle || meData?.handle || "?";
      log(`Akun #${index} — ✓ Connected! (@${handle})`, "ok");
      return { index, status: "ok", handle };
    }

    // Fallback cek dari final URL
    if (finalUrl.includes("/fanszn/connect") || finalUrl.includes("/fanszn/hub") || finalUrl.includes("/fanszn/pick")) {
      log(`Akun #${index} — ✓ Redirect ke FansZN (session OK)`, "ok");
      return { index, status: "ok" };
    }

    log(`Akun #${index} — me status: ${meRes.status} | ${JSON.stringify(meData)?.slice(0, 150)}`, "warn");
    return { index, status: "unknown", detail: `me=${meRes.status}` };

  } catch (err) {
    log(`Akun #${index} — ERROR: ${err.message}`, "err");
    return { index, status: "err", detail: err.message };
  }
}

// Merge dua string cookies (key=value; key=value)
function mergeCookies(existing, incoming) {
  const map = new Map();
  for (const part of (existing + "; " + incoming).split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) map.set(k.trim(), v.join("=").trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// ─── MENU ─────────────────────────────────────────────────────────────────────
async function showMenu(accounts) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q) => new Promise((res) => rl.question(q, res));

  console.log("\n╔══════════════════════════════╗");
  console.log("║   FansZN — Connect X Bot     ║");
  console.log("╚══════════════════════════════╝");
  console.log(`  Total akun loaded: ${accounts.length}\n`);
  console.log("  [1] 1 Akun (pilih nomor)");
  console.log("  [2] Semua akun");
  console.log("  [3] From X to end\n");

  const choice = await ask("Pilih opsi (1/2/3): ");

  let targets = [];

  if (choice === "1") {
    const num = await ask(`Masukkan nomor akun (1-${accounts.length}): `);
    const idx = parseInt(num);
    if (isNaN(idx) || idx < 1 || idx > accounts.length) {
      console.log("Nomor invalid.");
      rl.close();
      process.exit(1);
    }
    targets = [accounts[idx - 1]];
  } else if (choice === "2") {
    targets = accounts;
  } else if (choice === "3") {
    const from = await ask(
      `From akun nomor berapa? (1-${accounts.length}): `
    );
    const startIdx = parseInt(from) - 1;
    if (isNaN(startIdx) || startIdx < 0 || startIdx >= accounts.length) {
      console.log("Nomor invalid.");
      rl.close();
      process.exit(1);
    }
    targets = accounts.slice(startIdx);
    console.log(
      `  → Akun #${startIdx + 1} sampai #${accounts.length} (${targets.length} akun)`
    );
  } else {
    console.log("Pilihan tidak valid.");
    rl.close();
    process.exit(1);
  }

  rl.close();
  return targets;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  if (DEBUG) {
    await probeEndpoints();
    process.exit(0);
  }

  const accounts = loadAccounts();

  if (accounts.length === 0) {
    log("Tidak ada akun di akun.txt!", "err");
    process.exit(1);
  }

  const targets = await showMenu(accounts);

  console.log(`\n→ Proses ${targets.length} akun...\n`);

  const results = [];

  for (let i = 0; i < targets.length; i++) {
    const acct = targets[i];
    const result = await connectX(acct);
    results.push(result);

    if (i < targets.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  // ─── SUMMARY ───────────────────────────────────────────────────────────────
  console.log("\n══════════ SUMMARY ══════════");
  const ok = results.filter((r) => r.status === "ok").length;
  const err = results.filter((r) => r.status === "err").length;
  const unk = results.filter((r) => r.status === "unknown").length;

  console.log(`  ✓ Berhasil  : ${ok}`);
  console.log(`  ✗ Error     : ${err}`);
  console.log(`  ⚠ Unknown  : ${unk}`);

  if (err > 0 || unk > 0) {
    console.log("\n  Detail:");
    results
      .filter((r) => r.status !== "ok")
      .forEach((r) =>
        console.log(
          `  Akun #${r.index} [${r.status}]: ${r.detail || "-"}`
        )
      );
  }

  console.log("═════════════════════════════\n");
}

main().catch((err) => {
  log(`Fatal: ${err.message}`, "err");
  process.exit(1);
});
