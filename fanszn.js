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
  const BASE = "https://fanszn.ipx.exchange";
  const UA = "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

  log(`Akun #${index} — mulai connect X...`);

  // Simpan cookies FansZN session di sini
  let fansCookies = "";

  try {
    // ── Step 1: Ambil CSRF token dari NextAuth ────────────────────────────────
    const csrfRes = await fetch(`${BASE}/api/auth/csrf`, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Referer: `${BASE}/fanszn/pick?ref=FAN-3CVF`,
      },
    });

    // Simpan cookies dari response
    const setCookieHeaders = csrfRes.headers.getSetCookie?.() ||
      (csrfRes.headers.get("set-cookie") ? [csrfRes.headers.get("set-cookie")] : []);
    if (setCookieHeaders.length) {
      fansCookies = setCookieHeaders
        .map((c) => c.split(";")[0])
        .join("; ");
      log(`Akun #${index} — session cookies: ${fansCookies.slice(0, 60)}...`);
    }

    const csrfData = await csrfRes.json().catch(() => null);
    if (!csrfData?.csrfToken) {
      log(`Akun #${index} — CSRF response: ${JSON.stringify(csrfData)}`, "warn");
      throw new Error("Gagal ambil CSRF token");
    }
    const csrfToken = csrfData.csrfToken;
    log(`Akun #${index} — CSRF OK: ${csrfToken.slice(0, 20)}...`);

    // ── Step 2: POST ke NextAuth signin/twitter → dapat redirect ke X ────────
    const signinRes = await fetch(`${BASE}/api/auth/signin/twitter`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json, */*",
        Referer: `${BASE}/fanszn/pick?ref=FAN-3CVF`,
        Cookie: fansCookies,
      },
      body: new URLSearchParams({
        csrfToken,
        callbackUrl: `${BASE}/fanszn/pick?ref=FAN-3CVF`,
        json: "true",
      }).toString(),
      redirect: "manual",
    });

    // NextAuth bisa return JSON { url } atau redirect langsung
    let twitterAuthUrl = signinRes.headers.get("location");

    if (!twitterAuthUrl) {
      const signinBody = await signinRes.text().catch(() => "");
      try {
        const j = JSON.parse(signinBody);
        twitterAuthUrl = j.url || j.redirect_url;
      } catch (_) {}

      if (!twitterAuthUrl) {
        log(`Akun #${index} — signin status: ${signinRes.status} | body: ${signinBody.slice(0, 300)}`, "warn");
        throw new Error("Tidak dapat Twitter OAuth URL dari NextAuth");
      }
    }

    // Update cookies kalau ada
    const signinCookies = signinRes.headers.getSetCookie?.() ||
      (signinRes.headers.get("set-cookie") ? [signinRes.headers.get("set-cookie")] : []);
    if (signinCookies.length) {
      const newCookies = signinCookies.map((c) => c.split(";")[0]).join("; ");
      fansCookies = mergeCookies(fansCookies, newCookies);
    }

    log(`Akun #${index} — Twitter OAuth URL: ${twitterAuthUrl.slice(0, 80)}...`);

    // ── Step 3: Hit Twitter OAuth URL pakai cookies akun ─────────────────────
    const twitterRes = await fetch(twitterAuthUrl, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        Cookie: `auth_token=${authToken}; ct0=${ct0}`,
        "X-Csrf-Token": ct0,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Referer: "https://twitter.com/",
      },
      redirect: "manual",
    });

    let callbackUrl = twitterRes.headers.get("location");

    if (!callbackUrl) {
      const twitterBody = await twitterRes.text().catch(() => "");
      log(`Akun #${index} — Twitter status: ${twitterRes.status} | body: ${twitterBody.slice(0, 400)}`, "warn");
      throw new Error("Tidak ada callback redirect dari Twitter/X");
    }

    // Kalau callback URL relative, tambah base Twitter
    if (callbackUrl.startsWith("/")) {
      callbackUrl = `https://twitter.com${callbackUrl}`;
    }

    log(`Akun #${index} — callback: ${callbackUrl.slice(0, 100)}...`);

    // ── Step 4: Follow callback ke FansZN ─────────────────────────────────────
    const callbackRes = await fetch(callbackUrl, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        Cookie: fansCookies,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: "https://twitter.com/",
      },
      redirect: "follow",
    });

    const callbackBody = await callbackRes.text().catch(() => "");
    const finalUrl = callbackRes.url;

    log(`Akun #${index} — final URL: ${finalUrl}`);

    const success =
      finalUrl.includes("fanszn") ||
      callbackBody.toLowerCase().includes("fan card") ||
      callbackBody.toLowerCase().includes("pick your fandom") ||
      callbackBody.toLowerCase().includes("step 2") ||
      callbackRes.ok;

    if (success) {
      log(`Akun #${index} — ✓ X berhasil di-connect!`, "ok");
      return { index, status: "ok" };
    } else {
      log(`Akun #${index} — final status: ${callbackRes.status} | preview: ${callbackBody.slice(0, 200)}`, "warn");
      return { index, status: "unknown", detail: `status ${callbackRes.status}` };
    }

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
