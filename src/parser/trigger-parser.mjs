

export const SPECIAL_CASES = {
  
  "your-fears-become-manifest": { clauses: [{ event: "ROUND_START", scope: "ANY" }] },
  "stinging-departure":         { clauses: [{ event: "GRAB_ENDS", scope: "SELF" }] },
  "blood-for-blood":            { clauses: [{ event: "CONDITION_GAIN", scope: "ALLY", qualifiers: ["bleeding", "by the target"] }] },
  "wasnt-aiming-for-you":       { clauses: [{ event: "POWER_ROLL_RESULT", scope: "SELF", qualifiers: ["tier 1", "signature ability"] }] },
  "brain-drain":                { clauses: [{ event: "RESISTS_POTENCY", scope: "GRABBED_CREATURE" }] },
  "still-your-tongue":          { clauses: [{ event: "NARRATIVE", scope: "ANY" }] },
  "timely-distraction":         { clauses: [{ event: "TEST_FAILED", scope: "ALLY" }] },
  "hesitation-is-weakness":     { clauses: [{ event: "TURN_END", scope: "ALLY", qualifiers: [], ownerUnacted: true }] },
  "prescient-grace":            { clauses: [{ event: "TURN_START", scope: "ENEMY", qualifiers: ["within 10 squares"], anyHeroUnacted: true }] },
  "you-would-flounder-your-assault-on-me": { clauses: [{ event: "REGAINS_STAMINA", scope: "ANY", qualifiers: ["within 10"] }] },
  "put-it-out": { clauses: [{ event: "USES_ABILITY", scope: "ENEMY", qualifiers: ["ability that emits light"] }], flag: "REVISIT" },
  "is-this-what-they-taught-you": { clauses: [{ event: "MARKED", scope: "SELF" }], flag: "DSCT_ONLY" },
  "your-obsession-with-me-betrays-you": { clauses: [{ event: "RESOURCE_GAIN", scope: "ANY", qualifiers: ["ferocity or wrath", "caused by self"] }], flag: "REVISIT" },
  "abyssal-protectors": { clauses: [{ event: "DIES", scope: "ALLY", qualifiers: ["last minion on map"] }, { event: "STAMINA_BELOW", scope: "SELF", value: 25 }], flag: "REVISIT" },
  "nova": { clauses: [{ event: "DIES", scope: "OBJECT", qualifiers: ["the throne"] }, { event: "POWER_ROLL_RESULT", scope: "SELF", qualifiers: ["tier 1 on deactivation test"] }], flag: "REVISIT" },
  
  "heavy-gate": { clauses: [{ event: "MECHANISM", scope: "ANY" }] },
  "ram":        { clauses: [{ event: "MECHANISM", scope: "ANY" }] },
  "dart":       { clauses: [{ event: "MECHANISM", scope: "ANY" }] },
  "dart-gatling-darts": { clauses: [{ event: "MECHANISM", scope: "ANY" }] },
};

