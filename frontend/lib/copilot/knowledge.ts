// Typed access to the build-time knowledge pack (scripts/gen-knowledge.mjs).
// The TOC + glossary go in the system prompt; full sections are fetched on
// demand through the read_docs tool so the docs never bloat every request.

import pack from "./knowledge.generated.json";

export interface TocEntry {
  id: string;
  title: string;
  source: string;
  summary: string;
}

const toc = pack.toc as TocEntry[];
const sections = pack.sections as Record<string, string>;

export const TOC: TocEntry[] = toc;
export const GLOSSARY: string = pack.glossary as string;

export const SECTION_IDS = toc.map((t) => t.id);

const MAX_SECTION_CHARS = 6000;

export function getSection(id: string): string | null {
  const body = sections[id];
  if (!body) return null;
  return body.length > MAX_SECTION_CHARS
    ? body.slice(0, MAX_SECTION_CHARS) + "\n\n…(section truncated)"
    : body;
}

/** Compact TOC text for the system prompt — one line per section. */
export function tocText(): string {
  return toc
    .map((t) => `- ${t.id} — ${t.title}${t.summary ? `: ${t.summary}` : ""}`)
    .join("\n");
}
