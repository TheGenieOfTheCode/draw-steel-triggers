

export const SPECIAL_CASES = {
  
  "your-fears-become-manifest": { clauses: [{ event: "ROUND_START", scope: "ANY" }] },
  "stinging-departure":         { clauses: [{ event: "GRAB_ENDS", scope: "SELF", asSource: true }] },
  "blood-for-blood":            { clauses: [{ event: "CONDITION_GAIN", scope: "ALLY", qualifiers: ["bleeding", "by the target"], condition: "bleeding" }] },
  "wasnt-aiming-for-you":       { clauses: [{ event: "POWER_ROLL_RESULT", scope: "SELF", qualifiers: ["tier 1", "signature ability"] }] },
  "brain-drain":                { clauses: [{ event: "RESISTS_POTENCY", scope: "GRABBED_CREATURE" }] },
  "still-your-tongue":          { clauses: [{ event: "NARRATIVE", scope: "ANY" }] },
  "timely-distraction":         { clauses: [{ event: "TEST_FAILED", scope: "ALLY" }] },
  "hesitation-is-weakness":     { clauses: [{ event: "TURN_END", scope: "ALLY", qualifiers: [], ownerUnacted: true, turnLock: true }] },
  "prescient-grace":            { clauses: [{ event: "TURN_START", scope: "ENEMY", qualifiers: ["within 10 squares"], anyHeroUnacted: true, turnLock: true }] },
  "you-would-flounder-your-assault-on-me": { clauses: [{ event: "REGAINS_STAMINA", scope: "ANY", qualifiers: ["within 10"] }] },
  "put-it-out": { clauses: [{ event: "USES_ABILITY", scope: "ENEMY", qualifiers: ["ability that emits light"] }], flag: "REVISIT" },
  "is-this-what-they-taught-you": { clauses: [{ event: "MARKED", scope: "SELF" }], flag: "DSCT_ONLY" },
  "your-obsession-with-me-betrays-you": { clauses: [{ event: "RESOURCE_GAIN", scope: "ANY", qualifiers: ["ferocity or wrath", "caused by self"] }], flag: "REVISIT" },
  "abyssal-protectors": { clauses: [{ event: "DIES", scope: "ALLY", qualifiers: ["last minion on map"], lastMinion: true, range: "none" }, { event: "STAMINA_BELOW", scope: "SELF", value: 25 }] },
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
  "precognitive-shift", "psionic-retribution", "repel", "resist-the-unnatural",
  "shadow-veil", "shield-block", "skin-like-castle-walls", "skitter", "stalkers-afterimage", "striking-afterimage", "synaptic-anchor",
  "unearthly-reflexes", "withdraw", "zephyr-feint",
]);

// Targeting-based halvers: the owner IS the strike target and the decision happens
// at roll time (lock flow), so the damage button itself gets pre-halved instead of
// holding the damage at apply time. Owner-is-not-target modifiers (Intercede,
// Trick of the Eye, Testudo) stay lock-only for now.
export const TARGETED_HALVERS = new Set(["shriek", "pain-absorption"]);

// The Devilish variants keep their half/bane inside their OWN power roll's tier

const BESPOKE_EFFECTS = new Set(["devilish-charm", "devilish-suggestion"]);

function bespokeLayer(result, id) {
  if (!BESPOKE_EFFECTS.has(id)) return result;
  const { targetedHalf, rollModifying, damageModifying, ...rest } = result;
  return {
    ...rest,
    bespokeEffect: true,
    clauses: result.clauses.map(({ targetedHalf: _th, rollMod, halfOnUse, ...c }) => c),
  };
}

export const DAMAGE_MOD_TEXT = [
  /\bhalves? (?:the |that |this |any )?(?:\w+ )?damage\b/i,
  /\bhalf (?:the |that |this |of the |any )?(?:\w+ )?damage\b/i,
  /\bdamage (?:is |taken is )?halved\b/i,
  /\b(?:reduce[sd]?|decrease[sd]?|lower[sd]?) (?:the |that |this |any |incoming )?damage\b/i,
  /\btakes? no damage\b/i,
  /\bignores? (?:the |that |this )?damage\b/i,
  /\b(?:damage )?immunity (?:\d+|equal to)\b/i,
];

