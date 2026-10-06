import { parseTrigger, generateDSID } from "./trigger-parser.mjs";
import { featureGainLines } from "./feature-lines.mjs";

const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#39;|&rsquo;/g, "’").replace(/&quot;/g, "\"").replace(/[ʼ‘]/g, "’");

function enricherText(inner, label) {
  if (label) return label;
  const [cmd, ...words] = inner.replace(/^[/]/, "").trim().split(/\s+/);
  const args = words.filter((w) => !w.includes("="));
  if (cmd === "apply") return args[0] ?? "";
  if (cmd === "damage") return `${args.join(" ")} damage`;
  if (cmd === "gain") return `gain ${args.join(" ")}`;
  if (cmd === "surge") return `gain ${args[0] ?? 1} surge${args[0] === "1" ? "" : "s"}`;
  if (cmd === "potency") return `${args[1] ?? ""} potency`;
  if (cmd === "heal") return `${args[0] ?? ""} ${args.includes("temp") || /temporary/.test(inner) ? "temporary " : ""}Stamina`;
  return args.join(" ") || cmd;
}

function blocksOf(html) {
  let text = String(html ?? "").replace(/\[\[([^\]]*)\]\](?:\{([^}]*)\})?/g, (m, inner, label) => enricherText(inner, label))
    .replace(/@\w+\[[^\]]*\](?:\{([^}]*)\})?/g, (m, label) => label ?? "");
  text = text.replace(/<\/(p|li|h\d|tr|div)>|<br\s*\/?>/gi, "\n").replace(/<li[^>]*>/gi, "\n").replace(/<[^>]+>/g, "");
  return decode(text).split(/\n+/).map((b) => b.replace(/\bdamage damage\b/g, "damage").replace(/\s+/g, " ").trim()).filter(Boolean);
}

const sentencesOf = (block) => block.split(/(?<=[.!?])\s+(?=[A-Z])/);

const PARKED = [/^color-cloak/];

