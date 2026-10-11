import { parseTrigger, generateDSID } from "./trigger-parser.mjs";
import { featureGainLines } from "./feature-lines.mjs";

const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#39;|&rsquo;/g, "’").replace(/&quot;/g, "\"").replace(/[ʼ‘]/g, "’");

export function enricherText(inner, label) {
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

const LI = "\u0001";

function blocksOf(html) {
  let text = String(html ?? "").replace(/\[\[([^\]]*)\]\](?:\{([^}]*)\})?/g, (m, inner, label) => enricherText(inner, label))
    .replace(/@\w+\[[^\]]*\](?:\{([^}]*)\})?/g, (m, label) => label ?? "");
  text = text.replace(/<\/(p|li|h\d|tr|div)>|<br\s*\/?>/gi, "\n").replace(/<li[^>]*>/gi, `\n${LI}`).replace(/<[^>]+>/g, "");
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

const BACKSTORY = /^(?:you|they|someone|your(?: [\w'’]+){1,2}) (?:were|was|once|first|used to|grew up|woke|left|went|arrived|last saw|died|(?:have|['’]ve) \w+ed)\b|^(?:first )?(?:handled|held|wielded|worn|donned)$/i;
const ACTIVATION = /^(?:activated|opened)\b|^you (?!use\b|uses\b)[\w'’ -]+ as an? (?:maneuver|main action|move action)$/i;
const MECHANICS = /\b(?:damage|stamina|surges?|edges?|banes?|rolls?|tests?|squares?|shifts?|slides?|push(?:es)?|pulls?|teleports?|grab(?:s|bed)?|prone|weakened|slowed|dazed|frightened|taunted|bleeding|restrained|recover(?:y|ies)|resources?|speed|stability|potency|tier|actions?|maneuvers?|abilit(?:y|ies)|strikes?|immun\w*|weakness|temporary|turns?|rounds?|saving throw|save ends|bonus|penalty|gains?|loses?|targets?|creatures?|all(?:y|ies)|enem(?:y|ies)|renown|wealth|initiative|d10|doomed|forms?|moves?|movement|hidden|hide|sneak|invisible|conditions?|can|can['’]t|cannot|must|immediately|automatically|ends?|die|dies|death|dead|space|terrain|size|projects?|victor(?:y|ies)|malice|spends?|spent|swap|replace|choose|as if|effects?|destroyed|reappears?|retreat|revert|soul|restored|hero token|fate points?|questions?|director|inactive|appl(?:y|ies)|\d+)\b/i;
const plainWords = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const OUT_OF_COMBAT =/\b(respite|downtime|montage|negotiation|project|travel(?:ing)?|tests?\b|rest\b|between encounters|outside of combat|each day|a day|victor(?:y|ies)|hours?|minutes?|uninterrupted|craft(?:ing)?|deity)\b/i;
const AUGMENT = /^(?:you|your companion|you or your companion) (?:use|uses|make|makes|take|takes|activate)s? (?:the |a |an |your |any )?(?:[\w'’ -]+ )?(?:ability|abilities|maneuver|main action|move action|action|strike|free strike|Judgment|Disengage|Charge|Knockback|Advance|Aid Attack|Hide|Search|Grab)\b(?! against you)/i;

function cleanCondition(c) {
  let t = c.replace(/^additionally,?\s*/i, "").replace(/\s*\([^)]*\)/g, "");
  t = t.replace(/^once per (?:combat )?(?:round|turn|encounter)\s*,?\s*/i, "");
  t = t.replace(/^(?:the )?first time (?:(?:each|in any|in an|in a|during an|during a|during each|on a|per)\b ?)?(?:combat )?(?:round|encounter|turn)?\s*(?:that\s+)?/i, "");
  t = t.replace(/^(?:whenever|when|each time|every time|if)\s+/i, "");
  t = t.replace(/\b(?:each|every|in any|in an|in a|per|during the|during an|this) (?:combat )?(?:round|encounter)\b/gi, "");
  t = t.replace(/\b(?:on|in) a turn\b/gi, "");
  t = t.replace(/^\s*that\s+/i, "").replace(/,\s*$/, "").replace(/\s+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

function onceOf(s) {
  if (/once per (?:combat )?round|\b(?:each|every|in a|in any|per) (?:combat )?round\b/i.test(s)) return "round";
  if (/once per turn|\bfirst time\b[^.]*?\b(?:on|in) a turn\b/i.test(s)) return "turn";
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

export function featureTriggerLines(html, { dsid = "", name = "", resource = null, ownerName = "", benefits = [] } = {}) {
  if (!html || PARKED.some((rx) => rx.test(dsid))) return [];
  const gains = resource ? new Set(featureGainLines(html, { resource }).map((l) => l.sentence)) : new Set();
  const base = dsid && dsid === generateDSID(name) ? dsid : `${dsid} ${name}`.trim();
  const lines = [];
  const keys = new Set();
  const skip = new Set(benefits.map((n) => plainWords(n)));
  const { rest, rows } = tierRows(html);
  collectLines(rest, null, { gains, base, lines, keys, ownerName, dsid, name, skip });
  for (const row of rows) collectLines(row.html, row.tier, { gains, base, lines, keys, ownerName, dsid, name, skip });
  return lines;
}

const SELF_DESCRIPTION = /\b(?:this|the) (?:ability|movement|shift|maneuver|charge|move action|main action|feature)\b|\btakes? the [\w-]+ (?:move|main) action\b|^you do\b|^they use (?:this|that)\b|\bwhile using this\b/i;
const NEEDS_SUBJECT = /\b(?!(?:taunted|grabbed|restrained|frightened|slowed|weakened|dazed|bleeding)\b)\w+ed by you\b|\byou['’]ve marked\b|\bthe target\b|\ba target\b|\bunder this effect\b/i;
const MARKED = /\b(?!(?:taunted|grabbed|restrained|frightened|slowed|weakened|dazed|bleeding)\b)(\w+ed) by you\b|\byou['’]ve (marked)\b/i;
const AREA = /\b(?:the area|in the area|zone|stockade|aura|wall)\b/i;

export function abilityEffectHTML(ability) {
  const effects = [...(ability?.system?.effects?.contents ?? Object.values(ability?.system?.effects ?? {}))];
  return effects.sort((a, b) => (b.before === true) - (a.before === true) || (a.sort ?? 0) - (b.sort ?? 0))
    .map((e) => e.description ?? "").join("");
}

export function abilityTriggerLines(html, { dsid = "", name = "", ownerName = "", appliesEffects = false } = {}) {
  return featureTriggerLines(html, { dsid, name, ownerName }).map((l) => {
    const watch = SELF_DESCRIPTION.test(l.trigger) ? "self"
      : AREA.test(l.trigger) || !appliesEffects ? "parked"
        : NEEDS_SUBJECT.test(l.trigger) ? "subject" : "active";
    const mark = l.trigger.match(MARKED);
    return { ...l, watch, ...(mark ? { watchMark: (mark[1] ?? mark[2]).toLowerCase() } : {}) };
  });
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

export function asOwner(trigger, ownerName) {
  let out = trigger.replace(/^(?:they|he|she)\b/i, "The self").replace(/\bagainst them\b/i, "against the self");
  const words = ownerName.toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !OWNER_STOP.has(w));
  for (const w of words) out = out.replace(new RegExp(`\\bthe (?:[a-z-]+ )?${w}\\b`, "gi"), "the self");
  return out;
}

const DEFERS_DEATH = /\b(?:instead (?:have|has) \d+ stamina|remain alive|before dying|delay that effect|regains? (?:half )?(?:their|its|his|her) stamina)\b/i;
export const defersDeath = (effect) => DEFERS_DEATH.test(String(effect ?? ""));
export const marksSpace = (effect) => /\btheir space is difficult terrain\b/i.test(String(effect ?? ""));

const CURATED = {
  "escort-the-prisoners": { kind: "augment" },
  "leading": { kind: "augment" },
  "gloaming-wyrmscale-aura": { kind: "augment" },
  "empowered-will": { once: "round" },
};

const CURATED_LINES = [
  [/^Breath of Creation$/, /another Breath of Creation/, { drop: true }],
  [/^Camouflage Hunter$/, /./, { drop: true }],
  [/^Cinder Step$/, /teleport this way/, { drop: true }],
  [/^Clarity and Strain$/, /clarity below 0/, { drop: true }],
  [/^Disciple of the Green$/, /take on an animal form/, { drop: true }],
  [/^Elemental Inside$/, /./, { drop: true }],
  [/^Field Arsenal$/, /./, { drop: true }],
  [/^Harlequin Gambit$/, /illusion would end/, { drop: true }],
  [/^Chosen One$/, /spend your Heroic Resource/, { drop: true }],
  [/^Font of Creation$/, /./, { drop: true }],
  [/^Drama$/, /When you are dead/, { drop: true }],

  [/Field Commander/, /end this slide adjacent/, { later: "Chained trigger: the Baton's own slide" }],
  [/^Evil Revealed$/, /./, { later: "Seeing through disguises" }],
  [/^Saint['’]s Vigilance$/, /./, { later: "Combat Tools: finding hidden creatures" }],
  [/Blade of the Luxurious Fop/, /opportunity attack/, { later: "Opportunity attacks" }],
  [/^Boren$/, /use forced movement to push/, { later: "Forced movement interrupt" }],
  [/Chain of the Sea and Sky/, /feet are not touching/, { later: "Combat Tools: off the ground" }],
  [/^Chosen One$/, /destiny points/, { later: "Destiny points" }],
  [/^Corrupted Mentor$/, /Corrupt Spirit/, { later: "Combat Tools: ability automation" }],
  [/^Coward$/, /run in terror/, { later: "Combat Tools: frightened movement" }],
  [/^Curse of Punishment$/, /./, { later: "Combat Tools: dying at 0 Recoveries" }],
  [/^Doomsight$/, /negative of your winded value/, { later: "Death Tracker: hero deaths" }],
  [/^Tough But Withered$/, /negative of your winded value/, { later: "Death Tracker: hero deaths" }],
  [/^Glancing Bow$/, /./, { later: "Companion" }],
  [/^Guess It['’]s the Hard Way Then$/, /./, { later: "Surprised" }],
  [/^Infernal Contract$/, /present for a battle/, { later: "Surprised" }],
  [/^Leader Formation$/, /./, { later: "Summoner" }],
  [/^Rampage$/, /spends ferocity|gains 8 rampage/, { later: "Companion rampage" }],

  [/^Caustic Alchemy$/, /./, { kind: "augment" }],
  [/^Chimeric Manifestation$/, /./, { kind: "augment" }],
  [/^Minion Chain$/, /./, { kind: "augment" }],
  [/^Shifting Ring$/, /teleport/, { kind: "augment" }],
  [/^Rampage$/, /increases their size/, { kind: "augment" }],
  [/^Control the Elements$/, /./, { kind: "augment", note: "Summoner" }],
  [/^Elemental Affinity$/, /./, { kind: "augment", note: "Summoner" }],

  [/^(?:Engrossing Monologue|Famous Relative|Formal Introductions|Grifter|Honor Among Thieves|Host Body|Hunted|Indebted|Fiery Ideal)$/, /./, { kind: "outOfCombat" }],
  [/^Pack Harness$/, /activate this armor/, { kind: "outOfCombat" }],
  [/^Doomsight$/, /encounter begins/, { kind: "outOfCombat" }],

  [/^Boren$/, /hybrid form/, { trigger: "You use your Aspect of the Wild ability", note: "Revisit with Enhanced: the Hybrid Form choice" }],
  [/^Allow Me to Introduce/, /first turn/, { trigger: "You start your turn", clause: { firstTurn: true } }],
  [/^Volant$/, /winded or reduces them to 0 Stamina/, { trigger: "The self deals damage to a creature", clause: { damageOutcome: ["winded", "zero"] } }],
  [/^Elemental Buffer$/, /damage immunity/, { trigger: "You take acid, cold, corruption, fire, lightning, poison, or sonic damage", clause: { reducedByImmunity: true } }],
  [/^Master of Reels$/, /2 or more squares away/, { trigger: "You deal damage to a creature", clause: { rangeMin: 2, notForceMoved: true } }],
  [/^Foes as Weapons$/, /grabbed/, { trigger: "You use your Melee Free Strike ability", clause: { ownerGrabbing: "sameOrSmaller" } }],
  [/^Ease Their Fall$/, /./, { trigger: "A creature within 2 squares would take damage", clause: { fromFalling: true, damageReduction: { base: 2, char: "reason" } } }],
  [/^I['’]ve Got You$/, /./, { trigger: "An ally adjacent to you falls", clause: { scope: "ALLY", fallSafe: true }, note: "Willingness is confirmed by hand" }],
  [/^(?:Corven|Chain of the Sea and Sky)$/, /^(?:Additionally, )?whenever you fall/i, { clause: { fallCancel: true } }],

  [/^(?:Gum Up the Works|Mortal Coil|Open Book|Quantum Satchel|Refugee|Requisition|Scannerstone|Ventriloquist|Vow of Honesty)$/, /./, { drop: true }],
  [/^Master Chef$/, /when you retire/, { drop: true }],
  [/^Passionate Artisan$/, /stirred by a passion/, { drop: true }],
  [/^Master of Fire$/, /melt a treasure/, { drop: true }],
  [/^Master of Green$/, /Life Fruit/, { drop: true }],
  [/^Perseverance$/, /you are slowed/, { drop: true }],
  [/^Quick Gate$/, /etch an arcane circle/, { drop: true }],
  [/^Telepathic Speech$/, /communicate with someone this way/, { drop: true }],
  [/^Vengeance Mark$/, /place a sigil/, { drop: true }],

  [/^Masterwork$/, /last ability you use/, { kind: "outOfCombat" }],
  [/^Pirate$/, /pirates or pirate hunters/, { kind: "outOfCombat" }],
  [/^Scene Partner$/, /exceed the limit/, { kind: "outOfCombat" }],
  [/^Strange Inheritance$/, /Wealth exceeds/, { kind: "outOfCombat" }],
  [/^Wyrding$/, /comes adjacent to the surface|create the seal/, { kind: "outOfCombat" }],

  [/^Cryokinetic Mastery$/, /untyped damage with a psionic ability/, { kind: "augment", note: "Combat Tools" }],
  [/^King['’]s Roar$/, /cause the shield to roar/, { kind: "augment" }],
  [/^Kuran['’]zoi Prismscale$/, /^Additionally, (?:when|whenever) you capture a moment/, { kind: "augment" }],
  [/^Paper Trappings$/, /paper thin|return to your true form/, { kind: "augment" }],
  [/^Rex Scepter$/, /command using the scepter/, { kind: "augment" }],
  [/^Sanctuary Horn$/, /teleported by this horn/, { kind: "augment" }],

  [/^(?:Demon Slayer|Made of Teeth)$/, /physical contact/, { later: "Rules question: physical contact" }],
  [/^Lifebonded$/, /When they die/, { trigger: "The creature you are bound to dies", later: "Who you are bound to" }],
  [/^Lightning Soul$/, /you are wet/, { later: "Combat Tools: the wet effect" }],
  [/^Marauder of the Primordial Chaos$/, /first becomes aware/, { later: "Potency tests" }],
  [/^Melee Superiority$/, /opportunity attack/, { later: "Opportunity attacks" }],
  [/^Mindlink$/, /linked creature spends/, { later: "Linked creatures" }],
  [/^Mundane$/, /more than three magic treasures/, { later: "Combat Tools: ability automation" }],
  [/^(?:No Matter the Cost|Soul Flense)$/, /./, { later: "Summoner" }],
  [/^Piety$/, /praying for piety/, { later: "Praying for piety" }],
  [/^Rampage$/, /size is increased this way/, { later: "Combat Tools: Rampage" }],
  [/^Revenger['’]s Wrap$/, /three or more creatures marked for revenge/,{ later: "Combat Tools: ability automation" }],
  [/^Vuken$/, /hybrid form/, { later: "Combat Tools: the Hybrid Form choice" }],

  [/^Flying Circus$/, /willing ally on their turn/, { triggers: [["An ally starts their turn adjacent to you"], ["An ally moves adjacent to you", { arrives: true }]],
    note: "Willingness is confirmed by hand" }],
  [/^Goaded$/, /marked by you uses a strike/, { clause: { scope: "SELF_OR_ALLY", qualifiers: [], lineOfEffect: undefined, redirect: "chooser", redirectPool: "selfOrAlly" } }],
  [/^Cryokinetic Mastery$/, /grab a creature or an enemy moves/, { trigger: "You grab a creature", note: "Null Field half: Later (zones)" }],
  [/^Disciple of the Green$/, /outcome on a melee free strike/, { clause: { abilityDsid: "melee-free-strike" } }],
  [/^Loner$/, /reduces one of your allies to 0 Stamina/, { trigger: "An ally takes damage", clause: { damageOutcome: ["zero"] },
    note: "The taunt ends by hand when the ally is above 0 Stamina" }],
  [/^The Lists of Heaven$/, /allow another creature to spend a Recovery/, { trigger: "An ally spends a Recovery", clause: { recoveryByOwner: true } }],
  [/^Lance of the Sundered Star$/, /allows you to push a target/, { trigger: "You push a creature", clause: { abilityKeywords: ["weapon"] } }],
  [/^Lance of the Sundered Star$/, /allows you to push or slide a target/, { trigger: "You push a creature", clause: { abilityKeywords: ["weapon"], fmType: ["push", "slide"] } }],
  [/^Thunderhead Bident$/, /any ability that pushes a target/, { triggers: [["You push a creature", { abilityKeywords: ["weapon"] }],
    ["You deal damage", { abilityKeywords: ["weapon"], notForceMoved: true }]] }],
  [/^Death From Above$/, /due to high ground/, { trigger: "You deal damage", clause: { highGround: true, damageBonus: 8 } }],
];

const curatedLine = (name, sentence) => CURATED_LINES.find(([n, s]) => n.test(name) && s.test(sentence))?.[2] ?? null;

const LIST_LEAD =/\b(?:spend (\d+) ([\w’'-]+(?: resource)?) to )?(?:take|use) one of the following (free )?triggered actions?\b/i;
const LIST_ITEM = /^(?:when|whenever|if|each time)\s+(.+?),\s*(.+)$/i;

const EFFECT_COST = /^(?:you can )?spend (\d+) ([\w’'-]+(?: resource)?) to\b/i;

function collectLines(html, tier, { gains, base, lines, keys, ownerName, dsid, name = "", skip = new Set() }) {
  let lead = null;
  let leads = 0;
  let benefitsOf = null;
  let earlier = null;
  let skipping = false;
  for (const raw of blocksOf(html)) {
    const li = raw.startsWith(LI);
    const block = li ? raw.slice(1).trim() : raw;
    
    const label = skip.size ? block.match(/^([^:]{2,40}):(?:\s|$)/)?.[1] : null;
    if (label) skipping = skip.has(plainWords(label));
    else if (li) skipping = false;
    if (skipping) {
      benefitsOf = null;
      continue;
    }
    if (li && benefitsOf) {
      benefitsOf.effect = `${benefitsOf.effect} • ${block}`;
      continue;
    }
    benefitsOf = null;
    if (!li) {
      const m = block.match(LIST_LEAD);
      lead = m ? { action: m[3] ? "freeTriggered" : "triggered", cost: m[1] ? { amount: Number(m[1]), resource: m[2].toLowerCase() } : null,
        group: `${generateDSID(base)}-list-${++leads}` } : null;
    }
    const sentences = sentencesOf(block);
    const found = [];
    const item = li && lead ? sentences[0].match(LIST_ITEM) : null;
    if (item) found.push({ index: 0, sentence: sentences[0], trigger: cleanCondition(item[1]), effect: item[2], action: lead.action, cost: lead.cost, exclusive: lead.group });
    else sentences.forEach((sentence, index) => {
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
      if (!spends && (BACKSTORY.test(trigger) || ACTIVATION.test(trigger))) return;
      found.push({ index, sentence, trigger, effect: parts.effect, action: free ? "freeTriggered" : spends ? "triggered" : null });
    });
    let previous = null;
    const fromEarlier = earlier;
    found.forEach((f, i) => {
      const next = found[i + 1]?.index ?? sentences.length;
      const effect = [f.effect, ...sentences.slice(f.index + 1, next)].join(" ").replace(/\s+/g, " ").trim();
      if (!f.action && !MECHANICS.test(effect)) return;
      
      const restated = plainWords(f.trigger).replace(/^you /, "");
      const byYou = /^you\b/.test(plainWords(f.trigger).replace(/^(?:additionally|also|then) /, ""));
      const host = byYou ? null : previous ?? fromEarlier;
      if (host && !f.action && restated.split(" ").length >= 2 && plainWords(host.effect).includes(restated)) {
        host.effect = `${host.effect} ${f.sentence}`.trim();
        return;
      }
      const pick = curatedLine(name, f.sentence) ?? {};
      if (pick.drop) return;
      const curated = { ...(CURATED[dsid || generateDSID(base)] ?? {}), ...pick };
      const kind = curated.later ? "later" : curated.kind ?? (OUT_OF_COMBAT.test(f.sentence) ? "outOfCombat" : !f.action && AUGMENT.test(f.trigger) ? "augment" : "trigger");
      const once = curated.once ?? onceOf(f.sentence) ?? (/\buntil the end of the round\b/i.test(effect) ? "round" : null);
      const parseText = curated.trigger ?? (ownerName ? asOwner(f.trigger, ownerName) : f.trigger);
      let key = generateDSID(`${base} ${f.trigger}`).slice(0, 80) + (tier ? `-t${tier.min}` : "");
      for (let n = 2; keys.has(key); n++) key = `${key.replace(/~\d+$/, "")}~${n}`;
      keys.add(key);
      const flavor = i === 0 ? sentences.slice(0, f.index).join(" ").trim() : "";
      const paid = effect.match(EFFECT_COST);
      const cost = f.cost ?? (paid ? { amount: Number(paid[1]), resource: paid[2].toLowerCase() } : null);
      const parseOne = (text) => parseTrigger(`${text}.`, { effectText: effect, ownerName, side: ownerName ? "monster" : "hero" });
      let parse;
      if (curated.triggers) {
        const parts = curated.triggers.map(([text, patch]) => ({ p: parseOne(text), patch }));
        parse = { ...parts[0].p, clauses: parts.flatMap(({ p, patch }) => p.clauses.map((c) => ({ ...c, ...(patch ?? {}) }))),
          confidence: parts.every(({ p }) => p.confidence === "high") ? "high" : "low" };
      } else parse = parseOne(parseText);
      if (curated.clause) {
        parse.clauses = parse.clauses.map((c) => ({ ...c, ...curated.clause }));
        
        if (parse.clauses.every((c) => c.event !== "UNKNOWN" && c.scope !== "UNKNOWN")) parse.confidence = "high";
      }
      if (!curated.note && !curated.later && parse.clauses.length > 1 && parse.clauses.some((c) => c.scope === "COMPANION")) curated.note = "Companion half: Later";
      const line = { key, sentence: f.sentence, action: f.action, kind, once, trigger: f.trigger, effect, flavor,
        ...(cost ? { cost } : {}), ...(f.exclusive ? { exclusive: f.exclusive } : {}),
        ...(curated.later ? { later: curated.later } : {}), ...(curated.note ? { note: curated.note } : {}),
        parse, tier, family: tier ? generateDSID(f.trigger) : null };
      lines.push(line);
      previous = line;
      earlier = line;
      if (i === found.length - 1 && /:$/.test(effect)) benefitsOf = line;
    });
  }
}
