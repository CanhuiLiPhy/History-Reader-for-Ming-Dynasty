import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "node-html-parser";

const execFileAsync = promisify(execFile);
const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";

async function fetchHtml(url, body = "") {
  // Try Node fetch first (5s timeout — be quick to fail; web search is a
  // best-effort augmentation, not load-bearing).
  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
      },
      body: body || undefined,
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (fetchError) {
    // Fallback to curl if available; ignore curl-not-found etc.
    try {
      const curlArgs = ["-sL", "--max-time", "5", "-A", "Mozilla/5.0"];
      if (body) curlArgs.push("-X", "POST", "-H", "Content-Type: application/x-www-form-urlencoded", "--data", body);
      curlArgs.push(url);
      const result = await execFileAsync("curl", curlArgs, { maxBuffer: 8 * 1024 * 1024 });
      if (!result.stdout.trim()) throw fetchError;
      return result.stdout;
    } catch {
      // give up — caller treats web results as optional
      throw fetchError;
    }
  }
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function parseDuckDuckGoResults(html, limit) {
  const root = parse(html);
  const results = [];

  for (const item of root.querySelectorAll(".result")) {
    const titleNode = item.querySelector(".result__title a") || item.querySelector("a.result__a");
    const snippetNode = item.querySelector(".result__snippet") || item.querySelector(".result__body");
    const urlNode = item.querySelector(".result__url");
    const href = titleNode?.getAttribute("href") || "";
    const title = normalizeWhitespace(titleNode?.textContent || "");
    const snippet = normalizeWhitespace(snippetNode?.textContent || "");
    const source = normalizeWhitespace(urlNode?.textContent || "");

    if (!title || !href) continue;
    results.push({
      title,
      url: href,
      snippet,
      source
    });

    if (results.length >= limit) break;
  }

  return results;
}

export async function searchWeb(query, limit = 4) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return [];

  const payload = `q=${encodeURIComponent(cleanQuery)}&kl=cn-zh&kp=-2`;
  // Best-effort: never throw. QA chain treats empty results as "no web hits".
  try {
    const html = await fetchHtml(DDG_HTML_ENDPOINT, payload);
    return parseDuckDuckGoResults(html, limit);
  } catch (err) {
    console.warn("[web-search] failed (network/DDG block?):", err?.message || err);
    return [];
  }
}