export function isDamageModifyingText(text) {
  return !!text && DAMAGE_MOD_TEXT.some((rx) => rx.test(text));
}

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

const TARGETING_EVENTS = new Set(["TARGETED_BY_STRIKE", "TARGETED_BY_ABILITY"]);

function resolveTargetScope(result, targetType) {
  const scope = TARGET_TYPE_SCOPES[targetType];
  if (!scope || !result.clauses.some((c) => c.scope === "TARGET")) return result;
  return { ...result, clauses: result.clauses.map((c) => c.scope === "TARGET" ? { ...c, scope } : c) };
}

const carries = (clause, event) => clause.event === event || !!clause.events?.includes(event);

function damageModLayer(result, id, effectText) {
  if (TARGETED_HALVERS.has(id)) {
    return {
      ...result,
      damageModifying: true,
      targetedHalf: true,
      clauses: result.clauses.map((c) => TARGETING_EVENTS.has(c.event) ? { ...c, targetedHalf: true } : c),
    };
  }
  if (!DAMAGE_MODIFYING.has(id) && !isDamageModifyingText(effectText)) return result;
  let upgraded = 0;
  const clauses = result.clauses.map((c) => {
    if (!carries(c, "TAKES_DAMAGE")) return c;
    upgraded++;
    const next = { ...c, event: c.event === "TAKES_DAMAGE" ? "WOULD_TAKE_DAMAGE" : c.event };
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

export const REDIRECT_TEXT = [
  [/switch(?:es)? places/i, "swap"],
  [/choose[\s\S]{0,90}?targets? (?:that|the) (?:enemy|creature) instead|chooses?[\s\S]{0,90}?to become the target/i, "chooser"],
  [/targeting them instead|reflects?[\w'’ ]* back/i, "reflect"],
  [/becomes? the target|is the (?:strike|ability)['’]?s? new target|become the target instead/i, "self"],
];

const ROLL_MOD_SUBJECT = "(?:triggering )?(?:strike|power roll|ability roll)|it";

export const ROLL_MOD_TEXT = [
  [new RegExp(`\\b(?:${ROLL_MOD_SUBJECT}) (?:takes?|has|gains?) a bane\\b`, "i"), { banes: 1 }],
  [/\btakes? a bane on (?:the |their |that )?(?:triggering )?(?:strike|power roll|ability roll)\b/i, { banes: 1 }],
  [new RegExp(`\\b(?:${ROLL_MOD_SUBJECT}) (?:takes?|has|gains?) an edge\\b`, "i"), { edges: 1 }],
  [/\b(?:takes?|has|gains?) an edge on (?:the |their |that )?(?:triggering )?(?:strike|power roll|ability roll)\b/i, { edges: 1 }],
  [new RegExp(`\\b(?:${ROLL_MOD_SUBJECT}) (?:takes?|has|gains?) a double bane\\b`, "i"), { banes: 2 }],
  [/\btakes? a double bane on (?:the |their |that )?(?:triggering )?(?:strike|power roll|ability roll)\b/i, { banes: 2 }],
  [new RegExp(`\\b(?:${ROLL_MOD_SUBJECT}) (?:takes?|has|gains?) a double edge\\b`, "i"), { edges: 2 }],
  [/\b(?:takes?|has|gains?) a double edge on (?:the |their |that )?(?:triggering )?(?:strike|power roll|ability roll)\b/i, { edges: 2 }],
];

const PREROLL_MOD_EVENTS = new Set(["TARGETED_BY_STRIKE", "TARGETED_BY_ABILITY", "MAKES_STRIKE", "POWER_ROLL"]);

function rollModLayer(result, id, effectText) {
  if (!effectText) return result;
  const applies = (c) => c.postRoll || PREROLL_MOD_EVENTS.has(c.event);
  if (!result.clauses.some(applies)) return result;
  let mod = null;
  for (const [rx, m] of ROLL_MOD_TEXT) {
    if (rx.test(effectText)) { mod = m; break; }
  }
  if (!mod) return result;
  return {
    ...result,
    rollModifying: true,
    clauses: result.clauses.map((c) => applies(c) ? { ...c, rollMod: mod } : c),
  };
}

export const HALF_TEXT = [
  /\bhalves? (?:the |that |this |any )?(?:\w+ )?damage\b/i,
  /\bhalf (?:the |that |this |of the |any )?(?:\w+ )?damage\b/i,
  /\bdamage (?:is |taken is )?halved\b/i,
];

const HALF_IS_A_QUANTITY = /\bequal to half\b/i;

const halvesDamage = (text) => !!text && !HALF_IS_A_QUANTITY.test(text) && HALF_TEXT.some((rx) => rx.test(text));

function postRollHalfLayer(result, id, effectText) {
  if (!effectText || !result.clauses.some((c) => c.postRoll)) return result;
  if (!halvesDamage(effectText)) return result;
  return {
    ...result,
    damageModifying: true,
    clauses: result.clauses.map((c) => c.postRoll ? { ...c, halfOnUse: true } : c),
  };
}

function holdHalfLayer(result, id, effectText) {
  if (!effectText || !result.clauses.some((c) => carries(c, "WOULD_TAKE_DAMAGE"))) return result;
  if (!halvesDamage(effectText)) return result;
  return {
    ...result,
    clauses: result.clauses.map((c) => carries(c, "WOULD_TAKE_DAMAGE") ? { ...c, halfDamage: true } : c),
  };
}

function rangeLayer(result) {
  let stamped = 0;
  const clauses = result.clauses.map((c) => {
    if (c.range !== undefined || c.zone) return c;
    for (const q of c.qualifiers ?? []) {
      const within = q.match(/within (\d+)/);
      if (within) { stamped++; return { ...c, range: Number(within[1]) }; }
      if (/\badjacent\b/.test(q) && !/adjacent to (?:the target|the mentor|your companion)/.test(q)) {
        stamped++;
        return { ...c, range: 1 };
      }
    }
    return c;
  });
  return stamped ? { ...result, clauses } : result;
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
    if (!TARGETING_EVENTS.has(c.event)) return c;
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
  
  ["TAKES_DAMAGE",    /\b(takes? (?:[\w-]+(?:,? or | ?, | ))*damage|loses? stamina|is damaged|damages? (you|the target|them|it|an ally|the \w+)|deals? ([\w, ]+ )?damage to (you|the target|the \w+))/i],
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

/* What the ability being used has to look like. Without these a trigger on USES_ABILITY fires on
   every ability anybody uses, which is worse than not having it.

   Exported because the trigger builder runs it over a hand written qualifier too, so typing
   "main action" there does the same thing the book's own phrasing would have done. */

export const ABILITY_FILTERS = [
  {
    id: "abilityDsid",
    from: "trigger",
    rx: /\buses? (?:your|their|its) ([A-Z][\w'’ ]*?) ability\b/,
    fields: (m) => ({ abilityDsid: generateDSID(m[1]) }),
  },
  {
    id: "abilityType",
    from: "trigger",
    rx: /\b(main action|maneuver)\b/i,
    fields: (m) => ({ abilityType: m[1].toLowerCase() === "maneuver" ? "maneuver" : "main" }),
  },
  {
    id: "abilityCostMax",
    from: "trigger",
    rx: /costs? (\d+) or (?:fewer|less)[\w ]*/i,
    fields: (m) => ({ abilityCostMax: Number(m[1]) }),
  },
  /* Category, not cost inferred from it. The two nearly agree and the exceptions are real: seven
     heroic abilities cost nothing, and the Troubadour's own Flashback is a signature costing 5. */
  {
    id: "abilityCategory",
    from: "trigger",
    rx: /\b(non-heroic|heroic) ability\b/i,
    fields: (m) => ({ abilityCategory: m[1].toLowerCase() }),
  },
  {
    id: "abilityTargetCount",
    from: "trigger",
    rx: /targets? only one (enemy|ally|creature)/i,
    fields: (m) => ({
      abilityTargetCount: 1,
      ...(m[1].toLowerCase() === "creature" ? {} : { abilityTargetSide: m[1].toLowerCase() }),
    }),
  },
  
  {
    id: "abilityCostScales",
    from: "effect",
    rx: /(?:cost of \d+ \+ each additional[\w ]*|cost equal to the amount of [\w ]+ spent)/i,
    needs: (out) => out.abilityCostMax != null || out.abilityCategory != null,
    fields: () => ({ abilityCostScales: true }),
  },
];

export function abilityFiltersFrom(text, effectText = "") {
  const out = {};
  for (const f of ABILITY_FILTERS) {
    if (f.needs && !f.needs(out)) continue;
    const m = String((f.from === "effect" ? effectText : text) ?? "").match(f.rx);
    if (m) Object.assign(out, f.fields(m));
  }
  return out;
}

const CLAUSE_FLAGS = [
  { id: "damageTypes",       from: "trigger", when: (c) => c.damageTypes?.length,
    rx: /\b(acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic)(?:[, ]+(?:or )?(?:acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic))*\b[\w ]*damage/i },
  { id: "edgeRequired",      from: "trigger", when: (c) => c.edgeRequired,
    rx: /\b(?:gains? (?:an|a double) edge|has an edge|with an edge)\b/i },
  { id: "excludeSelfTarget", from: "trigger", when: (c) => c.excludeSelfTarget,
    rx: /(?:doesn['’]t|does not) also targets? [\w'’ -]+/i },
  { id: "effectName",        from: "trigger", when: (c) => c.effectName,
    rx: /ends? the [\w -]+? effect/i },
  { id: "zone",              from: "trigger", when: (c) => c.zone,
    rx: /\b(?:enters?|starts? their turn (?:in|within|adjacent to)) (?:the|a) [\w -]+/i },
  { id: "postRoll",          from: "trigger", when: (c) => c.postRoll, rx: /\bis struck by\b/i },
  { id: "half",              from: "effect",  when: (c) => c.halfDamage || c.halfOnUse, list: () => HALF_TEXT },
  { id: "rollMod",           from: "effect",  when: (c) => c.rollMod,   list: () => ROLL_MOD_TEXT.map((r) => r[0]) },
  { id: "redirect",          from: "effect",  when: (c) => c.redirect,  list: () => REDIRECT_TEXT.map((r) => r[0]) },
];

export function explainClauseFlags(clause, triggerText, effectText) {
  const found = [];
  for (const f of CLAUSE_FLAGS) {
    if (!f.when(clause)) continue;
    const text = String((f.from === "effect" ? effectText : triggerText) ?? "");
    for (const rx of f.list ? f.list() : [f.rx]) {
      const m = text.match(rx);
      if (!m) continue;
      found.push({ id: f.id, from: f.from, fragment: m[0].trim() });
      break;
    }
  }
  return found;
}

export function explainAbilityFilters(text, effectText = "") {
  const found = [];
  const out = {};
  for (const f of ABILITY_FILTERS) {
    if (f.needs && !f.needs(out)) continue;
    const m = String((f.from === "effect" ? effectText : text) ?? "").match(f.rx);
    if (!m) continue;
    const fields = f.fields(m);
    Object.assign(out, fields);
    found.push({ id: f.id, from: f.from, fragment: m[0].trim(), fields });
  }
  return found;
}

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

const SUBJECT_RX = /^(you\b|the target\b|your companion\b|the [\w'’ ]+?(?= (takes?|deals?|damages?|dies|is|are|moves?|enters?|starts?|ends?|uses?|makes?|targets?|would|force|becomes?|gains?|grabs?|regains?|comes|flies|loses?|reduced?|reduces?|obtains?|hears|causes?))|(?:an?|one|another|any) [\w -]+?(?: or object)?(?= (takes?|deals?|damages?|dies|is|are|moves?|enters?|starts?|ends?|uses?|makes?|targets?|would|force|becomes?|gains?|grabs?|regains?|comes|flies|loses?|reduced?|reduces?|marks|resists|within)))/;

function scopeOf(lc, event, owner) {
  const words = ownerWords(owner);
  const mentionsOwner = words.some(w => new RegExp(`\\b${w}\\b`).test(lc));
  const subj = lc.match(SUBJECT_RX);
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

function normalizeTrigger(clean, ownerName) {
  const properWords = ownerWords(ownerName).filter(w => new RegExp(`\\b${w[0].toUpperCase()}${w.slice(1)}`).test(clean));
  let normalized = clean;
  for (const w of properWords) normalized = normalized.replace(new RegExp(`\\b(Lord |Queen |King )?${w[0].toUpperCase()}${w.slice(1)}(['’]s)?\\b`, "g"), (m, t, poss) => poss ? "the self's" : "the self");
  normalized = normalized.replace(/^(a|an|one) ([\w -]+?)['’]s turn starts/i, "a $2 starts their turn");
  normalized = normalized.replace(/\b(?:a|an|any|one) (?:creature|enemy|hero)( within \d+ squares?| within (?:distance|reach)| adjacent(?: to [\w'’ ]+?)?)? makes? a (melee |ranged )?strike against ([\w'’ -]+?)(?=[.,]| while| using| with| that|$)/gi,
    (m, qual, kind, tgt) => `${tgt} is struck by a ${kind ?? ""}strike${qual ? ` while${qual}` : ""}`);
  return normalized;
}

/* The trigger sentence as spans: which words each clause's subject, event and qualifiers were read
   from. Runs the same splitter and the same regex tables as parseTrigger, so a span can only point at
   words the parser actually matched. Positions are in the returned sentence, which is the book text
   unless a proper name had to become "the self" for the parser to read it. */
export function annotateTrigger(text, { dsid, ownerName, effectText, targetType } = {}) {
  const clean = String(text ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return { sentence: "", segments: [] };
  const parse = parseTrigger(clean, { dsid, ownerName, effectText, targetType });
  const sentence = normalizeTrigger(clean, ownerName);
  const lower = sentence.toLowerCase();
  const spans = [];
  let cursor = 0;
  splitClauses(sentence).forEach((clauseText, index) => {
    const lc = clauseText.toLowerCase();
    let start = lower.indexOf(lc, cursor);
    let localOffset = 0;
    if (start < 0) {
      
      const words = lc.split(" ");
      for (let drop = 1; drop < words.length && start < 0; drop++) {
        const tail = words.slice(drop).join(" ");
        const at = lower.indexOf(tail, cursor);
        if (at >= 0) { start = at; localOffset = lc.length - tail.length; }
      }
    }
    if (start < 0) return;
    const base = start - localOffset;
    cursor = start + (lc.length - localOffset);
    const add = (kind, m, field) => {
      if (!m) return;
      const s = base + m.index, e = s + m[0].length;
      if (s < start || e > cursor) return;
      spans.push({ start: s, end: e, clause: index, kind, field });
    };
    const clause = parse.clauses[index];
    const subject = lc.match(SUBJECT_RX);
    if (subject && localOffset > 0 && subject.index < localOffset) {
      
      const shared = spans.filter((s) => s.kind === "subject").at(-1);
      if (shared) (shared.clauses ??= [shared.clause]).push(index);
    } else add("subject", subject, "scope");
    const eventRow = EVENTS.find(([name]) => name === clause?.event) ?? EVENTS.find(([, rx]) => rx.test(lc));
    if (eventRow) {
      const rx = new RegExp(eventRow[1].source, eventRow[1].flags.replace("g", ""));
      add("event", lc.match(rx), "event");
    }
    for (const rx of QUALIFIERS) add("qualifier", lc.match(rx), "qualifiers");
  });
  spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const segments = [];
  let at = 0;
  for (const span of spans) {
    if (span.start < at) continue;
    if (span.start > at) segments.push({ text: sentence.slice(at, span.start), kind: "plain", clause: null });
    segments.push({ text: sentence.slice(span.start, span.end), kind: span.kind, clause: span.clause, clauses: span.clauses ?? [span.clause], field: span.field });
    at = span.end;
  }
  if (at < sentence.length) segments.push({ text: sentence.slice(at), kind: "plain", clause: null });
  return { sentence, segments, clauseCount: parse.clauses.length };
}

export function parseTrigger(text, { dsid, ownerName, effectText, targetType } = {}) {
  const id = dsid || "";
  const key = ownerName ? `${generateDSID(ownerName)}:${id}` : null;
  const special = (key && SPECIAL_CASES[key]) || SPECIAL_CASES[id];
  if (special) return bespokeLayer(rangeLayer(holdHalfLayer(postRollHalfLayer(rollModLayer(redirectLayer(damageModLayer(resolveTargetScope({ ...special, confidence: "high", source: "special" }, targetType), id, effectText), id, effectText), id, effectText), id, effectText), id, effectText)), id);

  const clean = text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const clauses = [];
  let ambiguous = false;

  const normalized = normalizeTrigger(clean, ownerName);
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
    if (entry.event === "TARGETED_BY_STRIKE" && !/\bstrik|\bstruck\b/.test(lc)) {
      entry.event = "TARGETED_BY_ABILITY";
      entry.events = events.map((e) => e === "TARGETED_BY_STRIKE" ? "TARGETED_BY_ABILITY" : e);
    }
    if (/\bis struck by\b/.test(lc)) entry.postRoll = true;
    
    const dmgTypes = lc.match(/\b(acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic)\b/g);
    if (dmgTypes && /damage/.test(lc)) entry.damageTypes = [...new Set(dmgTypes)];
    const using = clause.match(/\busing (?:their |its |the )?([A-Z][\w' ]*?)(?=[.,]|$| (?:ability|maneuver|action))/);
    if (using) entry.abilityDsid = generateDSID(using[1]);

    Object.assign(entry, abilityFiltersFrom(clause, effectText));
    const eff = lc.match(/ends? the ([\w -]+?) effect/); if (eff) entry.effectName = eff[1];
    const zone = lc.match(/\b(?:enters?|starts? their turn (?:in|within|adjacent to)) (?:the|a) ([\w -]+?)(?: or|,|$)/); if (zone) entry.zone = zone[1];
    const excl = lc.match(/(?:doesn['’]t|does not) also targets? (?:the )?([\w'’ -]+?)(?=[.,]|$| with| using)/);
    if (excl) {
      const words = ownerWords(ownerName);
      if (/\b(self|you)\b/.test(excl[1]) || !words.length || words.some((w) => excl[1].includes(w))) entry.excludeSelfTarget = true;
    }
    if (/\b(gains? (an|a double) edge|has an edge|with an edge)\b/.test(lc)) entry.edgeRequired = true;
    if (/\bsaving throw\b|ends? at the end of their turn/.test(lc) && entry.event === "CONDITION_GAIN") entry.durationFilter = "save-or-eot";
    if (entry.event === "CONDITION_GAIN") {
      const cond = lc.match(/\b(grabbed|restrained|frightened|taunted|prone|slowed|weakened|dazed|bleeding)\b/);
      if (cond) entry.condition = cond[1];
      const grabs = lc.match(/\bgrabs (two|three|\d+|a|an|one)\b/);
      if (grabs) {
        entry.condition = "grabbed";
        entry.asSource = true;
        const n = { two: 2, three: 3, a: 1, an: 1, one: 1 }[grabs[1]] ?? Number(grabs[1]);
        if (n > 1) entry.grabCount = n;
      }
    }
    if (scope === "GROUP") entry.groupName = lc.match(/^(?:a|an|any|one) ([\w -]+?) (?:within|adjacent|is|takes|dies|starts|moves)/)?.[1];
    clauses.push(entry);
  }
  return bespokeLayer(rangeLayer(holdHalfLayer(postRollHalfLayer(rollModLayer(redirectLayer(damageModLayer(resolveTargetScope({ clauses, confidence: ambiguous ? "low" : "high", source: "regex" }, targetType), id, effectText), id, effectText), id, effectText), id, effectText), id, effectText)), id);
}
