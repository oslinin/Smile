// Compiles the repo's markdown docs into lib/copilot/knowledge.generated.json
// for the AI copilot: a token-cheap TOC (id + title + first-sentence summary)
// that lives in the system prompt, full section bodies served on demand via
// the read_docs tool, and the glossary extracted for direct prompt inclusion.
// Follows the gen-help.mjs precedent; runs via the predev / prebuild hooks.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const outFile = join(here, "..", "lib", "copilot", "knowledge.generated.json");

const DOCS = [
  { source: "README.md", prefix: "readme" },
  { source: "docs/limitations.md", prefix: "limitations" },
  { source: "docs/solutions.md", prefix: "solutions" },
];

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[`*_"'—·．.,:;!?()\[\]{}]/g, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

// Mermaid diagrams are architecture pictures — useless as LLM text and
// expensive in tokens. Replace each with a one-line placeholder.
const stripMermaid = (md) =>
  md.replace(/```mermaid[\s\S]*?```/g, "*(architecture diagram omitted)*");

/** First sentence of the body, cleaned, for the TOC summary line. */
function summarize(body) {
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\|[^\n]*\|/g, " ") // table rows
    .replace(/[#>*_`]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const m = text.match(/^.{20,}?[.!?](\s|$)/);
  return (m ? m[0] : text.slice(0, 140)).trim().slice(0, 160);
}

const toc = [];
const sections = {};

for (const { source, prefix } of DOCS) {
  const md = stripMermaid(readFileSync(join(repoRoot, source), "utf8"));
  // Split at ## / ### headings; the preamble before the first heading becomes
  // the doc's "intro" section.
  const parts = md.split(/^(?=#{2,3} )/m);
  for (const part of parts) {
    const headingMatch = part.match(/^(#{2,3}) (.+)\n/);
    const title = headingMatch ? headingMatch[2].trim() : `${source} intro`;
    const body = headingMatch ? part.slice(headingMatch[0].length).trim() : part.trim();
    if (!body) continue;
    let id = `${prefix}/${slug(title)}`;
    // Duplicate headings (e.g. "S4 (again)") get a numeric suffix.
    let n = 2;
    while (sections[id]) id = `${prefix}/${slug(title)}-${n++}`;
    sections[id] = (headingMatch ? `${headingMatch[1]} ${title}\n\n` : "") + body;
    toc.push({ id, title, source, summary: summarize(body) });
  }
}

// The limitations glossary doubles as the copilot's term dictionary — small
// enough to inline in the system prompt.
const glossaryId = toc.find((t) => t.id.endsWith("/glossary"))?.id;
const glossary = glossaryId ? sections[glossaryId] : "";

mkdirSync(dirname(outFile), { recursive: true });
const out = { generatedAt: null, toc, sections, glossary };
writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(
  `gen-knowledge: wrote ${outFile} (${toc.length} sections, ${JSON.stringify(out).length} bytes)`
);
