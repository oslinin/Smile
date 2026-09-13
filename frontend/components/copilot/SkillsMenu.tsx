"use client";

// Skills popover for the copilot: toggle the built-in skills (bundled from
// frontend/skills/*.md), fire a skill's starter prompt, and add your own
// markdown skills. Both lists live in localStorage only and ride each
// request inside `context` — the server resolves built-in bodies by id and
// injects them as "## Active skills" in the system prompt.

import { useState } from "react";
import { SKILLS } from "@/lib/copilot/skills";

export interface CustomSkill {
  name: string;
  body: string;
}
export interface SkillPrefs {
  enabled: string[];
  custom: CustomSkill[];
}

const ENABLED_KEY = "smile.copilot.skills";
const CUSTOM_KEY = "smile.copilot.customSkills";

export const ALL_SKILL_IDS = SKILLS.map((s) => s.id);

export function loadSkillPrefs(): SkillPrefs {
  const read = <T,>(key: string, fallback: T): T => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  return { enabled: read(ENABLED_KEY, ALL_SKILL_IDS), custom: read(CUSTOM_KEY, []) };
}

function savePrefs(p: SkillPrefs) {
  window.localStorage.setItem(ENABLED_KEY, JSON.stringify(p.enabled));
  window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(p.custom));
}

const inputCls =
  "w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-600";

export function SkillsMenu({
  value,
  onChange,
  onStarter,
}: {
  value: SkillPrefs;
  onChange: (v: SkillPrefs) => void;
  /** Send a skill's starter prompt as if the user typed it. */
  onStarter: (text: string) => void;
}) {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");

  const update = (v: SkillPrefs) => {
    savePrefs(v);
    onChange(v);
  };
  const toggle = (id: string) =>
    update({
      ...value,
      enabled: value.enabled.includes(id) ? value.enabled.filter((x) => x !== id) : [...value.enabled, id],
    });
  const add = () => {
    if (!name.trim() || !body.trim()) return;
    update({ ...value, custom: [...value.custom, { name: name.trim(), body: body.trim() }] });
    setName("");
    setBody("");
  };

  return (
    <div className="absolute right-2 top-12 z-10 w-[360px] max-h-[75vh] overflow-y-auto rounded-lg border border-gray-700 bg-gray-950 p-3 shadow-2xl space-y-3">
      <div>
        <div className="text-xs font-semibold text-white">Skills</div>
        <p className="text-[10px] text-gray-500 leading-relaxed">
          Enabled skills are added to the copilot&apos;s instructions on every request. ▶ sends the
          skill&apos;s starter prompt.
        </p>
      </div>

      <ul className="space-y-1.5">
        {SKILLS.map((s) => (
          <li key={s.id} className="flex items-start gap-2 rounded border border-gray-800 bg-gray-900 px-2 py-1.5">
            <input
              type="checkbox"
              checked={value.enabled.includes(s.id)}
              onChange={() => toggle(s.id)}
              aria-label={`Enable ${s.name}`}
              className="mt-0.5"
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs text-white">{s.name}</div>
              <div className="text-[10px] text-gray-500 leading-snug">{s.description}</div>
            </div>
            <button
              onClick={() => onStarter(s.starter)}
              title={s.starter}
              aria-label={`Run ${s.name} starter`}
              className="text-[10px] px-1.5 py-1 rounded border border-gray-700 text-gray-400 hover:text-white hover:border-blue-800 transition-colors"
            >
              ▶ starter
            </button>
          </li>
        ))}
      </ul>

      <div className="space-y-1.5 border-t border-gray-800 pt-2">
        <div className="text-xs font-semibold text-white">Add a skill</div>
        {value.custom.map((c, i) => (
          <div key={i} className="flex items-center gap-2 text-xs text-gray-300">
            <span className="flex-1 truncate">{c.name}</span>
            <button
              onClick={() => update({ ...value, custom: value.custom.filter((_, j) => j !== i) })}
              className="text-[10px] text-gray-500 hover:text-red-400"
              aria-label={`Remove ${c.name}`}
            >
              remove
            </button>
          </div>
        ))}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={inputCls} />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Markdown the copilot should follow (max 4,000 chars, 5 skills)"
          rows={4}
          maxLength={4000}
          className={`${inputCls} font-mono`}
        />
        <button
          onClick={add}
          disabled={!name.trim() || !body.trim() || value.custom.length >= 5}
          className="text-xs px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white font-semibold transition-colors"
        >
          Add
        </button>
      </div>
    </div>
  );
}
