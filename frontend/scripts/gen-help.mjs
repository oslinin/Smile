// Generates public/help.html from the repo README so the app's "Help" link can
// open it as a styled, standalone HTML page in a new tab. Runs via the predev /
// prebuild npm hooks, so both local dev and the GitHub Pages build stay current.
//
// Mermaid fenced code blocks (the README has several architecture diagrams) are
// rendered client-side from the jsDelivr CDN — no bundler involvement, which
// keeps this a plain static file that works on GitHub Pages.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import katex from "katex";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const readmePath = join(repoRoot, "README.md");
const outPath = join(here, "..", "public", "help.html");

// The README uses GitHub's native $ / $$ math delimiters (so it also renders
// correctly on github.com). Those spans have to be pulled out and rendered
// to static KaTeX HTML *before* marked.parse() runs, for two reasons:
//  1. Markdown's backslash-escaping (`\_`, `\!`, `\;`, ...) and emphasis
//     rules (`_..._`) would otherwise mangle the LaTeX source.
//  2. A lone `$` is also used for plain currency in prose (e.g. "$25 of
//     headroom"), which is ambiguous with math delimiters in general. Since
//     every genuine inline math span here contains a LaTeX-signal character
//     (\, ^, _, {, }, [, ]) and currency mentions never do, that's used to
//     tell them apart deterministically at build time — far safer than
//     asking a browser-side delimiter scanner to guess.
function extractMath(markdown) {
  const spans = [];
  const protect = (source, display) => {
    const rendered = katex.renderToString(source, { throwOnError: false, displayMode: display });
    spans.push(rendered);
    return `MATHSPANPLACEHOLDER${spans.length - 1}ENDMATHSPAN`;
  };

  // Display math: $$...$$, unambiguous since currency never uses double $.
  let text = markdown.replace(/\$\$([\s\S]+?)\$\$/g, (_, source) => protect(source, true));

  // Inline math: scan for $...$ pairs on a single line whose content looks
  // like LaTeX. Anything else (currency, an unpaired $) is left untouched.
  const looksLikeMath = /[\\^_{}[\]]/;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$") {
      let j = i + 1;
      while (j < text.length && text[j] !== "$" && text[j] !== "\n") j++;
      const inner = text.slice(i + 1, j);
      if (text[j] === "$" && inner.length > 0 && !/^\s|\s$/.test(inner) && looksLikeMath.test(inner)) {
        out += protect(inner, false);
        i = j;
        continue;
      }
    }
    out += text[i];
  }
  return { text: out, spans };
}

const { text: protectedReadme, spans: mathSpans } = extractMath(readFileSync(readmePath, "utf8"));

let body = marked.parse(protectedReadme, { gfm: true });
body = body.replace(
  /MATHSPANPLACEHOLDER(\d+)ENDMATHSPAN/g,
  (_, i) => mathSpans[Number(i)],
);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Smile — Docs</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.17/dist/katex.min.css" />
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0;
    background: #030712;
    color: #e5e7eb;
    font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .doc { max-width: 880px; margin: 0 auto; padding: 48px 24px 96px; }
  h1, h2, h3, h4 { color: #fff; font-weight: 700; line-height: 1.25; margin: 1.8em 0 0.6em; }
  h1 { font-size: 2rem; border-bottom: 1px solid #1f2937; padding-bottom: 0.3em; }
  h2 { font-size: 1.5rem; border-bottom: 1px solid #1f2937; padding-bottom: 0.3em; }
  h3 { font-size: 1.2rem; }
  a { color: #60a5fa; text-decoration: none; }
  a:hover { text-decoration: underline; }
  p, li { color: #d1d5db; }
  code {
    background: #111827; border: 1px solid #1f2937; border-radius: 4px;
    padding: 0.1em 0.35em; font-size: 0.875em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #fbcfe8;
  }
  pre {
    background: #0b1120; border: 1px solid #1f2937; border-radius: 8px;
    padding: 16px; overflow-x: auto;
  }
  pre code { background: none; border: none; padding: 0; color: #cbd5e1; }
  blockquote {
    margin: 1em 0; padding: 0.2em 1em; border-left: 3px solid #374151; color: #9ca3af;
  }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.9rem; }
  th, td { border: 1px solid #1f2937; padding: 8px 12px; text-align: left; }
  th { background: #111827; color: #fff; }
  img { max-width: 100%; }
  hr { border: none; border-top: 1px solid #1f2937; margin: 2em 0; }
  .mermaid { background: #0b1120; border: 1px solid #1f2937; border-radius: 8px; padding: 16px; margin: 1em 0; text-align: center; }
  .back { display: inline-block; margin-bottom: 24px; color: #9ca3af; font-size: 0.85rem; }
</style>
</head>
<body>
  <article class="doc">
    ${body}
  </article>
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
    // Turn \`\`\`mermaid fenced blocks into mermaid-rendered containers.
    document.querySelectorAll("code.language-mermaid").forEach((el) => {
      const pre = el.closest("pre");
      const div = document.createElement("div");
      div.className = "mermaid";
      div.textContent = el.textContent;
      pre.replaceWith(div);
    });
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "loose" });
    try { await mermaid.run(); } catch (e) { console.error("mermaid render failed", e); }
  </script>
</body>
</html>
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html);
console.log(`gen-help: wrote ${outPath} (${html.length} bytes, README ${readmePath})`);
