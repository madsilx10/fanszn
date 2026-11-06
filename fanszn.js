const fs = require("fs");
const readline = require("readline");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const REF_LINK = "https://fanszn.ipx.exchange/i/FAN-3CVF";
const ACCTS_FILE = "akun.txt";
const DELAY_MS = 2000; // jeda antar akun (ms)

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

// ─── CORE: CONNECT X ──────────────────────────────────────────────────────────
async function connectX(account) {
  const { authToken, ct0, index } = account;

  log(`Akun #${index} — mulai connect X...`);

  try {
    // Step 1: Hit ref link dulu buat dapet session / redirect
    const refRes = await fetch(REF_LINK, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      redirect: "follow",
    });

    const refUrl = refRes.url; // URL akhir setelah redirect
    log(`Akun #${index} — landed: ${refUrl}`);

    // Step 2: Request X OAuth dari FansZN
    // Ambil base origin dari URL final
    const origin = new URL(refUrl).origin;

    const oauthRes = await fetch(`${origin}/api/auth/twitter`, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36",
        Referer: refUrl,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.5",
      },
      redirect: "manual",
    });

    // Ambil redirect URL ke Twitter/X
    const twitterAuthUrl =
      oauthRes.headers.get("location") ||
      (await oauthRes
        .json()
        .then((j) => j.url || j.redirect_url)
        .catch(() => null));

    if (!twitterAuthUrl) {
      // Coba parse response body
      const body = await oauthRes.text().catch(() => "");
      log(`Akun #${index} — response: ${body.slice(0, 200)}`, "warn");
      throw new Error("Tidak dapat oauth URL dari FansZN");
    }

    log(`Akun #${index} — Twitter auth URL: ${twitterAuthUrl.slice(0, 80)}...`);

    // Step 3: Hit Twitter OAuth URL pakai cookies akun
    const twitterRes = await fetch(twitterAuthUrl, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36",
        Cookie: `auth_token=${authToken}; ct0=${ct0}`,
        Authorization: `Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I6xUEXAMPLE`,
        "X-Csrf-Token": ct0,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "manual",
    });

    const callbackUrl = twitterRes.headers.get("location");

    if (!callbackUrl) {
      const body = await twitterRes.text().catch(() => "");
      log(
        `Akun #${index} — Twitter response status: ${twitterRes.status}`,
        "warn"
      );
      log(`Akun #${index} — body preview: ${body.slice(0, 300)}`, "warn");
      throw new Error("Tidak ada callback redirect dari Twitter");
    }

    log(
      `Akun #${index} — callback: ${callbackUrl.slice(0, 80)}...`,
      callbackUrl.includes("fanszn") ? "ok" : "warn"
    );

    // Step 4: Hit callback URL ke FansZN
    const callbackRes = await fetch(callbackUrl, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36",
        Accept: "application/json, text/plain, */*",
        Referer: "https://twitter.com/",
      },
      redirect: "follow",
    });

    const callbackBody = await callbackRes.text().catch(() => "");
    const success =
      callbackRes.ok ||
      callbackBody.toLowerCase().includes("success") ||
      callbackBody.toLowerCase().includes("connected") ||
      callbackBody.toLowerCase().includes("linked");

    if (success) {
      log(`Akun #${index} — X berhasil di-connect! ✓`, "ok");
      return { index, status: "ok" };
    } else {
      log(
        `Akun #${index} — callback response (${callbackRes.status}): ${callbackBody.slice(0, 200)}`,
        "warn"
      );
      return { index, status: "unknown", detail: callbackBody.slice(0, 100) };
    }
  } catch (err) {
    log(`Akun #${index} — ERROR: ${err.message}`, "err");
    return { index, status: "err", detail: err.message };
  }
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
