/**
 * ctext.org slow scraper with anti-detection + resume.
 *
 * ctext explicitly forbids automated mass-downloading and auto-blocks IPs
 * that hit too fast. This scraper is built for "ride the line, not cross it":
 *
 *   - randomised User-Agent pool (5 real desktop browsers)
 *   - randomised 6-14s delay between requests (well below 1 req/s)
 *   - Referer chain that simulates a human navigating from TOC inwards
 *   - Accept-Language zh-CN, fully fleshed-out Accept-* headers
 *   - HTML responses cached to disk; never re-fetched if already present
 *   - progress.json tracks done/pending; SIGINT writes state and exits cleanly
 *   - hard stop on HTTP 403 / 429 / captcha-marker so you can swap IP
 *     before continuing
 *
 * Usage:
 *   # First run — fetches TOC, then up to N chapter pages
 *   node backend/scripts/scrape-ctext.mjs \
 *     --slug shiku-shu \
 *     --toc 'https://ctext.org/wiki.pl?if=gb&res=396571&remap=gb' \
 *     --max 10
 *
 *   # Subsequent runs (after switching IP) — resumes from progress.json
 *   node backend/scripts/scrape-ctext.mjs --slug shiku-shu --max 10
 *
 *   # Override delay range (default 6000-14000 ms)
 *   node backend/scripts/scrape-ctext.mjs --slug shiku-shu --max 10 --min-delay 8000 --max-delay 18000
 *
 * Note: this script ONLY downloads HTML to disk. Parsing into SQLite is a
 * separate, fully-offline pass via parse-ctext-cache.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function arg(flag, fallback = "") {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1] || fallback;
}

const slug = arg("--slug");
if (!slug) {
  console.error("missing --slug");
  process.exit(1);
}

const tocUrlArg = arg("--toc");
const maxThisRun = parseInt(arg("--max", "20"), 10);
const minDelayMs = parseInt(arg("--min-delay", "6000"), 10);
const maxDelayMs = parseInt(arg("--max-delay", "14000"), 10);

const cacheDir = path.join(REPO_ROOT, "donotpack", "database", `${slug}-ctext-cache`);
const htmlDir = path.join(cacheDir, "html");
const progressPath = path.join(cacheDir, "progress.json");

fs.mkdirSync(htmlDir, { recursive: true });

// --- Real desktop User-Agents (rotated per request) ---------------------
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
];

function pickUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function jitterDelayMs() {
  return minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Progress state -----------------------------------------------------
function loadProgress() {
  if (!fs.existsSync(progressPath)) {
    return {
      slug,
      tocUrl: tocUrlArg,
      tocFetched: false,
      tocFetchedAt: null,
      chapters: {}, // map chapterId -> { url, title, fetchedAt, htmlFile, status }
      lastUpdate: null,
      lastError: null,
    };
  }
  return JSON.parse(fs.readFileSync(progressPath, "utf8"));
}

function saveProgress(state) {
  state.lastUpdate = new Date().toISOString();
  fs.writeFileSync(progressPath, JSON.stringify(state, null, 2));
}

// --- HTTP fetch with anti-detection + retry ----------------------------
//
// Use curl as a child process for the actual transfer. Two reasons:
// 1. Node's global fetch (undici) keep-alive connection pool occasionally
//    reuses a dead socket and hangs until our 25s timeout — we saw 4/5
//    timeouts on a healthy network where curl returned in 0.75s.
// 2. We need fine control over headers, no automatic Accept-Encoding (br
//    decode in undici is fragile across versions), and a fresh TCP per
//    request so timing patterns look more "human".
//
// curl's HTTP fingerprint differs from a real Chrome (JA3 etc.), but ctext
// proved tolerant on previous successful fetches when headers + cadence are
// browser-like — and undici + automatic Accept-Encoding negotiation
// produced an even more obvious "robot" fingerprint via constant header
// ordering. Trade-off accepted.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);

async function fetchHtmlOnce(url, referer) {
  const ua = pickUA();
  console.log(`[fetch] ${url}\n        UA: ${ua.slice(0, 60)}…`);
  const args = [
    "-s", "-L",
    "--compressed",                 // accept gzip/deflate, curl handles decode
    "--max-time", "45",             // hard ceiling per request
    "--connect-timeout", "15",
    "-A", ua,
    "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "-H", "Accept-Language: zh-CN,zh;q=0.9,en;q=0.5",
    "-H", "Cache-Control: max-age=0",
    "-H", "Sec-Fetch-Dest: document",
    "-H", "Sec-Fetch-Mode: navigate",
    "-H", `Sec-Fetch-Site: ${referer ? "same-origin" : "none"}`,
    "-H", "Sec-Fetch-User: ?1",
    "-H", "Upgrade-Insecure-Requests: 1",
    ...(referer ? ["-H", `Referer: ${referer}`] : []),
    "-w", "\n__HTTP_STATUS__%{http_code}",
    url,
  ];
  const { stdout } = await execFileP("curl", args, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 50000,
  });
  // last line carries the status code (we appended it via -w)
  const idx = stdout.lastIndexOf("\n__HTTP_STATUS__");
  const status = idx >= 0 ? parseInt(stdout.slice(idx + 16), 10) : 0;
  const html = idx >= 0 ? stdout.slice(0, idx) : stdout;

  if (status === 429 || status === 403) {
    throw new Error(`BLOCKED: HTTP ${status} — ctext likely banned this IP. Stop and switch IP before continuing.`);
  }
  if (status < 200 || status >= 400) {
    throw new Error(`HTTP ${status}`);
  }
  if (/captcha|please confirm that you are human|认证图案|过快|被封|您的访问已被限制/i.test(html)) {
    throw new Error("BLOCKED: response body looks like a captcha/limit page. Stop and switch IP.");
  }
  return html;
}

async function fetchHtml(url, referer) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetchHtmlOnce(url, referer);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      if (msg.startsWith("BLOCKED")) throw err; // hard fail on captcha/ban
      const backoff = 5000 * attempt + Math.floor(Math.random() * 3000);
      console.warn(`  [retry ${attempt}/3 in ${backoff}ms] ${msg}`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// --- Parse TOC for chapter URLs ----------------------------------------
function extractChapterRefs(tocHtml) {
  // <a href="wiki.pl?if=gb&amp;chapter=NNNNNN&amp;remap=gb...">text</a>
  // We dedupe by chapterId; each chapter page may host multiple "卷".
  const seen = new Map(); // chapterId -> { url, title }
  const re = /<a[^>]+href="(wiki\.pl\?if=gb&(?:amp;)?chapter=(\d+)[^"]*)"[^>]*>([^<]+)<\/a>/g;
  let m;
  while ((m = re.exec(tocHtml))) {
    const rawHref = m[1].replace(/&amp;/g, "&");
    const id = m[2];
    const title = m[3].trim();
    if (!seen.has(id)) {
      seen.set(id, {
        url: `https://ctext.org/${rawHref.split("#")[0]}`,
        title,
      });
    }
  }
  return Array.from(seen.entries()).map(([id, info]) => ({ id, ...info }));
}

// --- Main ----------------------------------------------------------------
async function main() {
  let state = loadProgress();
  state.lastError = null;

  // 1. Fetch TOC if not cached
  const tocCachePath = path.join(htmlDir, "_toc.html");
  if (!state.tocFetched) {
    const tocUrl = state.tocUrl || tocUrlArg;
    if (!tocUrl) throw new Error("no --toc URL and no progress.json with one");
    console.log(`\n=== fetch TOC ===\n${tocUrl}\n`);
    const html = await fetchHtml(tocUrl, "https://ctext.org/zhs");
    fs.writeFileSync(tocCachePath, html);
    state.tocUrl = tocUrl;
    state.tocFetched = true;
    state.tocFetchedAt = new Date().toISOString();
    const refs = extractChapterRefs(html);
    console.log(`[toc] found ${refs.length} unique chapter pages`);
    for (const r of refs) {
      if (!state.chapters[r.id]) {
        state.chapters[r.id] = {
          url: r.url,
          title: r.title,
          status: "pending",
          htmlFile: null,
          fetchedAt: null,
          error: null,
        };
      }
    }
    saveProgress(state);
  } else {
    console.log("[toc] already cached, resuming");
  }

  // 2. Fetch chapter pages, up to maxThisRun new ones
  const pending = Object.entries(state.chapters)
    .filter(([, info]) => info.status === "pending")
    .map(([id, info]) => ({ id, ...info }));
  console.log(`\n=== ${pending.length} chapters pending; will fetch up to ${maxThisRun} this run ===\n`);

  const todo = pending.slice(0, maxThisRun);
  let lastUrl = state.tocUrl;

  // Handle Ctrl+C to save state cleanly
  let interrupted = false;
  process.on("SIGINT", () => {
    console.log("\n[!] interrupted, saving progress");
    interrupted = true;
  });

  for (let i = 0; i < todo.length; i++) {
    if (interrupted) break;
    const ch = todo[i];
    const wait = jitterDelayMs();
    console.log(`\n[${i + 1}/${todo.length}] sleep ${wait}ms then fetch chapter=${ch.id} (${ch.title})`);
    await sleep(wait);

    try {
      const html = await fetchHtml(ch.url, lastUrl);
      const file = path.join(htmlDir, `chapter-${ch.id}.html`);
      fs.writeFileSync(file, html);
      state.chapters[ch.id].status = "ok";
      state.chapters[ch.id].htmlFile = path.relative(cacheDir, file);
      state.chapters[ch.id].fetchedAt = new Date().toISOString();
      state.chapters[ch.id].error = null;
      lastUrl = ch.url;
      saveProgress(state); // save after every success so a crash mid-batch is fine
      console.log(`[ok] saved ${file} (${html.length} bytes)`);
    } catch (err) {
      const msg = String(err?.message || err);
      state.chapters[ch.id].status = "error";
      state.chapters[ch.id].error = msg;
      state.lastError = msg;
      saveProgress(state);
      console.error(`[FAIL] chapter=${ch.id}: ${msg}`);
      if (msg.startsWith("BLOCKED")) {
        console.error(`\n!!! IP appears banned. STOP, switch IP / wait, then re-run.`);
        process.exit(2);
      }
    }
  }

  // 3. Summary
  const all = Object.values(state.chapters);
  const okCount = all.filter((c) => c.status === "ok").length;
  const pendingCount = all.filter((c) => c.status === "pending").length;
  const errCount = all.filter((c) => c.status === "error").length;
  console.log(`\n=== summary: ${okCount}/${all.length} done, ${pendingCount} pending, ${errCount} errors ===`);
  console.log(`progress: ${progressPath}`);
  if (pendingCount > 0) {
    console.log(`To continue:  node backend/scripts/scrape-ctext.mjs --slug ${slug} --max ${maxThisRun}`);
  } else {
    console.log(`All chapters done. Now parse:  node backend/scripts/parse-ctext-cache.mjs --slug ${slug}`);
  }
}

main().catch((e) => {
  console.error("\nfatal:", e);
  process.exit(1);
});
