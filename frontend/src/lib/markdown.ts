import { marked } from "marked";

marked.setOptions({
  gfm: true,
  breaks: true,
});

function sanitizeHtmlFragment(html: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const blocked = ["script", "style", "iframe", "object", "embed", "link", "meta"];
  blocked.forEach((selector) => {
    doc.querySelectorAll(selector).forEach((node) => node.remove());
  });

  doc.querySelectorAll("*").forEach((node) => {
    for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name)) {
        node.removeAttribute(attr.name);
      }
      if ((attr.name === "href" || attr.name === "src") && /^javascript:/i.test(attr.value)) {
        node.removeAttribute(attr.name);
      }
    }
  });

  return doc.body.innerHTML;
}

export function renderMarkdown(markdown: string) {
  const rawHtml = marked.parse(markdown || "");
  return sanitizeHtmlFragment(typeof rawHtml === "string" ? rawHtml : String(rawHtml));
}
