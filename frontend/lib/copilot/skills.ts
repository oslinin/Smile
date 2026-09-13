// Built-in agent skills, bundled at build time from frontend/skills/*.md by
// scripts/gen-knowledge.mjs. Bodies are looked up server-side by id — the
// client only ever sends which ids are enabled.

import pack from "./knowledge.generated.json";

export interface Skill {
  id: string;
  name: string;
  description: string;
  starter: string;
  body: string;
}

export const SKILLS: Skill[] = pack.skills as Skill[];
