// Generates public/help.html as a wiki-style docs site (sidebar + pages) from
// the repo's markdown docs, and copies public/reference-table.html so the
// Reference Table page can embed it. Runs via the predev / prebuild npm
// hooks, so both local dev and the GitHub Pages build stay current.
//
// The app's "Help" link opens `${basePath}/help.html` in a new tab — that URL
// is preserved; what changed is that help.html is now a small single-page
// shell with a left sidebar (Overview / Limitations / Solutions / Reference
// Table) instead of a single long README dump. Overview, Limitations, and
// Solutions are markdown rendered client-independent (via `marked`, at build
// time) and shown/hidden with plain JS — no bundler, no React, so this stays
// a plain static file that works on GitHub Pages. The Reference Table page is
// a separate interactive HTML document (its own styles/filters/JS) — loaded
// in an <iframe> so it can't collide with the shell's CSS/JS.
//
// Mermaid fenced code blocks (the README has several architecture diagrams)
// are rendered client-side from the jsDelivr CDN, same as before.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const publicDir = join(here, "..", "public");
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const readDoc = (relPath) => readFileSync(join(repoRoot, relPath), "utf8");

const pages = [
  { id: "overview", label: "Overview", source: "README.md", mermaid: true },
  { id: "limitations", label: "Limitations", source: "docs/limitations.md", mermaid: false },
  { id: "solutions", label: "Solutions", source: "docs/solutions.md", mermaid: false },
];

const pageHtml = Object.fromEntries(
  pages.map((p) => [p.id, marked.parse(readDoc(p.source), { gfm: true })])
);

// The Reference Table is its own standalone interactive document (filters,
// cross-reference scrolling) — copy it next to help.html and embed via
// iframe rather than inlining its markup, so its CSS/JS can't collide with
// the wiki shell's.
mkdirSync(publicDir, { recursive: true });
copyFileSync(join(repoRoot, "docs", "reference-table.html"), join(publicDir, "reference-table.html"));

const sidebarLinks = [
  ...pages.map((p) => `<button class="nav-link" data-page="${p.id}">${p.label}</button>`),
  `<button class="nav-link" data-page="reference">Reference Table</button>`,
].join("\n        ");

const pageSections = [
  ...pages.map(
    (p) => `<section id="page-${p.id}" class="page" data-mermaid="${p.mermaid}">
      <article class="doc">${pageHtml[p.id]}</article>
    </section>`
  ),
  `<section id="page-reference" class="page page-reference">
      <iframe src="${basePath}/reference-table.html" title="Smile reference table" loading="lazy"></iframe>
    </section>`,
].join("\n    ");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Smile — Docs</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: #030712;
    color: #e5e7eb;
    font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wiki { display: flex; min-height: 100vh; }
  .sidebar {
    flex: 0 0 220px;
    background: #0b1120;
    border-right: 1px solid #1f2937;
    padding: 24px 12px;
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
  }
  .sidebar h2 {
    color: #fff;
    font-size: 0.95rem;
    margin: 0 12px 16px;
    letter-spacing: 0.02em;
  }
  .nav-link {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: #9ca3af;
    font: inherit;
    font-size: 0.9rem;
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
    margin-bottom: 2px;
  }
  .nav-link:hover { background: #111827; color: #d1d5db; }
  .nav-link.active { background: #1e293b; color: #fff; font-weight: 600; }
  .content { flex: 1; min-width: 0; }
  .page { display: none; }
  .page.active { display: block; }
  .doc { max-width: 880px; margin: 0 auto; padding: 48px 24px 96px; }
  .page-reference { height: 100vh; }
  .page-reference iframe { width: 100%; height: 100%; border: none; display: block; }
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

  @media (max-width: 760px) {
    .wiki { flex-direction: column; }
    .sidebar {
      position: static;
      height: auto;
      width: 100%;
      border-right: none;
      border-bottom: 1px solid #1f2937;
      display: flex;
      overflow-x: auto;
      padding: 12px;
    }
    .sidebar h2 { display: none; }
    .nav-link { width: auto; white-space: nowrap; margin-right: 4px; margin-bottom: 0; }
    .page-reference { height: 80vh; }
  }
</style>
</head>
<body>
  <div class="wiki">
    <nav class="sidebar">
      <h2>Smile Docs</h2>
      ${sidebarLinks}
    </nav>
    <div class="content">
      ${pageSections}
    </div>
  </div>
  <script>
    // Plain classic script: sidebar navigation must work even if the CDN
    // mermaid import below never resolves (offline, blocked, jsDelivr down).
    // A failed top-level ES module import aborts the ENTIRE module, so
    // mermaid is loaded separately, dynamically, with its own try/catch.
    var VALID_PAGES = ${JSON.stringify([...pages.map((p) => p.id), "reference"])};
    var mermaidDone = new Set();
    var mermaidReady = null; // Promise<mermaid module> | null, set below

    function pendingMermaidBlocks(section) {
      return section.dataset.mermaid === "true" && !mermaidDone.has(section.id)
        && section.querySelectorAll("code.language-mermaid").length > 0;
    }

    async function renderMermaidIn(section) {
      if (!pendingMermaidBlocks(section) || !mermaidReady) return;
      const mermaid = await mermaidReady.catch(() => null);
      if (!mermaid) return; // CDN unavailable — diagrams stay as plain code blocks
      const blocks = section.querySelectorAll("code.language-mermaid");
      blocks.forEach((el) => {
        const pre = el.closest("pre");
        const div = document.createElement("div");
        div.className = "mermaid";
        div.textContent = el.textContent;
        pre.replaceWith(div);
      });
      mermaidDone.add(section.id);
      try { await mermaid.run({ nodes: section.querySelectorAll(".mermaid") }); }
      catch (e) { console.error("mermaid render failed", e); }
    }

    function showPage(id) {
      if (VALID_PAGES.indexOf(id) === -1) id = VALID_PAGES[0];
      document.querySelectorAll(".page").forEach(function (el) { el.classList.remove("active"); });
      document.querySelectorAll(".nav-link").forEach(function (el) { el.classList.remove("active"); });
      var section = document.getElementById("page-" + id);
      section.classList.add("active");
      document.querySelector('.nav-link[data-page="' + id + '"]').classList.add("active");
      renderMermaidIn(section);
      history.replaceState(null, "", "#" + id);
    }

    document.querySelectorAll(".nav-link").forEach(function (btn) {
      btn.addEventListener("click", function () { showPage(btn.dataset.page); });
    });

    showPage((location.hash || "#overview").slice(1));

    // Best-effort mermaid load — never blocks navigation or page rendering.
    mermaidReady = import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs")
      .then(function (mod) {
        var mermaid = mod.default;
        mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "loose" });
        var active = document.querySelector(".page.active");
        if (active) renderMermaidIn(active);
        return mermaid;
      })
      .catch(function (e) { console.warn("mermaid unavailable — diagrams will show as code blocks", e); throw e; });
  </script>
</body>
</html>
`;

writeFileSync(join(publicDir, "help.html"), html);
console.log(`gen-help: wrote ${join(publicDir, "help.html")} (${html.length} bytes) + reference-table.html`);