export function generateDSID(name) {
  return name.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ---------- Layer 3: damage-modifying abilities ----------
// Curated from the 2026-09-04 compendium sweep (vault/interrupt-sweep.json): triggered
// abilities whose effect halves, reduces, or blocks the triggering damage. Their damage
// must be held BEFORE it lands, so TAKES_DAMAGE clauses upgrade to WOULD_TAKE_DAMAGE.
export const DAMAGE_MODIFYING = new Set([
  "adaptability", "armor-of-corpses", "armor-of-the-ancients", "break-armor", "buss-buffer",
  "dissipate", "field-collapse", "in-all-this-confusion", "inertial-absorption", "inertial-shield",
  "instant-retaliation", "meat-shield", "mind-requital", "night-watch", "parry",
  "precognitive-shift", "psionic-retribution", "resist-the-unnatural", "shadow-veil", "shield-block",
  "skin-like-castle-walls", "skitter", "stalkers-afterimage", "striking-afterimage", "synaptic-anchor",
  "unearthly-reflexes", "withdraw", "zephyr-feint",
]);

// Targeting-based halvers: the owner IS the strike target and the decision happens
// at roll time (lock flow), so the damage button itself gets pre-halved instead of
// holding the damage at apply time. Owner-is-not-target modifiers (Intercede,
// Trick of the Eye, Testudo) stay lock-only for now.
export const TARGETED_HALVERS = new Set(["shriek", "pain-absorption", "devilish-charm"]);

const DAMAGE_MOD_TEXT = [
  /\bhalves? (?:the |that |this |any )?(?:\w+ )?damage\b/i,
  /\bhalf (?:the |that |this |of the |any )?damage\b/i,
  /\bdamage (?:is |taken is )?halved\b/i,
  /\b(?:reduce[sd]?|decrease[sd]?|lower[sd]?) (?:the |that |this |any |incoming )?damage\b/i,
  /\btakes? no damage\b/i,
  /\bignores? (?:the |that |this )?damage\b/i,
  /\b(?:damage )?immunity (?:\d+|equal to)\b/i,
];

export function isDamageModifyingText(text) {
  return !!text && DAMAGE_MOD_TEXT.some((rx) => rx.test(text));
}

// "the target" in trigger text points at the ability's own Target field, so a

const TARGET_TYPE_SCOPES = {
  self: "SELF",
  ally: "ALLY",
  selfAlly: "SELF_OR_ALLY",
  selfOrAlly: "SELF_OR_ALLY",
  selfOrCreature: "ANY",
  creature: "ANY",
  creatureObject: "ANY",
  enemy: "ENEMY",
  enemyObject: "ENEMY",
  object: "OBJECT",
};

function resolveTargetScope(result, targetType) {
  const scope = TARGET_TYPE_SCOPES[targetType];
  if (!scope || !result.clauses.some((c) => c.scope === "TARGET")) return result;
  return { ...result, clauses: result.clauses.map((c) => c.scope === "TARGET" ? { ...c, scope } : c) };
}

function damageModLayer(result, id, effectText) {
  if (TARGETED_HALVERS.has(id)) {
    return {
      ...result,
      damageModifying: true,
      targetedHalf: true,
      clauses: result.clauses.map((c) => c.event === "TARGETED_BY_STRIKE" ? { ...c, targetedHalf: true } : c),
    };
  }
  if (!DAMAGE_MODIFYING.has(id) && !isDamageModifyingText(effectText)) return result;
  let upgraded = 0;
  const clauses = result.clauses.map((c) => {
    if (c.event !== "TAKES_DAMAGE") return c;
    upgraded++;
    const next = { ...c, event: "WOULD_TAKE_DAMAGE" };
    if (c.events) next.events = c.events.map((e) => e === "TAKES_DAMAGE" ? "WOULD_TAKE_DAMAGE" : e);
    return next;
  });
  if (!upgraded) return result;
  return { ...result, damageModifying: true, clauses };
}

const REDIRECT_ABILITIES = {
  "clever-trick": "chooser",
  "intercede": "self",
  "reverse-card": "reflect",
  "scuse-me-boss": "swap",
  "no": "self",
  "guardian-block": "self",
  "intercepting-shield": "self",
  "redirected-charm": "after",
  "reactive-charm": "after",
};

const REDIRECT_TEXT = [
  [/switch(?:es)? places/i, "swap"],
  [/choose[\s\S]{0,90}?targets? (?:that|the) (?:enemy|creature) instead|chooses?[\s\S]{0,90}?to become the target/i, "chooser"],
  [/targeting them instead|reflects?[\w'’ ]* back/i, "reflect"],
  [/becomes? the target|is the (?:strike|ability)['’]?s? new target|become the target instead/i, "self"],
];

const ROLL_MOD_TEXT = [
  [/\b(?:strike|triggering strike|it) (?:takes?|has|gains?) a double bane\b/i, { banes: 2 }],
  [/\b(?:strike|triggering strike|it) (?:takes?|has|gains?) a bane\b/i, { banes: 1 }],
  [/\b(?:strike|triggering strike|it) (?:takes?|has|gains?) a double edge\b/i, { edges: 2 }],
  [/\b(?:strike|triggering strike|it) (?:takes?|has|gains?) an edge\b/i, { edges: 1 }],
];

function rollModLayer(result, id, effectText) {
  if (!effectText || !result.clauses.some((c) => c.postRoll)) return result;
  let mod = null;
  for (const [rx, m] of ROLL_MOD_TEXT) {
    if (rx.test(effectText)) { mod = m; break; }
  }
  if (!mod) return result;
  return {
    ...result,
    rollModifying: true,
    clauses: result.clauses.map((c) => c.postRoll ? { ...c, rollMod: mod } : c),
  };
}

const HALF_TEXT = [
  /\bhalves? (?:the |that |this |any )?(?:\w+ )?damage\b/i,
  /\bhalf (?:the |that |this |of the |any )?damage\b/i,
  /\bdamage (?:is |taken is )?halved\b/i,
];

function postRollHalfLayer(result, id, effectText) {
  if (!effectText || !result.clauses.some((c) => c.postRoll)) return result;
  if (!HALF_TEXT.some((rx) => rx.test(effectText))) return result;
  return {
    ...result,
    damageModifying: true,
    clauses: result.clauses.map((c) => c.postRoll ? { ...c, halfOnUse: true } : c),
  };
}

function redirectLayer(result, id, effectText) {
  let mode = REDIRECT_ABILITIES[id] ?? null;
  if (!mode && effectText) {
    for (const [rx, m] of REDIRECT_TEXT) {
      if (rx.test(effectText)) { mode = m; break; }
    }
  }
  if (!mode) return result;
  let stamped = 0;
  const clauses = result.clauses.map((c) => {
    if (c.event !== "TARGETED_BY_STRIKE") return c;
    stamped++;
    return { ...c, redirect: mode };
  });
  if (!stamped) return result;
  return { ...result, clauses, redirect: mode };
}

const EVENTS = [
  ["DIES",            /\b(dies|would die|is destroyed|enough damage to (die|be destroyed)|reduced? [^,]*?to 0 stamina|reduces? [^,]*?to 0 stamina|to 0 stamina)\b/i],
  ["WINDED_OR_DYING", /\b(winded|dying)\b/i],
  ["WOULD_TAKE_DAMAGE", /\bwould take damage\b/i],
  ["FORCE_MOVED",     /\b(is |are |be |being )?(force(d)? moved|pushed|pulled|slid)\b/i],
  ["FORCE_MOVES",     /\bforce moves?\b/i],
  ["TAKES_DAMAGE",    /\b(takes? (?:[\w-]+(?:,? or | ?, | ))*damage|loses? stamina|is damaged|damages? (you|the target|them|it|an ally|the \w+)|deals? ([\w, ]+ )?damage to (you|the target|an ally|any ally|an enemy|the \w+))/i],
  ["DEALS_DAMAGE",    /\b(deals? ([\w, ]+ )?damage|deals? rolled damage|damages? (a|an|another|any) )\b/i],
  ["TARGETED_BY_STRIKE", /\b(targets? (you|them|the target|an ally|an enemy|the \w+)\b|is targeted|targeted by|is struck by|makes? an? (melee |ranged )?strike against|strikes? (you|the target|the \w+))/i],
  ["MAKES_STRIKE",    /\bmakes? an? (melee |ranged )?strike( against (a|an|another|any) )?\b/i],
  ["POWER_ROLL_RESULT", /\b(obtains? a tier \d outcome|tier \d (outcome|result)|(?<!isn['’]t a |not a )critical hit|natural (19|20))\b/i],
  ["POWER_ROLL",      /\b(makes? an? (ability|power) roll|power roll|ability roll)\b/i],
  ["USES_ABILITY",    /\b(uses? (a|an|any|their|its|the|your) [^,]*?(ability|action|maneuver)|uses? [^,]*?ability)\b/i],
  ["TURN_START",      /\b(starts? (their|its|his|her|a|the)? ?turn|turn starts|start of (their|its|a|the) turn)\b/i],
  ["TURN_END",        /\b(ends? (their|its|his|her|a|the)? ?turn|turn ends|end of (their|its|a|the) turn)\b/i],
  ["ROUND_START",     /\bnew round starts\b/i],
  ["MOVES",           /\b(moves?|enters?|leaves?|exits?|shifts?|flies|comes within|ends? (their|its) (movement|move)|willingly)\b/i],
  ["CONDITION_GAIN",  /\b(gains? (a|the) condition|is subject to an effect|gains? [^,]*condition|becomes? (grabbed|restrained|frightened|taunted|prone|slowed|weakened|dazed|bleeding)|is (grabbed|restrained|frightened|taunted|knocked prone|made bleeding)|falls prone|grabs)\b/i],
  ["SAVING_THROW",    /\bsaving throw\b/i],
  ["REGAINS_STAMINA", /\bregains? stamina\b/i],
  ["EFFECT_ENDS",     /\bends? the [\w -]+ effect\b/i],
  ["ZONE_ENTER",      /\benters? (the|a) [\w -]+\b/i],
  ["ZONE_TURN_START", /\bstarts? their turn (there|in|within|adjacent)\b/i],
];
const SHADOW = {
  TAKES_DAMAGE: ["WOULD_TAKE_DAMAGE", "DIES", "WINDED_OR_DYING"],
  DEALS_DAMAGE: ["TAKES_DAMAGE", "DIES", "WOULD_TAKE_DAMAGE"],
  USES_ABILITY: ["TARGETED_BY_STRIKE", "POWER_ROLL", "DEALS_DAMAGE", "TAKES_DAMAGE"],
  TARGETED_BY_STRIKE: ["TAKES_DAMAGE", "WOULD_TAKE_DAMAGE", "POWER_ROLL", "MAKES_STRIKE", "POWER_ROLL_RESULT"],
  DIES: ["POWER_ROLL_RESULT"],
  MAKES_STRIKE: ["POWER_ROLL", "POWER_ROLL_RESULT"],
  TARGETED_BY_STRIKE_BY_MAKES: [],
  WINDED_OR_DYING: ["DIES"],
  POWER_ROLL: ["WOULD_TAKE_DAMAGE", "POWER_ROLL_RESULT"],
  TARGETED_BY_STRIKE_RESULT: [],
  CONDITION_GAIN: ["TURN_START"],
  MOVES: ["FORCE_MOVED", "FORCE_MOVES", "ZONE_ENTER"],
  TURN_START: ["TURN_END", "ZONE_TURN_START"],
  TURN_END: ["CONDITION_GAIN"],
  SAVING_THROW: ["CONDITION_GAIN"],
};

const QUALIFIERS = [
  /within \d+ squares?/, /within (distance|reach)/, /adjacent (to|creature|ally|enemy)/,
  /while [^,]+/, /with an? (melee|ranged|area|triggered) (strike|ability|action)/,
  /(acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic)(, \w+)*(,? or \w+)? damage/,
  /(melee|ranged) strike/, /(main action|maneuver)/, /after seeing the result/, /for the (first|second) time[^,]*/,
  /non-minion|minion|leader|solo|size \d/, /that (isn't|is not|doesn't|has|targets|costs|uses|emits|gains)[^,]*/,
];

const EVENT_VERB = /\b(takes?|deals?|damages?|dies|destroyed|moves?|enters?|leaves?|shifts?|starts?|ends?|uses?|makes?|targets?|targeted|forced?|pushed|pulled|slid|becomes?|gains?|grabs?|regains?|reduced?|winded|dying|falls|flies|comes|obtains?)\b/;

function stripPrefix(t) {
  return t.replace(/^(whenever|when|once per (round|turn) when|after)\s+/i, "").replace(/^while [^,]+,\s*/i, "");
}

function splitClauses(text) {
  const t = stripPrefix(text.trim().replace(/\.$/, ""));
  
  if (/^(the [\w'’ ]+|you) or an ally\b/i.test(t)) return [t];
  
  const qi = t.search(/\b(that|which) \b/);
  if (qi > 0) { const inner = splitClauses(t.slice(0, qi).trim()); inner[inner.length - 1] += " " + t.slice(qi); return inner; }
  const DT = "(?!(?:acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic|untyped)\\b)";
  const parts = t.split(new RegExp(`,\\s*or\\s+${DT}|,\\s+(?=(?:is|are|takes|moves|starts|ends|uses|makes|becomes|gains|dies|would)\\b)|\\s+or\\s+(?=(?:is|are|takes|moves|starts|ends|uses|makes|becomes|gains|dies|would|reduced|falls|damages|obtains|the [\\w]+ obtains)\\b)`, "i"));
  if (parts.length <= 1 || !parts.every(p => EVENT_VERB.test(p.toLowerCase())) || parts.slice(1).some(p => /^(that|which|has|had)\b/i.test(p))) return [t];
  const subjectMatch = t.match(/^((?:the target|you|your companion|(?:a|an|any|one|another) [\w'’ -]+?|the [\w'’ ]+?)(?= (takes?|deals?|damages?|dies|is|are|moves?|enters?|starts?|ends?|uses?|makes?|targets?|would|force|becomes?|gains?|grabs?|regains?|comes|flies|loses?|causes?|obtains?)\b))/i);
  const subject = subjectMatch ? subjectMatch[1] : "";
  return parts.map((p, i) => (i === 0 || !subject || /^(the|you|an?|another|any|one) /i.test(p)) ? p.trim() : (subject + " " + p.trim()));
}

const OWNER_STOPWORDS = new Set(["the", "and", "von", "van", "der", "den", "del", "los", "las"]);

function ownerWords(ownerName) {
  return (ownerName || "").toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !OWNER_STOPWORDS.has(w));
}

function scopeOf(lc, event, owner) {
  const words = ownerWords(owner);
  const mentionsOwner = words.some(w => new RegExp(`\\b${w}\\b`).test(lc));
  const subj = lc.match(/^(you\b|the target\b|your companion\b|the [\w'’ ]+?(?= (takes?|deals?|damages?|dies|is|are|moves?|enters?|starts?|ends?|uses?|makes?|targets?|would|force|becomes?|gains?|grabs?|regains?|comes|flies|loses?|reduced?|reduces?|obtains?|hears|causes?))|(?:an?|one|another|any) [\w -]+?(?: or object)?(?= (takes?|deals?|damages?|dies|is|are|moves?|enters?|starts?|ends?|uses?|makes?|targets?|would|force|becomes?|gains?|grabs?|regains?|comes|flies|loses?|reduced?|reduces?|marks|resists|within)))/);
  const s = subj ? subj[1] : "";
  
  const objectEvents = new Set(["TAKES_DAMAGE", "TARGETED_BY_STRIKE", "WINDED_OR_DYING", "DIES"]);
  const objectSide = /\b(deals? [\w, ]*damage to|damages?|targets?|strike against|strikes?|causes?|reduces?) (you|the target|an ally|any ally|an enemy|a creature|the [\w' ]+|[a-z]+)\b/;
  let affected = s;
  if (objectEvents.has(event) && !/^(you|the target)\b/.test(s) && !/\b(takes?|is targeted|targeted by|is made|is reduced|dies)\b/.test(lc)) {
    const m = lc.match(objectSide); affected = m ? m[2] : s;
  }
  
  if (event === "TAKES_DAMAGE" && /^(the self|you)\b/.test(s) && /\bdamages? (a|an|another) /.test(lc)) {
    return "SELF:DEALS";
  }
  if (/^you\b/.test(affected) || /^the self\b/.test(affected)) return "SELF";
  if (/mentor/.test(affected)) return "MENTOR";
  if (/^(the [\w' ]+|you) or an ally\b/.test(affected) || /^(the [\w' ]+|you) or an ally\b/.test(lc)) return "SELF_OR_ALLY";
  if (/^the target\b/.test(affected)) return "TARGET";
  if (/companion/.test(affected)) return "COMPANION";
  if (/\bally\b|another hero|a hero\b|ally minion/.test(affected)) return "ALLY";
  if (/\benemy\b|rival/.test(affected)) return "ENEMY";
  if (/^the /.test(affected) && (mentionsOwner || words.length === 0 || !/creature|object|target/.test(affected))) return "SELF";
  if (mentionsOwner && !/^(a|an|another|any) /.test(affected)) return "SELF";
  if (/^(a|an|another|any|one) (creature|object|target|hero|sapient|size|non-minion|minion)/.test(affected) || /creature|object/.test(affected)) return "ANY";
  if (/^(a|an|any|one) [\w -]+$/.test(affected) && !/creature|object/.test(affected)) return "GROUP";
  if (/^[a-z]+$/.test(affected) && mentionsOwner) return "SELF";
  return "UNKNOWN";
}

export function parseTrigger(text, { dsid, ownerName, effectText, targetType } = {}) {
  const id = dsid || "";
  const key = ownerName ? `${generateDSID(ownerName)}:${id}` : null;
  const special = (key && SPECIAL_CASES[key]) || SPECIAL_CASES[id];
  if (special) return postRollHalfLayer(rollModLayer(redirectLayer(damageModLayer(resolveTargetScope({ ...special, confidence: "high", source: "special" }, targetType), id, effectText), id, effectText), id, effectText), id, effectText);

  const clean = text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const clauses = [];
  let ambiguous = false;

  const properWords = ownerWords(ownerName).filter(w => new RegExp(`\\b${w[0].toUpperCase()}${w.slice(1)}`).test(clean));
  let normalized = clean;
  for (const w of properWords) normalized = normalized.replace(new RegExp(`\\b(Lord |Queen |King )?${w[0].toUpperCase()}${w.slice(1)}(['’]s)?\\b`, "g"), (m, t, poss) => poss ? "the self's" : "the self");
  normalized = normalized.replace(/^(a|an|one) ([\w -]+?)['’]s turn starts/i, "a $2 starts their turn");
  normalized = normalized.replace(/\b(?:a|an|any|one) (?:creature|enemy|hero)( within \d+ squares?| within (?:distance|reach)| adjacent(?: to [\w'’ ]+?)?)? makes? a (melee |ranged )?strike against ([\w'’ -]+?)(?=[.,]| while| using| with| that|$)/gi,
    (m, qual, kind, tgt) => `${tgt} is struck by a ${kind ?? ""}strike${qual ? ` while${qual}` : ""}`);
  for (const clause of splitClauses(normalized)) {
    const lc = clause.toLowerCase();
    const hits = EVENTS.filter(([, rx]) => rx.test(clause)).map(([e]) => e);
    const events = hits.filter(e => !(SHADOW[e] || []).some(s => hits.includes(s)));
    if (events.length !== 1) ambiguous = true;
    let scope = scopeOf(lc, events[0], ownerName);
    if (scope === "SELF:DEALS") { scope = "SELF"; events.splice(0, events.length, "DEALS_DAMAGE"); }
    if (scope === "UNKNOWN") ambiguous = true;
    const qualifiers = QUALIFIERS.map(rx => lc.match(rx)?.[0]).filter(Boolean);
    const entry = { event: events[0] || "UNKNOWN", events, scope, qualifiers };
    if (/\bis struck by\b/.test(lc)) entry.postRoll = true;
    // structured filters
    const dmgTypes = lc.match(/\b(acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic)\b/g);
    if (dmgTypes && /damage/.test(lc)) entry.damageTypes = [...new Set(dmgTypes)];
    const using = clause.match(/\busing (?:their |its |the )?([A-Z][\w' ]*?)(?=[.,]|$| (?:ability|maneuver|action))/);
    if (using) entry.abilityDsid = generateDSID(using[1]);
    const eff = lc.match(/ends? the ([\w -]+?) effect/); if (eff) entry.effectName = eff[1];
    const zone = lc.match(/\b(?:enters?|starts? their turn (?:in|within|adjacent to)) (?:the|a) ([\w -]+?)(?: or|,|$)/); if (zone) entry.zone = zone[1];
    if (/\b(gains? (an|a double) edge|has an edge|with an edge)\b/.test(lc)) entry.edgeRequired = true;
    if (/\bsaving throw\b|ends? at the end of their turn/.test(lc) && entry.event === "CONDITION_GAIN") entry.durationFilter = "save-or-eot";
    if (scope === "GROUP") entry.groupName = lc.match(/^(?:a|an|any|one) ([\w -]+?) (?:within|adjacent|is|takes|dies|starts|moves)/)?.[1];
    clauses.push(entry);
  }
  return postRollHalfLayer(rollModLayer(redirectLayer(damageModLayer(resolveTargetScope({ clauses, confidence: ambiguous ? "low" : "high", source: "regex" }, targetType), id, effectText), id, effectText), id, effectText), id, effectText);
}