const WHEN = /\b(whenever|when|each time|every time|the first time|once per (?:round|turn|encounter|combat round))\b/i;
const LEAD = /\b(whenever|when|each time|every time|the first time|if)\b/i;
const LABEL = /^(?:effect|\d+(?:st|nd|rd|th) level|[A-Z][\w'’ ]{0,30}):\s*/i;
const USE_ACTION = /,?\s*(?:you|they) can (?:use|make)\b[^.]*?\b(?:free )?triggered action\b/i;
const AS_ACTION = /\bas an? (?:free )?triggered action\b/i;
const REVERSE = /^(?:additionally,?\s*)?you can use an? (?:free )?triggered action to (.+?),? (?:when|whenever|if|each time) (.+?)[.!]?$/i;
const REFERS_BACK = /\b(?:this|that|the [\w'’-]+['’]s?) (?:free )?triggered action\b|\bthis ability becomes\b/i;
const NOT_EVENT = /^(while|as long as|if you (?:have|are|aren['’]t))\b/i;
const ANAPHORIC = /^(?:additionally,\s*)?(?:when|whenever|each time) you do\b/i;
const ITEM_USE = /^(?:when|whenever|each time) you (?:drink|eat|consume|wear|don|activate|read|open|throw|apply|attune|touch)\b|\bthis (?:tonic|potion|elixir|oil|scroll)\b/i;
const OUT_OF_COMBAT = /\b(respite|downtime|montage|negotiation|project|travel(?:ing)?|tests?\b|rest\b|between encounters|outside of combat|each day|a day|victor(?:y|ies)|hours?|minutes?|uninterrupted|craft(?:ing)?|deity)\b/i;
const AUGMENT = /^(?:you|your companion|you or your companion) (?:use|uses|make|makes|take|takes|activate)s? (?:the |a |an |your |any )?(?:[\w'’ -]+ )?(?:ability|abilities|maneuver|main action|move action|action|strike|free strike|Judgment|Disengage|Charge|Knockback|Advance|Aid Attack|Hide|Search|Grab)\b(?! against you)/i;

function cleanCondition(c) {
  let t = c.replace(/^additionally,?\s*/i, "").replace(/\s*\([^)]*\)/g, "");
  t = t.replace(/^once per (?:combat )?(?:round|turn|encounter)\s*,?\s*/i, "");
  t = t.replace(/^(?:the )?first time (?:each|in an|in a|during an|during a|during each|on a|per)? ?(?:combat )?(?:round|encounter|turn)?\s*(?:that\s+)?/i, "");
  t = t.replace(/^(?:whenever|when|each time|every time|if)\s+/i, "");
  t = t.replace(/\b(?:each|every|in an|in a|per|during the|during an|this) (?:combat )?(?:round|encounter)\b/gi, "");
  t = t.replace(/^\s*that\s+/i, "").replace(/,\s*$/, "").replace(/\s+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

function onceOf(s) {
  if (/once per (?:combat )?round|\b(?:each|every|in a|per) (?:combat )?round\b/i.test(s)) return "round";
  if (/once per turn/i.test(s)) return "turn";
  if (/first time|once per (?:encounter|combat)/i.test(s)) return "encounter";
  return null;
}

function actionCondition(body) {
  const reverse = body.match(REVERSE);
  if (reverse) return { condition: reverse[2], effect: reverse[1] };
  const use = body.search(USE_ACTION);
  const as = body.search(AS_ACTION);
  const cut = use >= 0 ? use : as >= 0 ? body.lastIndexOf(",", as) : -1;
  if (cut < 0) return null;
  let head = body.slice(0, cut).replace(/^once per (?:combat )?(?:round|turn|encounter)\s*,?\s*/i, "");
  const lead = head.search(LEAD);
  if (lead >= 0) head = head.slice(lead);
  else {
    const unwrapped = head.replace(/^while [^,]*? and (?=you\b|an?\b|the\b)/i, "");
    if (unwrapped === head) return null;
    head = unwrapped;
  }
  let effect = body.slice(cut).replace(/^,?\s*/, "");
  if (use >= 0 && !AS_ACTION.test(body.slice(use).match(USE_ACTION)[0])) effect = body.slice(use).replace(USE_ACTION, "").replace(/^\s*to\s+/i, "");
  else effect = effect.replace(/^(?:you|they) can /i, "").replace(/\s*as an? (?:free )?triggered action\b/i, "");
  return { condition: head, effect };
}

function eventCondition(body) {
  const stripped = body.replace(/^once per (?:combat )?(?:round|turn|encounter)\s*,?\s*/i, "");
  const at = stripped.search(WHEN);
  if (at < 0) return null;
  const rest = stripped.slice(at);
  const cut = rest.search(/,\s*(?=(?:you|they|their|them|he|she|his|her|that|the|it|each|an?|your|this|its|both|until|instead)\b)/i);
  return cut > 0 ? { condition: rest.slice(0, cut), effect: rest.slice(cut + 1).trim() } : null;
}

/**
 * Every sentence in a feature, trait, title, perk, complication or treasure description that works like a triggered
 * ability. A line spends a triggered action, a free triggered action, or nothing at all ("whenever ...").
 * @param {string} html  the stored description, enrichers as written
 * @param {object} options
 * @param {string} [options.dsid]      the item's dsid
 * @param {string} [options.name]      the item's name, keys lines when the dsid is shared (several treasures are "treasure")
 * @param {string} [options.resource]  the class resource, so heroic resource gain lines are left to resource-gains
 * @param {string} [options.ownerName] the actor's name, so "the chimera" or "Locratix" reads as the owner
 * @returns {object[]} lines: { key, sentence, action, kind, once, trigger, effect, parse, tier, family }
 *   action: "triggered" | "freeTriggered" | null; kind: "trigger" | "augment" | "outOfCombat"
 *   tier: { min, level, resource } for a row of a Growing Ferocity style table, else null
 */
export function featureTriggerLines(html, { dsid = "", name = "", resource = null, ownerName = "" } = {}) {
  if (!html || PARKED.some((rx) => rx.test(dsid))) return [];
  const gains = resource ? new Set(featureGainLines(html, { resource }).map((l) => l.sentence)) : new Set();
  const base = dsid && dsid === generateDSID(name) ? dsid : `${dsid} ${name}`.trim();
  const lines = [];
  const keys = new Set();
  const { rest, rows } = tierRows(html);
  collectLines(rest, null, { gains, base, lines, keys, ownerName, dsid });
  for (const row of rows) collectLines(row.html, row.tier, { gains, base, lines, keys, ownerName, dsid });
  return lines;
}

const TIER_CELL = /^(\d+)\s*(?:\(\s*(\d+)(?:st|nd|rd|th)\s+level\s*\))?$/i;
const cellText = (h) => decode(String(h ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function tierRows(html) {
  const rows = [];
  const rest = String(html).replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    const cells = (tr) => [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
    const trs = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    const header = cellText(cells(trs[0] ?? "")[0]);
    const tiered = trs.slice(1).map(cells).filter((c) => c.length >= 2 && TIER_CELL.test(cellText(c[0])));
    if (!header || /^\d/.test(header) || !tiered.length) return table;
    for (const c of tiered) {
      const m = cellText(c[0]).match(TIER_CELL);
      rows.push({ html: `<p>${c.slice(1).join(" ")}</p>`, tier: { min: Number(m[1]), level: m[2] ? Number(m[2]) : null, resource: header.toLowerCase() } });
    }
    return "";
  });
  return { rest, rows };
}

const OWNER_STOP = new Set(["the", "and", "of", "war", "dog", "size"]);

function asOwner(trigger, ownerName) {
  let out = trigger.replace(/^(?:they|he|she)\b/i, "The self").replace(/\bagainst them\b/i, "against the self");
  const words = ownerName.toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !OWNER_STOP.has(w));
  for (const w of words) out = out.replace(new RegExp(`\\bthe (?:[a-z-]+ )?${w}\\b`, "gi"), "the self");
  return out;
}

const DEFERS_DEATH = /\b(?:instead (?:have|has) \d+ stamina|remain alive|before dying|delay that effect|regains? (?:half )?(?:their|its|his|her) stamina)\b/i;
export const defersDeath = (effect) => DEFERS_DEATH.test(String(effect ?? ""));

const CURATED = {
  "escort-the-prisoners": { kind: "augment" },
  "leading": { kind: "augment" },
  "gloaming-wyrmscale-aura": { kind: "augment" },
  "empowered-will": { once: "round" },
};

function collectLines(html, tier, { gains, base, lines, keys, ownerName, dsid }) {
  for (const block of blocksOf(html)) {
    const sentences = sentencesOf(block);
    const found = [];
    sentences.forEach((sentence, index) => {
      const free = /\bfree triggered action\b/i.test(sentence);
      const spends = free || /\btriggered action\b/i.test(sentence);
      if (!spends && !WHEN.test(sentence)) return;
      if (gains.has(sentence) || REFERS_BACK.test(sentence)) return;
      const body = sentence.replace(LABEL, "");
      if (NOT_EVENT.test(body) && !spends) return;
      if (ANAPHORIC.test(body)) return;
      let parts;
      if (spends) {
        parts = actionCondition(body);
        if (!parts) return;
      } else {
        if (ITEM_USE.test(body)) return;
        parts = eventCondition(body);
        if (!parts) return;
      }
      const trigger = cleanCondition(parts.condition);
      if (!trigger) return;
      found.push({ index, sentence, trigger, effect: parts.effect, action: free ? "freeTriggered" : spends ? "triggered" : null });
    });
    found.forEach((f, i) => {
      const next = found[i + 1]?.index ?? sentences.length;
      const effect = [f.effect, ...sentences.slice(f.index + 1, next)].join(" ").replace(/\s+/g, " ").trim();
      const curated = CURATED[dsid || generateDSID(base)] ?? {};
      const kind = curated.kind ?? (OUT_OF_COMBAT.test(f.sentence) ? "outOfCombat" : !f.action && AUGMENT.test(f.trigger) ? "augment" : "trigger");
      const once = curated.once ?? onceOf(f.sentence) ?? (/\buntil the end of the round\b/i.test(effect) ? "round" : null);
      const parseText = ownerName ? asOwner(f.trigger, ownerName) : f.trigger;
      let key = generateDSID(`${base} ${f.trigger}`).slice(0, 80) + (tier ? `-t${tier.min}` : "");
      for (let n = 2; keys.has(key); n++) key = `${key.replace(/~\d+$/, "")}~${n}`;
      keys.add(key);
      lines.push({ key, sentence: f.sentence, action: f.action, kind, once, trigger: f.trigger, effect,
        parse: parseTrigger(`${parseText}.`, { effectText: effect, ownerName }), tier, family: tier ? generateDSID(f.trigger) : null });
    });
  }
}
