import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "node-html-parser";

const execFileAsync = promisify(execFile);
const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";

async function fetchHtml(url, body = "") {
  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "MingshiReaderAI/1.0 (+https://localhost)"
      },
      body: body || undefined,
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(`网页检索失败：${response.status}`);
    }

    return response.text();
  } catch (error) {
    const curlArgs = ["-L", "--max-time", "15", "-A", "MingshiReaderAI/1.0 (+https://localhost)"];
    if (body) {
      curlArgs.push("-X", "POST", "-H", "Content-Type: application/x-www-form-urlencoded", "--data", body);
    }
    curlArgs.push(url);

    const result = await execFileAsync("curl", curlArgs, {
      maxBuffer: 8 * 1024 * 1024
    });

    if (!result.stdout.trim()) {
      throw error;
    }

    return result.stdout;
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
  const html = await fetchHtml(DDG_HTML_ENDPOINT, payload);
  return parseDuckDuckGoResults(html, limit);
}
