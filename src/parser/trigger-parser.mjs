

export const SPECIAL_CASES = {
  
  "your-fears-become-manifest": { clauses: [{ event: "ROUND_START", scope: "ANY" }] },
  "stinging-departure":         { clauses: [{ event: "GRAB_ENDS", scope: "SELF", asSource: true }] },
  "blood-for-blood":            { clauses: [{ event: "CONDITION_GAIN", scope: "ALLY", qualifiers: ["bleeding", "by the target"], condition: "bleeding" }] },
  "aeolyxria-blood-for-blood": { clauses: [{ event: "CONDITION_GAIN", scope: "ALLY", qualifiers: ["bleeding", "by the target"], condition: "bleeding" }] },
  "wasnt-aiming-for-you":       { clauses: [{ event: "POWER_ROLL_RESULT", scope: "SELF", qualifiers: ["tier 1", "signature ability"], tierFilter: [1], postRoll: true, signatureOnly: true, rollerScoped: true }] },
  "brain-drain":                { clauses: [{ event: "RESISTS_POTENCY", scope: "GRABBED_CREATURE" }] },
  "still-your-tongue":          { clauses: [{ event: "NARRATIVE", scope: "ANY" }] },
  "timely-distraction":         { clauses: [{ event: "TEST_FAILED", scope: "ALLY" }] },
  "hesitation-is-weakness":     { clauses: [{ event: "TURN_END", scope: "ALLY", qualifiers: [], ownerUnacted: true, turnLock: true }] },
  "prescient-grace":            { clauses: [{ event: "TURN_START", scope: "ENEMY", qualifiers: ["within 10 squares"], anyHeroUnacted: true, turnLock: true }] },
  
  
  
  "fulfill-your-destiny":       { clauses: [{ event: "TURN_END", scope: "SELF_OR_ALLY", qualifiers: ["hero"], heroOnly: true, turnLock: true, range: "none" }] },
  "time-loop":                  { clauses: [{ event: "TURN_END", scope: "ANY", qualifiers: ["another creature"], notSelf: true, turnLock: true, bonusTurn: true, oncePerRound: true, range: "none" }] },
  "arrestor-cycle":             { clauses: [{ event: "TURN_START", scope: "ANY", qualifiers: [], turnLock: true, manualTurn: true }] },
  "do-not-hesitate-in-the-wode": { clauses: [{ event: "TURN_END", scope: "ALLY", qualifiers: ["while the guerrilla hasn't acted this round", "acting as a captain"], ownerUnacted: true, captainOnly: true, turnLock: true, squadTurn: true, range: "none" }] },
  "wode-sickness":              { clauses: [{ event: "TURN_END", scope: "ALLY", qualifiers: [], turnLock: true, range: "none" }] },
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

export const DAMAGE_MODIFYING = new Set([
  "adaptability", "armor-of-corpses", "armor-of-the-ancients", "break-armor", "buss-buffer",
  "dissipate", "field-collapse", "in-all-this-confusion", "inertial-absorption", "inertial-shield",
  "instant-retaliation", "meat-shield", "mind-requital", "night-watch", "parry", "blackguard-parry",
  "precognitive-shift", "psionic-retribution", "repel", "resist-the-unnatural",
  "shadow-veil", "shield-block", "skin-like-castle-walls", "skitter", "stalkers-afterimage", "striking-afterimage", "synaptic-anchor",
  "unearthly-reflexes", "withdraw", "zephyr-feint",
]);

export const TARGETED_HALVERS = new Set(["shriek", "pain-absorption"]);

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
  /\btak(?:e|es|ing) no damage\b/i,
  /\bignores? (?:the |that |this )?damage\b/i,
  /\b(?:damage )?immunity (?:\d+|equal to)\b(?![^.]*\b(?:until the end of|against the next)\b)/i,
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

const POST_ROLL_PHRASE = /\bafter seeing the (?:outcome|result)\b|\bafter the (?:power )?roll is (?:made|resolved)\b/i;

function resolveTargetScope(result, targetType) {
  const scope = TARGET_TYPE_SCOPES[targetType];
  if (!scope || !result.clauses.some((c) => c.scope === "TARGET")) return result;
  
  return { ...result, clauses: result.clauses.map((c) => c.scope === "TARGET" ? { ...c, scope, targetScoped: true } : c) };
}

export function changesTheStrike(clause) {
  return !!(clause?.rollMod || clause?.redirect || clause?.halfOnUse || clause?.halfDamage || clause?.targetedHalf || clause?.abilityWide);
}

export const EFFECT_TODO = new Set(["final-orders"]);

function todoLayer(result, id) {
  return EFFECT_TODO.has(id) ? { ...result, flag: "EFFECT_TODO" } : result;
}

const carries = (clause, event) => clause.event === event || !!clause.events?.includes(event);

function damageModLayer(result, id, effectText) {
  const textHalves = halvesDamage(effectText) && !POST_ROLL_PHRASE.test(effectText)
    && !/\btier [1-3] outcome\b|\bwould have taken\b|\bchange the target\b|\bignore the strike\b/i.test(effectText)
    && result.clauses.some((c) => TARGETING_EVENTS.has(c.event) && !c.postRoll);
  if (TARGETED_HALVERS.has(id) || textHalves) {
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
  [/\bredirect the strike against the second creature\b/i, "flanker"],
  [/switch(?:es)? places/i, "swap"],
  [/choose[\s\S]{0,90}?targets? (?:that|the) (?:enemy|creature) instead|chooses?[\s\S]{0,90}?to become the target/i, "chooser"],
  [/targeting them instead|reflects?[\w'’ ]* back|\bimposed on the creature making the strike\b/i, "reflect"],
  
  [/\bis the target of the triggering (?:strike|ability)\b/i, "chooser"],
  
  [/becomes? the (?:[\w'’]+ ){0,3}target\b|is the (?:strike|ability)['’]?s? new target/i, "self"],
];

const FM_MOD_ABILITIES = {
  "lines-of-force": { mode: "redirect", char: "might" },
  "repel": { mode: "reduce", char: "reason" },
  "explosive-assistance": { mode: "boost", char: "reason" },
};

const CHAR = "(might|agility|reason|intuition|presence)";
export const FM_MOD_TEXT = [
  [new RegExp(`\\bspend up to (\\d+) surges?\\b[^.]*\\.\\s*for each surge spent, the forced movement distance gains a bonus equal to your ${CHAR} score\\b`, "i"),
    (m) => ({ mode: "boost", char: m[2].toLowerCase(), perSurge: Number(m[1]) })],
  [new RegExp(`\\bforced movement distance gains a bonus equal to your ${CHAR} score\\b`, "i"), (m) => ({ mode: "boost", char: m[1].toLowerCase() })],
  [/\bforced movement distance gains a \+(\d+) bonus\b/i, (m) => ({ mode: "boost", amount: Number(m[1]) })],
  [/\breduce the forced movement distance by (\d+)\b/i, (m) => ({ mode: "reduce", amount: Number(m[1]) })],
  [/\bgains? a \+(\d+) bonus to the forced movement distance\b/i, (m) => ({ mode: "boost", amount: Number(m[1]) })],
  [/\bslide (?:them|it|the target|that creature) instead\b/i, () => ({ mode: "slide" })],
  [/\bpull (?:them|it|the target|that creature) instead\b/i, () => ({ mode: "pull" })],
  [/\b(?:that|the) forced movement can be vertical\b/i, () => ({ mode: "vertical" })],
  [/\bcan vertical (?:push|pull|slide) (?:them|it|the target|that creature)\b/i, () => ({ mode: "vertical" })],
  [new RegExp(`\\btakes? extra damage equal to your ${CHAR} score\\b`, "i"), (m) => ({ mode: "objectDamage", char: m[1].toLowerCase() })],
];

const REDUCE_DAMAGE = /\breduce (?:any|the|that|this) damage(?: from [\w ]+?)? by (?:(\d+)|an amount equal to your level)\b/i;

function reductionLayer(result, effectText) {
  const cut = String(effectText ?? "").match(REDUCE_DAMAGE);
  if (!cut) return result;
  const amount = cut[1] ? Number(cut[1]) : "level";
  let stamped = 0;
  const clauses = result.clauses.map((c) => {
    if (c.damageReduction != null || !carries(c, "WOULD_TAKE_DAMAGE")) return c;
    stamped++;
    return { ...c, damageReduction: amount };
  });
  return stamped ? { ...result, clauses } : result;
}

function fmModLayer(result, id, effectText) {
  let mod = FM_MOD_ABILITIES[id] ? { ...FM_MOD_ABILITIES[id] } : null;
  for (const [rx, make] of mod || !effectText ? [] : FM_MOD_TEXT) {
    const m = String(effectText).match(rx);
    if (m) { mod = make(m); break; }
  }
  if (!mod) return result;
  let stamped = 0;
  const clauses = result.clauses.map((c) => {
    if (c.event !== "FORCE_MOVES" && c.event !== "FORCE_MOVED") return c;
    stamped++;
    const { fmBefore, ...rest } = c;
    return { ...rest, fmMod: mod };
  });
  return stamped ? { ...result, clauses } : result;
}

const ROLL_MOD_SUBJECT ="(?:triggering )?(?:strike|power roll|ability roll)|it";

export const ROLL_MOD_TEXT = [
  [new RegExp(`\\b(?:${ROLL_MOD_SUBJECT}) (?:takes?|has|gains?) a bane\\b`, "i"), { banes: 1 }],
  [/\btakes? a bane on (?:the |their |that )?(?:triggering )?(?:strike|power roll|ability roll|roll)\b/i, { banes: 1 }],
  [new RegExp(`\\b(?:${ROLL_MOD_SUBJECT}) (?:takes?|has|gains?) an edge\\b`, "i"), { edges: 1 }],
  [/\b(?:takes?|has|gains?) an edge on (?:the |their |that )?(?:triggering )?(?:strike|power roll|ability roll|roll)\b/i, { edges: 1 }],
  [new RegExp(`\\b(?:${ROLL_MOD_SUBJECT}) (?:takes?|has|gains?) a double bane\\b`, "i"), { banes: 2 }],
  [/\btakes? a double bane on (?:the |their |that )?(?:triggering )?(?:strike|power roll|ability roll|roll)\b/i, { banes: 2 }],
  [new RegExp(`\\b(?:${ROLL_MOD_SUBJECT}) (?:takes?|has|gains?) a double edge\\b`, "i"), { edges: 2 }],
  [/\b(?:takes?|has|gains?) a double edge on (?:the |their |that )?(?:triggering )?(?:strike|power roll|ability roll|roll)\b/i, { edges: 2 }],
  [/\bimposes? a double bane on (?:the |their |that )?(?:triggering )?(?:strike|power roll|ability roll|roll)\b/i, { banes: 2 }],
  [/\bimposes? a bane on (?:the |their |that )?(?:triggering )?(?:strike|power roll|ability roll|roll)\b/i, { banes: 1 }],
  [/\b(?:grants?|gains?|takes?|has) a \+(\d+) bonus to (?:the |their |that )?(?:triggering )?(?:power roll|ability roll|roll)\b/i, (m) => ({ bonus: Number(m[1]) })],
  [/\bdecreases? the (?:power roll )?outcome\b[\w ]*? by one tier\b/i, { tierShift: -1 }],
  [/\bincreases? the (?:power roll )?outcome\b[\w ]*? by one tier\b/i, { tierShift: 1 }],
];

const PREROLL_MOD_EVENTS = new Set(["TARGETED_BY_STRIKE", "TARGETED_BY_ABILITY", "MAKES_STRIKE", "POWER_ROLL"]);

function rollModLayer(result, id, effectText) {
  if (!effectText) return result;
  const applies = (c) => c.postRoll || PREROLL_MOD_EVENTS.has(c.event);
  if (!result.clauses.some(applies)) return result;
  let mod = null;
  for (const [rx, m] of ROLL_MOD_TEXT) {
    const hit = String(effectText).match(rx);
    if (hit) { mod = typeof m === "function" ? m(hit) : m; break; }
  }
  if (!mod) return result;
  return {
    ...result,
    rollModifying: true,
    clauses: result.clauses.map((c) => applies(c) ? { ...c, rollMod: mod } : c),
  };
}

const POTENCY_WAY = "(reduced|decreased|lowered|increased|raised)";

export const POTENCY_TEXT = [
  [new RegExp(`\\bany potenc(?:y|ies) associated with the damage (?:is|are) ${POTENCY_WAY} by your ${CHAR} score`, "i"), "all"],
  [new RegExp(`\\bany potenc(?:y|ies) associated with the damage (?:is|are) ${POTENCY_WAY} by ([MARIP])\\b`, "i"), "all"],
  [new RegExp(`\\bpotency of (?:one|an) effect associated with the damage is ${POTENCY_WAY} by (\\d+)`, "i"), "one"],
  [new RegExp(`\\bpotency of any (?:potency )?effects? associated with the damage (?:is|are) ${POTENCY_WAY} by (\\d+)`, "i"), "all"],
  [new RegExp(`\\bif the damage has any potency effects? associated with it, the potency is ${POTENCY_WAY} by (\\d+)`, "i"), "all"],
  [new RegExp(`\\bpotency of any potency effects (?:is|are) ${POTENCY_WAY} by (\\d+)`, "i"), "all"],
  [new RegExp(`^\\W*the potency is ${POTENCY_WAY} by (\\d+)`, "i"), "all"],
  [/\b(increases|raises|reduces|decreases|lowers) its potency by (\d+)/i, "all"],
  [new RegExp(`\\bpotency of (?:any|all) (?:enemy )?effects targeting you (?:is|are) ${POTENCY_WAY} by (\\d+)`, "i"), "all"],
  [/\b(reduce|increase|lower|raise)s? the potency of (?:any |all )?(?:enemy )?effects targeting you by (\d+)/i, "all"],
  [/\bpotency of any abilit(?:y|ies) used against them (increases|decreases) by (\d+)/i, "all"],
  [new RegExp(`\\bany potency associated with the damage is ${POTENCY_WAY} by (\\d+)`, "i"), "all"],];

const POTENCY_EVENTS = new Set(["WOULD_TAKE_DAMAGE", "TAKES_DAMAGE", "DEALS_DAMAGE", "USES_ABILITY", "RESISTS_POTENCY"]);

function potencyMatch(text) {
  for (const [rx, scope] of POTENCY_TEXT) {
    const hit = String(text ?? "").match(rx);
    if (!hit) continue;
    const sign = /increase|raise/i.test(hit[1]) ? 1 : -1;
    
    const LETTER = { m: "might", a: "agility", r: "reason", i: "intuition", p: "presence" };
    if (!/^\d+$/.test(hit[2])) return { amount: sign, char: LETTER[hit[2].toLowerCase()] ?? hit[2].toLowerCase(), scope };
    return { amount: sign * Number(hit[2]), scope };
  }
  return null;
}

function abilityWideLayer(result, effectText) {
  if (!effectText || !/\btriggering ability\b/i.test(effectText)) return result;
  const uses = (c) => c.event === "USES_ABILITY";
  const half = halvesDamage(effectText);
  if (!result.clauses.some((c) => uses(c) && (half || c.potencyMod))) return result;
  return { ...result, clauses: result.clauses.map((c) => (uses(c) ? { ...c, abilityWide: true, ...(half ? { abilityHalf: true } : {}) } : c)) };
}

function potencyLayer(result, effectText, spendText) {
  if (!effectText || !result.clauses.some((c) => POTENCY_EVENTS.has(c.event))) return result;
  const found = potencyMatch(effectText);
  if (!found) return result;
  const potencyMod = { ...found, ...(potencyMatch(spendText) ? { spend: true } : {}) };
  return { ...result, clauses: result.clauses.map((c) => (POTENCY_EVENTS.has(c.event) && !c.potencyMod ? { ...c, potencyMod } : c)) };
}

export const HALF_TEXT = [
  /\bhalves? (?:the |that |this |any )?(?:\w+ )?damage\b/i,
  /\bhalf (?:the |that |this |of the |any )?(?:\w+ )?damage\b/i,
  /\bdamage (?:is |taken is )?halved\b/i,
  /\bdamage from the triggering (?:ability|strike) is halved\b/i,
];

const HALF_IS_A_QUANTITY = /\bequal to half\b/i;

const halvesDamage = (text) => !!text && !HALF_IS_A_QUANTITY.test(text) && HALF_TEXT.some((rx) => rx.test(text));

function postRollHalfLayer(result, id, effectText) {
  const tier = effectText?.match(/\btier ([1-3]) outcome\b/i);
  if (tier && halvesDamage(effectText) && result.clauses.some((c) => TARGETING_EVENTS.has(c.event))) {
    result = { ...result, clauses: result.clauses.map((c) => (TARGETING_EVENTS.has(c.event) ? { ...c, postRoll: true, tierFilter: [Number(tier[1])] } : c)) };
  }
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

const LINE_OF_EFFECT = /\b(?:with)?in your line of effect\b|\b(?:you have|the [\w'’-]+ has) line of effect to\b/i;
const LOE_ON_VICTIM = /\b(?:targets?|deals? damage to|damages?|against)\b/i;

function lineOfEffectLayer(result, text) {
  const clean = String(text ?? "").replace(/<[^>]+>/g, "");
  const m = clean.match(LINE_OF_EFFECT);
  if (!m) return result;
  const on = LOE_ON_VICTIM.test(clean.slice(0, m.index)) ? "victim" : "subject";
  return { ...result, clauses: result.clauses.map((c) => ({ ...c, lineOfEffect: on })) };
}

function redirectLayer(result, id, effectText) {
  let mode = REDIRECT_ABILITIES[id] ?? null;
  if (!mode && effectText) {
    for (const [rx, m] of REDIRECT_TEXT) {
      if (rx.test(effectText)) { mode = m; break; }
    }
  }
  if (!mode) return result;
  const reflectHalf = mode === "reflect" && halvesDamage(effectText);
  let stamped = 0;
  const clauses = result.clauses.map((c) => {
    if (TARGETING_EVENTS.has(c.event)) {
      stamped++;
      return { ...c, redirect: mode, ...(reflectHalf ? { reflectHalf: true } : {}) };
    }
    
    if (c.event === "TAKES_DAMAGE" || c.event === "WOULD_TAKE_DAMAGE") {
      stamped++;
      return { ...c, event: "TARGETED_BY_ABILITY", events: ["TARGETED_BY_ABILITY"], postRoll: true, redirect: mode };
    }
    return c;
  });
  if (!stamped) return result;
  return { ...result, clauses, redirect: mode };
}

const EVENTS = [
  ["DIES",            /\b(dies|would die|you die|is destroyed|enough damage to (die|be destroyed)|reduced? [^,]*?to 0 stamina|reduces? [^,]*?to 0 stamina|to 0 stamina|negative of (?:your|their|its) winded value)\b/i],
  ["WINDED_OR_DYING", /\b(winded or dying|dying or winded)\b/i],
  ["WINDED",          /(?<!\bwhile (?:you are |they are |it is )?)\bwinded\b/i],
  ["DYING",           /(?<!\bwhile (?:you are |they are |it is )?|\bnot )\bdying\b/i],
  ["WOULD_TAKE_DAMAGE", /\bwould take damage\b/i],
  ["FORCE_MOVED",     /\b(is |are |be |being )?(force(d)? moved|pushed|pulled|slid)\b/i],
  ["FORCE_MOVES",     /\b(force moves?|(?:you|the self|your companion) (?:would )?(?:use forced movement to )?(?:push|pull|slide)(?:e?s)?)\b/i],
  ["FALL_START",      /\b(?:you|they|the self|(?:a|an|any) [\w -]+?) falls?\b(?! prone)/i],
  ["SPENDS_RECOVERY", /(?<!\bto )\bspends? (?:a|one|\d+) recover(?:y|ies)\b/i],
  ["GAINS_TEMP_STAMINA", /\bgains? temporary stamina\b/i],
  ["GAINS_SURGE",     /\bgains? (?:a|one or more|\d+) surges?\b/i],
  ["MALICE_SPENT",    /\bspends? malice\b/i],
  ["TELEPORTS",       /\bteleports\b/i],
  ["HERO_TOKEN_EARNED", /\b(?:earns?|gains?|would earn) (?:a|one|\d+) hero tokens?\b/i],
  ["RESISTS_POTENCY", /\bresist(?:s|ing)? (?:a |the )?potenc(?:y|ies)\b/i],
  ["TEST_FAILED",     /\bfails? (?:a|an) (?:[\w-]+ )*?test\b/i],
  ["RESOURCE_GAIN",   /\bgains? (?:\d+ |one |a )?(?:wrath|ferocity|focus|insight|discipline|piety|essence|clarity|drama|virtue|(?:a |their |its )?heroic resources?)\b/i],
  ["MARKED",          /\b(?:marks (?:you|the self)|(?:is|are|becomes?) marked)\b/i],
  ["GRAB_ENDS",       /\b(?:grab (?:on [\w -]+? )?ends|escapes? (?:from )?(?:your|the self['’]s|its|their|a|the) grab|(?:is|are) no longer grabbed|(?:you|the self) releases? (?:a|an|the|your) [\w -]*?(?:creature|target|grab))\b/i],
  ["STAMINA_BELOW",   /\b(?:stamina (?:drops|falls) below \d+|(?:drops?|falls?) below \d+ stamina|reduced to \d+ stamina or (?:less|lower|fewer))\b/i],

  ["TAKES_DAMAGE",    /\b(takes? (?:[\w-]+(?:,? or | ?, | ))*damage|is damaged|damages? (you|the target|them|it|an ally|the \w+)|deals? ([\w, ]+ )?damage to (you|the target|the \w+))/i],
  ["DEALS_DAMAGE",    /\b(deals? ([\w, ]+ )?damage|deals? rolled damage|damages? (a|an|another|any) )\b/i],
  ["TARGETED_BY_STRIKE", /\b(targets? (you|them|the target|an ally|an enemy|the \w+)\b|is targeted|targeted by|is struck by|makes? an? (melee |ranged )?strike against|strikes? (you|the target|the \w+))/i],
  ["MAKES_STRIKE",    /\bmakes? an? (melee |ranged )?strike( against (a|an|another|any) )?\b/i],
  ["POWER_ROLL_RESULT", /\b(obtains? a tier \d outcome|tier \d (outcome|result)|(?<!isn['’]t a |not a )critical hit|natural (19|20))\b/i],
  ["POWER_ROLL",      /\b(makes? an? (ability|power) roll|power roll|ability roll)\b/i],
  ["USES_ABILITY",    /\b(uses? (a|an|any|their|its|the|your) [^,]*?(ability|action|maneuver)|uses? [^,]*?ability)\b/i],
  ["TURN_START",      /\b(starts? (their|its|his|her|a|the|your)? ?turn|turn starts|start of (their|its|a|the) turn)\b/i],
  ["TURN_END",        /\b(ends? (their|its|his|her|a|the|your)? ?turn|turn ends|end of (their|its|a|the) turn)\b/i],
  ["ROUND_START",     /\bnew round starts\b/i],
  ["MOVES",           /\b(moves?|enters?|leaves?|exits?|shifts?|flies|comes within|ends? (their|its) (movement|move)|willingly)\b/i],
  ["CONDITION_GAIN",  /\b(gains? (a|the) condition|is subject to an effect|gains? [^,]*condition|becomes? (?:grabbed|restrained|frightened|taunted|prone|slowed|weakened|dazed|bleeding|hidden)(?:(?:,\s*(?:or\s+|and\s+)?|\s+(?:or|and)\s+)(?:grabbed|restrained|frightened|taunted|prone|slowed|weakened|dazed|bleeding|hidden))*|is (grabbed|restrained|frightened|taunted|knocked prone|made bleeding)|falls prone|grabs|(?:you|the self) grab (?:a|an|any|one|two)|knocks? (?:a|an|any|the) [\w -]+? prone)\b/i],
  ["SAVING_THROW",    /\bsaving throw\b/i],
  ["REGAINS_STAMINA", /\bregains? stamina\b/i],
  ["LOSES_STAMINA",   /\bloses? stamina\b/i],
  ["EFFECT_ENDS",     /\bends? the [\w -]+ effect\b/i],
  ["ZONE_ENTER",      /\benters? (the|a) [\w -]+\b/i],
  ["ZONE_TURN_START", /\bstarts? their turn (there|in|within|adjacent)\b/i],
];
const SHADOW = {
  TAKES_DAMAGE: ["WOULD_TAKE_DAMAGE", "DIES", "WINDED_OR_DYING", "WINDED", "DYING"],
  DEALS_DAMAGE: ["TAKES_DAMAGE", "DIES", "WOULD_TAKE_DAMAGE", "TARGETED_BY_STRIKE"],
  USES_ABILITY: ["TARGETED_BY_STRIKE", "POWER_ROLL", "DEALS_DAMAGE", "TAKES_DAMAGE"],
  TARGETED_BY_STRIKE: ["TAKES_DAMAGE", "WOULD_TAKE_DAMAGE", "POWER_ROLL", "MAKES_STRIKE", "POWER_ROLL_RESULT"],
  DIES: ["POWER_ROLL_RESULT"],
  MAKES_STRIKE: ["POWER_ROLL", "POWER_ROLL_RESULT"],
  TARGETED_BY_STRIKE_BY_MAKES: [],
  WINDED_OR_DYING: ["DIES"],
  WINDED: ["DIES", "WINDED_OR_DYING"],
  DYING: ["DIES", "WINDED_OR_DYING"],
  FORCE_MOVED: ["FORCE_MOVES"],
  SPENDS_RECOVERY: ["USES_ABILITY"],
  POWER_ROLL: ["WOULD_TAKE_DAMAGE", "POWER_ROLL_RESULT"],
  TARGETED_BY_STRIKE_RESULT: [],
  CONDITION_GAIN: ["TURN_START", "GRAB_ENDS"],
  STAMINA_BELOW: ["DIES"],
  FALL_START: ["STAMINA_BELOW"],
  MOVES: ["FORCE_MOVED", "FORCE_MOVES", "ZONE_ENTER", "DYING", "WINDED", "WINDED_OR_DYING"],
  TURN_START: ["TURN_END", "ZONE_TURN_START"],
  TURN_END: ["CONDITION_GAIN"],
  SAVING_THROW: ["CONDITION_GAIN"],
};

const QUALIFIERS = [
  /within \d+ squares?/, /within (distance|reach)/, /adjacent (to|creature|ally|enemy)/,
  /while [^,]+/, /with an? (melee|ranged|area|triggered) (strike|ability|action)/,
  /(acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic)(, \w+)*(,? or \w+)? damage/,
  /(melee|ranged) strike/, /(main action|maneuver)/, /after seeing the result/, /for the (first|second) time[^,]*/,
  /non-minion|minion|leader|solo|size \d/, /that (isn['’]t|is not|doesn['’]t|has|targets|costs|uses|emits|gains)[^,]*/,
];

let _keywordRx = null;
let _keywordKey = "";
const KEYWORD_SPLIT = /,? or |,? and |, /;
function keywordRx() {
  const words = Object.keys(globalThis.ds?.CONFIG?.abilities?.keywords ?? {}).filter((k) => /^[a-z-]+$/i.test(k));
  const key = words.join("|");
  if (key !== _keywordKey || !_keywordRx) {
    _keywordKey = key;
    const k = words.length ? words.map((w) => `[${w[0].toUpperCase()}${w[0].toLowerCase()}]${w.slice(1)}`).join("|") : "(?!)";
    const notName = String.raw`(?<!\b(?!(?:The|A|An|Any|Your|Their|Its|Each|You|Use)\b)[A-Z][\w'’]* )`;
    _keywordRx = new RegExp(String.raw`${notName}\b((?:${k})(?:(?:,? or |,? and |, )(?:${k}))*) (?:(?:signature|heroic) )?(?:keywords?|abilit(?:y|ies))\b`);
  }
  return _keywordRx;
}
const keywordHits = (text) => [...String(text ?? "").matchAll(new RegExp(keywordRx().source, "g"))];

function keywordFields(text) {
  const groups = keywordHits(text).map((m) => {
    const words = m[1].toLowerCase().split(KEYWORD_SPLIT);
    return /\band\b/i.test(m[1]) && !/\bor\b/i.test(m[1]) ? words.map((w) => [w]) : [words];
  });
  if (!groups.length) return {};
  if (groups.length === 1) {
    const [g] = groups;
    return g.length > 1 ? { abilityKeywords: g.flat(), abilityKeywordsAll: true } : { abilityKeywords: g[0] };
  }
  const all = groups.flat();
  return { abilityKeywords: [...new Set(all.flat())], abilityKeywordGroups: all };
}

function keywordFragment(text) {
  const hits = keywordHits(text);
  return hits.length ? String(text).slice(hits[0].index, hits.at(-1).index + hits.at(-1)[0].length) : "";
}

const MIN_DAMAGE = /\b(\d+) or more (?:rolled )?damage\b|\bmore than (\d+) (?:rolled )?damage\b/;

const COST_WORDS = /\b(?:and )?that costs? (?:\d+ or more )?[\w ]+? to use\b/;

function coveredQualifier(q, entry) {
  if (entry.range?.ability && q === "within distance") return true;
  if (entry.range?.ability && /^while in the area of (?:your|the self['’]s) [\w'’ -]+? ability$/.test(q)) return true;
  if (entry.ownerInAbilityRange && /^while (?:you are|the self is) within the ability['’]s distance$/.test(q)) return true;
  if (/^that has\b/.test(q) && entry.abilityKeywords?.length) {
    let rest = q.replace(/^that has the [\w ,]+? keywords?\b/, "");
    if (entry.abilityCostMin != null) rest = rest.replace(COST_WORDS, "");
    return !rest.trim();
  }
  return false;
}

export const ABILITY_FILTERS = [
  {
    id: "abilityDsid",
    from: "trigger",
    rx: /\b(?:uses?|takes?) (?:your|their|its|the) ([A-Z][\w'’]*(?: [A-Z][\w'’]*)*) (?:ability|maneuver|main action|move action)\b/,
    fields: (m) => ({ abilityDsid: generateDSID(m[1]) }),
  },
  {
    id: "abilityType",
    from: "trigger",
    rx: /\b(main action|maneuver)\b|\buses? an? (?:free )?(triggered) action\b(?! to)/i,
    fields: (m) => ({ abilityType: m[2] ? "triggered" : m[1].toLowerCase() === "maneuver" ? "maneuver" : "main" }),
  },
  {
    id: "abilityCostMax",
    from: "trigger",
    rx: /costs? (\d+) or (?:fewer|less)[\w ]*/i,
    fields: (m) => ({ abilityCostMax: Number(m[1]) }),
  },
  {
    id: "abilityCostMin",
    from: "trigger",
    rx: /\bcosts? (?:(\d+) or more )?(?:essence|focus|ferocity|wrath|clarity|insight|discipline|piety|drama|virtue|heroic resource)(?: or more)? to use\b/i,
    fields: (m) => ({ abilityCostMin: Number(m[1] ?? 1) }),
  },
  
  {
    id: "abilityCategory",
    from: "trigger",
    rx: /\b(non-heroic|heroic) ability\b|(?<!\bor (?:use )?an? )\b(signature) ability\b/i,
    fields: (m) => ({ abilityCategory: (m[1] ?? m[2]).toLowerCase() }),
  },
  {
    id: "abilityKeywords",
    from: "trigger",
    get rx() { return keywordRx(); },
    fields: (m) => keywordFields(m.input),
    fragment: (m) => keywordFragment(m.input),
  },
  {
    id: "abilityPotency",
    from: "trigger",
    rx: /\b(?:with|that has) a potency(?: effect)?\b/i,
    fields: () => ({ abilityPotency: true }),
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

const DAMAGE_TYPES = ["acid", "cold", "corruption", "fire", "holy", "lightning", "poison", "psychic", "sonic"];
const NOT_DAMAGE_TYPES = /\b(?:isn['’ʼ]t|is not|other than)\s+(?:untyped|acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic)(?:\s+damage)?(?:,?\s+(?:or\s+|and\s+)?(?:untyped|acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic)(?:\s+damage)?)*(?<=damage)/i;
const NOT_DAMAGE_TYPES_AFTER = /\bdamage (?:that|which) (?:isn['’ʼ]t|is not|is other than)\s+(?:untyped|acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic)(?:,?\s+(?:or\s+|and\s+)?(?:untyped|acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic))*\b/i;

const OWNER_EFFECT = /\b(\w+ed) by (?:you|the self)\b|\b(?:creatures?|targets?|enem(?:y|ies)|all(?:y|ies)) ((?:you|the self)(?:['’]ve| have) (?!(?:taunted|grabbed|restrained|frightened|slowed|weakened|dazed|bleeding)\b)(\w+ed))\b/;
const OWNER_EFFECT_NOUN = String.raw`\s+(?:(?:an?|the|any|one)\s+|one or more\s+)(?:[\w-]+\s+)?(?:creatures?|targets?|enem(?:y|ies)|all(?:y|ies))\s*$`;
const HIT_BEFORE = new RegExp(String.raw`\b(?:damages?|to|against|attack|targets?)` + OWNER_EFFECT_NOUN);
const FROM_BEFORE = new RegExp(String.raw`\bfrom` + OWNER_EFFECT_NOUN);

function ownerEffectRole(lc, at, event) {
  const before = lc.slice(0, at);
  if (HIT_BEFORE.test(before)) return "victim";
  if (FROM_BEFORE.test(before)) return "dealer";
  if (/^TARGETED_BY_/.test(event) && !/\bis (?:struck|targeted)\b/.test(lc)) return "dealer";
  return "subject";
}

const CLAUSE_FLAGS = [
  { id: "damageTypes",       from: "trigger", when: (c) => c.damageTypes?.length,
    list: () => [NOT_DAMAGE_TYPES, /\b(acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic)(?:[, ]+(?:or )?(?:acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic))*\b[\w ]*damage/i] },
  { id: "edgeRequired",      from: "trigger", when: (c) => c.edgeRequired || c.rollHas?.length,
    rx: /\b(?:gains? (?:an|a double) edge|has an edge|with an edge)\b/i },
  { id: "excludeSelfTarget", from: "trigger", when: (c) => c.excludeSelfTarget,
    rx: /(?:doesn['’]t|does not) also targets? [\w'’ -]+/i },
  { id: "effectName",        from: "trigger", when: (c) => c.effectName,
    rx: /ends? the [\w -]+? effect/i },
  { id: "zone",              from: "trigger", when: (c) => c.zone,
    rx: /\b(?:enters?|starts? their turn (?:in|within|adjacent to)) (?:the|a) [\w -]+/i },
  { id: "postRoll",          from: "trigger", when: (c) => c.postRoll, rx: /\bis struck by\b/i },
  { id: "targetsOwner",      from: "trigger", when: (c) => c.targetsOwner,
    rx: /\bagainst (?:you|them|him|her|it|the [\w'’-]+(?: [\w'’-]+)?)(?=[\s,.]|$)/i },
  { id: "victimNotSelf",     from: "trigger", when: (c) => c.victimNotSelf,
    rx: /\bother than (?:you|them|him|her|it|the [\w'’-]+)(?=[\s,.]|$)/i },
  { id: "sourceScope",       from: "trigger", when: (c) => c.sourceScope,
    rx: /\b(?:an?|any|one) (?:[\w-]+ )*?(?:enemy|ally) grabs\b/i },
  { id: "rolledDamage",      from: "trigger", when: (c) => c.rolledDamage, rx: /\bdeals? rolled damage\b/i },
  { id: "abilityDealsDamage", from: "trigger", when: (c) => c.abilityDealsDamage, rx: /\bdamage-dealing\b|\bthat deals? damage\b/i },
  { id: "tauntedByOwner",    from: "trigger", when: (c) => c.tauntedByOwner,
    rx: /\b(?:the [\w'’-]+ has|you have) taunted\b|\btaunted by (?:the [\w'’-]+|you)\b/i },
  { id: "ownerLacks",        from: "trigger", when: (c) => c.ownerLacks, rx: /\b(?:you are|the [\w'’-]+ is) not \w+/i },
  { id: "ownerEffect",       from: "trigger", when: (c) => c.ownerEffect?.label,
    rx: /\b(?!(?:taunted|grabbed|restrained|frightened|slowed|weakened|dazed|bleeding)\b)\w+ed by (?:you|the [\w'’-]+)\b|\byou(?:['’]ve| have) (?!(?:taunted|grabbed|restrained|frightened|slowed|weakened|dazed|bleeding)\b)\w+ed\b/i },
  { id: "through",           from: "trigger", when: (c) => c.through,
    rx: /\bmoves? through (?:an?|any) [\w-]+(?:['’]s space)?/i },
  { id: "entersSpace",       from: "trigger", when: (c) => c.entersSpace, rx: /\benters? this space\b/i },
  { id: "lineOfEffect",      from: "trigger", when: (c) => c.lineOfEffect, rx: LINE_OF_EFFECT },
  { id: "victimNotMentor",   from: "trigger", when: (c) => c.victimNotMentor, rx: /\bother than (?:their|its|your) mentor\b/i },
  { id: "organization",      from: "trigger", when: (c) => c.organization?.exclude?.length || c.organization?.include?.length,
    rx: /\bnon-(?:minion|leader|solo|elite)\b|\bwho (?:isn['’]t|is not) an? (?:minion|leader|solo|elite)\b|\b(?:enemy |ally )?minion\b/i },
  { id: "fmType",            from: "trigger", when: (c) => c.fmType, rx: /\b(?:push|pull|slide)(?:e?s)?\b/i },
  { id: "victimEndsAdjacent", from: "trigger", when: (c) => c.victimEndsAdjacent,
    rx: /\b(?:end[\w ]*? )?adjacent to (?:you|one of (?:your|their) allies)\b/i },
  { id: "firstTurn",         from: "trigger", when: (c) => c.firstTurn, rx: /\bfirst turn\b/i },
  { id: "damageOutcome",     from: "trigger", when: (c) => c.damageOutcome?.length,
    rx: /\b(?:makes? [\w ]+? winded(?: or reduces? [\w ]+? to 0 stamina)?|reduces? [\w ]+? to 0 stamina|(?:causes? [\w ]+? to )?become winded|kills? [\w -]+)/i },
  { id: "reducedByImmunity", from: "trigger", when: (c) => c.reducedByImmunity, rx: /\bwith damage immunity\b/i },
  { id: "rangeMin",          from: "trigger", when: (c) => c.rangeMin, rx: /\b\d+ or more squares away(?: from you)?/i },
  { id: "notForceMoved",     from: "trigger", when: (c) => c.notForceMoved, rx: /\b(?:isn['’]t|is not) also force moved\b/i },
  { id: "ownerGrabbing",     from: "trigger", when: (c) => c.ownerGrabbing, rx: /\bhave a creature of your size or smaller grabbed\b/i },
  { id: "fromFalling",       from: "trigger", when: (c) => c.fromFalling, rx: /\b(?:after a fall|falling creature|falls and would land)\b/i },
  { id: "victimCondition",   from: "trigger", when: (c) => c.victimCondition,
    rx: /\bdamage to (?:a|an|any|the) (?:bleeding|dazed|frightened|grabbed|prone|restrained|slowed|taunted|weakened) (?:creature|enemy|target)\b/i },
  { id: "fallReduction",     from: "effect",  when: (c) => c.fallReduction,
    rx: /\breduce (?:the )?(?:effective height|distance) of (?:the|your) fall by (?:\d+ squares|a number of squares equal to your jump distance)/i },
  { id: "subjectConcealed",  from: "trigger", when: (c) => c.subjectConcealed, rx: /\b(?:with concealment|while (?:you are |the self is )?concealed)\b/i },
  { id: "fromForcedMovement", from: "trigger", when: (c) => c.fromForcedMovement,
    rx: /\bdamage from (?:being )?(?:force moved|forced movement|a collision)\b/i },
  { id: "arrives",           from: "trigger", when: (c) => c.arrives, rx: /\bmoves? adjacent to (?:you|the self)\b/i },
  { id: "highGround",        from: "trigger", when: (c) => c.highGround, rx: /\bdue to high ground\b/i },
  { id: "damageReduction",   from: "effect",  when: (c) => c.damageReduction,
    rx: /\breduce (?:any|that|this|the|the falling) damage(?: from [\w ]+?)? by (?:\d+|an amount equal to [\w +]+)/i },
  { id: "fallSafe",          from: "effect",  when: (c) => c.fallSafe, rx: /\b(?:safely catch|neither of you takes damage)\b[^.]*/i },
  { id: "damageBonus",      from: "effect",  when: (c) => c.damageBonus, rx: /\bgains? a \+ ?\d+ damage bonus\b/i },
  { id: "damageMin",        from: "trigger", when: (c) => c.damageMin != null, rx: /\b\d+ or more (?:rolled )?damage\b|\bmore than \d+ (?:rolled )?damage\b/i },
  { id: "damageTypeChange", from: "effect",  when: (c) => c.damageTypeChange, get rx() { return DAMAGE_TYPE_CHANGE; } },
  { id: "flankedByDealer",   from: "trigger", when: (c) => c.flankedByDealer,
    rx: /\bwhile (?:a second|another) creature is flanking (?:you|the [\w'’-]+)\b/i },
  { id: "rangeOn",           from: "trigger", when: (c) => c.rangeOn === "dealer",
    rx: /\bwithin (?:\d+ squares?|a number of squares equal to [\w'’ ]+? score)/i },
  { id: "rangeAbility",      from: "trigger", when: (c) => c.range?.ability,
    rx: /\bwithin distance of (?:your|the [\w'’-]+) [\w'’ -]+?(?:free strike|ability)\b/i },
  { id: "ownerInAbilityRange", from: "trigger", when: (c) => c.ownerInAbilityRange,
    rx: /\bwhile (?:you are|the [\w'’-]+ is) within the ability['’]s distance\b/i },
  { id: "throughMark",       from: "trigger", when: (c) => c.throughMark, rx: /\binsubstantial to (?:you|the [\w'’-]+)\b/i },
  { id: "wouldLeave",        from: "trigger", when: (c) => c.wouldLeave, rx: /\bdamage that would leave them dying\b/i },
  { id: "damageRedirect",    from: "effect",  when: (c) => c.damageRedirect,
    rx: /\b(?:redirects the triggering effect[^.]*|the target of the triggering damage instead)/i },
  { id: "fmMod",             from: "effect",  when: (c) => c.fmMod, list: () => FM_MOD_TEXT.map((r) => r[0]) },
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
    found.push({ id: f.id, from: f.from, fragment: (f.fragment?.(m) || m[0]).trim(), fields });
  }
  return found;
}

const EVENT_VERB = /\b(takes?|deals?|damages?|dies|destroyed|moves?|enters?|leaves?|shifts?|starts?|ends?|uses?|makes?|targets?|targeted|forced?|pushed|pulled|slid|becomes?|gains?|grabs?|regains?|reduced?|winded|dying|falls|flies|comes|obtains?|push(?:es)?|pulls?|slides?|knocks?|causes?|spends?)\b/;

function stripPrefix(t) {
  return t.replace(/^(whenever|when|once per (round|turn) when|after)\s+/i, "").replace(/^while [^,]+,\s*/i, "");
}

function splitClauses(text) {
  const t = stripPrefix(text.trim().replace(/\.$/, ""));
  
  if (/^(the [\w'’ ]+|you) or (?:an|any) ally\b/i.test(t)) return [t];
  
  const pair = t.match(/^you or your companion (\w+)\b(.*)$/i);
  if (pair) {
    const base = pair[1].replace(/(?<=sh|ch|x|ss|z)es$/i, "").replace(/s$/i, "");
    return [...splitClauses(`you ${base}${pair[2]}`), ...splitClauses(`your companion ${pair[1]}${pair[2]}`)];
  }
  
  const qi = t.search(/\b(that|which) \b/);
  if (qi > 0) { const inner = splitClauses(t.slice(0, qi).trim()); inner[inner.length - 1] += " " + t.slice(qi); return inner; }
  const DT = "(?!(?:acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic|untyped)\\b)";
  const split = t.split(new RegExp(`,\\s*or\\s+${DT}|,\\s+(?=(?:is|are|takes|moves|starts|ends|uses|makes|becomes|gains|dies|would)\\b)|\\s+or\\s+(?=(?:is|are|takes|moves|starts|ends|uses|makes|becomes|gains|dies|would|reduced|falls|damages|obtains|knocks?|the [\\w]+ obtains)\\b)`, "i"));
  
  const shared = split.at(-1).match(/\b(?:to|from|against) ((?:you|the [\w'’ -]+|an? [\w'’ -]+|any [\w'’ -]+))$/i)?.[1];
  const parts = shared ? split.map((p, i) => i < split.length - 1 && /\b(?:to|from|against)$/i.test(p.trim()) ? `${p.trim()} ${shared}` : p) : split;
  if (parts.length <= 1 || !parts.every(p => EVENT_VERB.test(p.toLowerCase())) || parts.slice(1).some(p => /^(that|which|has|had)\b/i.test(p))) return [t];
  const subjectMatch = t.match(/^((?:the target|you|your companion|(?:a|an|any|one|another) [\w'’ -]+?|the [\w'’ ]+?)(?= (takes?|deals?|damages?|dies|is|are|moves?|enters?|starts?|ends?|uses?|makes?|targets?|would|force|becomes?|gains?|grabs?|regains?|comes|flies|loses?|causes?|obtains?|push(?:es)?|pulls?|slides?|knocks?|spends?|reduces?|kills?)\b))/i);
  const subject = subjectMatch ? subjectMatch[1] : "";
  return parts.map((p, i) => (i === 0 || !subject || /^(the|you|an?|another|any|one) /i.test(p)) ? p.trim() : (subject + " " + p.trim()));
}

const OWNER_STOPWORDS = new Set(["the", "and", "von", "van", "der", "den", "del", "los", "las"]);

function ownerWords(ownerName) {
  return (ownerName || "").toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !OWNER_STOPWORDS.has(w));
}

const SUBJECT_RX = /^(you\b|the target\b|your companion\b|the [\w'’ ]+?(?= (takes?|deals?|damages?|dies|is|are|moves?|enters?|starts?|ends?|uses?|makes?|targets?|would|force|becomes?|gains?|grabs?|regains?|comes|flies|loses?|reduced?|reduces?|obtains?|hears|causes?|fails?|succeeds?|marks|escapes?))|(?:an?|one|another|any) [\w -]+?(?: or object)?(?= (takes?|deals?|damages?|dies|is|are|moves?|enters?|starts?|ends?|uses?|makes?|targets?|would|force|becomes?|gains?|grabs?|regains?|comes|flies|loses?|reduced?|reduces?|marks|resists|fails?|succeeds?|spends?|escapes?|drops?|falls below|within)))/;

function scopeOf(lc, event, owner) {
  const words = ownerWords(owner);
  const mentionsOwner = words.some(w => new RegExp(`\\b${w}\\b`).test(lc));
  const subj = lc.match(SUBJECT_RX);
  const s = subj ? subj[1] : "";
  if (/^you or (?:a|an|any|another) (?:[\w-]+ )?creature\b/.test(lc)) return "ANY";
  if (/^(?:a|an|any) director-controlled creature\b/.test(lc)) return "SELF_OR_ALLY";
  if (/^your stamina\b/.test(lc)) return "SELF";

  const objectEvents = new Set(["TAKES_DAMAGE", "TARGETED_BY_STRIKE", "WINDED_OR_DYING", "WINDED", "DYING", "DIES"]);
  const objectSide = /\b(deals? [\w, ]*damage to|damages?|targets?|strike against|strikes?|causes?|reduces?) (you|the target|an ally|any ally|an enemy|a creature|the [\w' ]+|[a-z]+)\b/;
  let affected = s;
  if (objectEvents.has(event) && !/^(you|the target)\b/.test(s) && !/\b(takes?|is targeted|targeted by|is made|is reduced|dies)\b/.test(lc)) {
    const m = lc.match(objectSide); affected = m ? m[2] : s;
  }
  
  if (event === "TAKES_DAMAGE" && /^(the self|you)\b/.test(s) && /\bdamages? (a|an|another) /.test(lc)) {
    return "SELF:DEALS";
  }
  if (/^(the [\w' ]+|you) or (?:an|any) ally\b/.test(affected) || /^(the [\w' ]+|you) or (?:an|any) ally\b/.test(lc)) return "SELF_OR_ALLY";
  if (/^you\b/.test(affected) || /^the self\b/.test(affected)) return "SELF";
  if (/mentor/.test(affected)) return "MENTOR";
  if (/^the target\b/.test(affected)) return "TARGET";
  if (/companion/.test(affected)) return "COMPANION";
  if (/\bally\b|another hero|a hero\b|ally minion/.test(affected)) return "ALLY";
  
  if (words.includes("rival") && /^(?:a|an|any|each|one)(?: other)? rivals?\b/.test(affected)) return "GROUP";
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
  normalized = normalized.replace(/\b(you|they) pass through\b/gi, "$1 move through").replace(/\bpasses through\b/gi, "moves through");
  normalized = normalized.replace(/\benters (?:a|an|any|another) crea ?ture['’]s space\b/gi, "moves through a creature's space");
  normalized = normalized.replace(/\b(you|they) make a power roll that imposes forced movement on (a|the|that) target\b/gi, "$1 force move $2 target");
  normalized = normalized.replace(/\b(you|they) make a strike that deals ((?:untyped|acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic) )?damage\b/gi, (m, who, type) => `${who} deal ${type ?? ""}damage with a strike`);
  normalized = normalized.replace(/\bwinded or (?:are|is) dying\b/gi, "winded or dying");
  normalized = normalized.replace(/\b(deals?|takes?) or (deals?|takes?) ((?:[\w-]+ )*?damage)\b/i, "$1 $3, or $2 $3");
  normalized = normalized.replace(/\b(?:a|an|any|one) (?:creature|enemy|hero)( within \d+ squares?| within (?:distance|reach)| adjacent(?: to [\w'’ ]+?)?)? makes? a (melee |ranged )?strike against ([\w'’ -]+?)(?=[.,]| while| using| with| that|$)/gi,
    (m, qual, kind, tgt) => `${tgt} is struck by a ${kind ?? ""}strike${qual ? ` while${qual}` : ""}`);
  return normalized;
}

export function annotateTrigger(text, { dsid, ownerName, effectText, targetType, side } = {}) {
  const clean = String(text ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return { sentence: "", segments: [] };
  const parse = parseTrigger(clean, { dsid, ownerName, effectText, targetType, side });
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
    const ownerMatch = clause?.ownerEffect ? lc.match(CLAUSE_FLAGS.find((f) => f.id === "ownerEffect").rx) : null;
    let subject = lc.match(SUBJECT_RX);
    if (subject && ownerMatch && ownerMatch.index > subject.index && ownerMatch.index < subject.index + subject[0].length) {
      subject = { index: subject.index, 0: subject[0].slice(0, ownerMatch.index - subject.index).trimEnd() };
    }
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
    add("qualifier", ownerMatch, "qualifiers");
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

const STATE_WORDS = "bleeding|weakened|winded|dazed|frightened|slowed|restrained|grabbed|taunted|prone";
const TURN_START_WHILE = new RegExp(String.raw`\b(starts? their turn) while ((?:${STATE_WORDS})(?:(?:,\s*|\s+)(?:or\s+|and\s+)?(?:${STATE_WORDS}))*)`, "i");


const enricherLabels = (s) => (s == null ? s : String(s).replace(/\[\[[^\]]*\]\]\{([^}]*)\}/g, "$1"));

export function parseTrigger(text, options = {}) {
  options = { ...options, effectText: enricherLabels(options.effectText), spendText: enricherLabels(options.spendText) };
  text = enricherLabels(String(text ?? "")).replace(/\b[MARIP]<(\w+)/g, "$1 potency");
  
  
  const states = text.match(TURN_START_WHILE);
  if (states) text = text.replace(states[0], states[1]);
  const result = abilityWideLayer(potencyLayer(effectPostRollLayer(powerRollFmLayer(lineOfEffectLayer(damageTypeLayer(resistedLayer(parseTriggerClauses(text, options), options.effectText), options.effectText), text), text), options.effectText), options.effectText, options.spendText), options.effectText);
  if (!states) return result;
  const subjectStates = states[2].toLowerCase().split(/,\s*(?:or\s+|and\s+)?|\s+(?:or|and)\s+/).filter(Boolean);
  return { ...result, clauses: result.clauses.map((c) => (c.event === "TURN_START" ? { ...c, subjectStates } : c)) };
}


function effectPostRollLayer(result, effectText) {
  if (!POST_ROLL_PHRASE.test(String(effectText ?? ""))) return result;
  return { ...result, clauses: result.clauses.map((c) => (c.event === "POWER_ROLL" ? { ...c, postRoll: true } : c)) };
}

function powerRollFmLayer(result, text) {
  if (!/\bmakes? a power roll that imposes forced movement\b/i.test(text)) return result;
  return { ...result, clauses: result.clauses.map((c) => (c.event === "FORCE_MOVES" ? { ...c, fmPowerRoll: true } : c)) };
}

const DAMAGE_TYPE_CHANGE = /\b(?:(?:change (?:the (?:ability|strike)['’]s|its|that|the) damage type to|make that damage) (acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic)\b(?!,? (?:or )?(?:acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic)\b)|(?:change it to|can deal) (acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic) damage instead\b)/i;

const TYPE_WORDS = "acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic";
const DAMAGE_TYPE_LIST = new RegExp(String.raw`\b(?:change (?:the (?:ability|strike)['’]s|its|that|the) damage type to|can deal) ((?:${TYPE_WORDS})(?:,? (?:or )?(?:${TYPE_WORDS}))+) damage\b`, "i");
const DAMAGE_TYPE_CHOSEN = /\bdeal (?:damage of )?(?:the|your) chosen (?:damage )?type\b/i;

function damageTypeLayer(result, effectText) {
  const text = String(effectText ?? "");
  const m = text.match(DAMAGE_TYPE_CHANGE);
  let patch = m ? { damageTypeChange: (m[1] ?? m[2]).toLowerCase() } : null;
  if (!patch) {
    const list = text.match(DAMAGE_TYPE_LIST);
    if (list && (/^change/i.test(list[0]) || /\binstead\b/i.test(text))) patch = { damageTypeChoices: [...new Set(list[1].toLowerCase().split(/,? or |, /).filter(Boolean))] };
    else if (DAMAGE_TYPE_CHOSEN.test(text) && /\binstead\b/i.test(text)) patch = { damageTypeChoices: TYPE_WORDS.split("|") };
  }
  if (!patch) return result;
  return { ...result, clauses: result.clauses.map((c) => (c.event === "DEALS_DAMAGE" || c.event === "USES_ABILITY" ? { ...c, ...patch } : c)) };
}

function resistedLayer(result, effectText) {
  if (!/\beven if (?:you|they|it) resists?\b/i.test(effectText ?? "")) return result;
  return { ...result, clauses: result.clauses.map((c) => (carries(c, "FORCE_MOVED") ? { ...c, evenIfResisted: true } : c)) };
}

function parseTriggerClauses(text, { dsid, ownerName, effectText, targetType, side } = {}) {
  const id = dsid || "";
  const key = ownerName ? `${generateDSID(ownerName)}:${id}` : null;
  const special = (key && SPECIAL_CASES[key]) || SPECIAL_CASES[id];
  if (special) return reductionLayer(fmModLayer(todoLayer(bespokeLayer(rangeLayer(holdHalfLayer(postRollHalfLayer(rollModLayer(redirectLayer(damageModLayer(resolveTargetScope({ ...special, confidence: "high", source: "special" }, targetType), id, effectText), id, effectText), id, effectText), id, effectText), id, effectText)), id), id), id, effectText), effectText);

  const clean = text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const clauses = [];
  let ambiguous = false;

  const normalized = normalizeTrigger(clean, ownerName);
  for (const clause of splitClauses(normalized)) {
    const lc = clause.toLowerCase();
    const hits = EVENTS.filter(([, rx]) => rx.test(clause)).map(([e]) => e);
    const events = hits.filter(e => !(SHADOW[e] || []).some(s => hits.includes(s)));
    let unsure = events.length !== 1;
    let scope = scopeOf(lc, events[0], ownerName);
    if (scope === "UNKNOWN" && (events[0] === "RESISTS_POTENCY" || (events[0] === "FALL_START" && /^(?:you|they)\b/.test(lc)))) scope = "SELF";
    const ownGrab = events[0] === "GRAB_ENDS" && /\b(?:your|the self['’]s) grab\b|^(?:you|the self) releases?\b/.test(lc);
    if (ownGrab || (events[0] === "MARKED" && /\bmarks (?:you|the self)\b/.test(lc))) scope = "SELF";
    if (scope === "SELF:DEALS") { scope = "SELF"; events.splice(0, events.length, "DEALS_DAMAGE"); }
    if (scope === "UNKNOWN") unsure = true;
    const qualifiers = QUALIFIERS.map(rx => lc.match(rx)?.[0]).filter(Boolean);
    const entry = { event: events[0] || "UNKNOWN", events, scope, qualifiers };
    
    if (POST_ROLL_PHRASE.test(lc) && entry.event === "POWER_ROLL" && hits.includes("TARGETED_BY_STRIKE")) {
      entry.event = "TARGETED_BY_STRIKE";
      entry.events = ["TARGETED_BY_STRIKE"];
    }
    if (entry.event === "TARGETED_BY_STRIKE" && !/\bstrik|\bstruck\b/.test(lc)) {
      entry.event = "TARGETED_BY_ABILITY";
      entry.events = entry.events.map((e) => e === "TARGETED_BY_STRIKE" ? "TARGETED_BY_ABILITY" : e);
    }
    if (/\bis struck by\b/.test(lc)) entry.postRoll = true;
    if (POST_ROLL_PHRASE.test(lc)) entry.postRoll = true;
    
    const tiers = [...lc.matchAll(/\btier ([1-3])\b/g)].map((m) => Number(m[1]));
    if (tiers.length && /\boutcome\b/.test(lc)) {
      const floor = lc.match(/\btier ([1-3]) (?:outcome )?or (?:higher|better)\b/);
      entry.tierFilter = floor ? [1, 2, 3].filter((t) => t >= Number(floor[1])) : [...new Set(tiers)];
      entry.postRoll = true;
      
      if (entry.event === "POWER_ROLL_RESULT" && entry.scope === "SELF" && /^(?:you|the self) (?:obtains?|scores?|rolls?|gets?)\b/.test(lc)) entry.rollerScoped = true;
    }
    if (ownGrab) entry.asSource = true;
    if (entry.event === "STAMINA_BELOW") {
      const below = lc.match(/\bbelow (\d+)\b/);
      const orLess = lc.match(/\bto (\d+) stamina or (?:less|lower|fewer)\b/);
      entry.value = below ? Number(below[1]) : orLess ? Number(orLess[1]) + 1 : undefined;
    }
    if (entry.event === "SAVING_THROW" && /\bsucceeds? on a saving throw\b/.test(lc)) entry.saveSucceeds = true;
    if (entry.event === "SAVING_THROW" && /\bfails? (?:a|the) saving throw\b/.test(lc)) entry.saveFails = true;
    if (/\bwhile (?:they are |you are )?winded\b(?! or dying)/.test(lc)) entry.whileWinded = true;
    const beyond = lc.match(/\bmore than (\d+) squares away from (?:you|the self)\b/);
    if (beyond && !entry.rangeMin) entry.rangeMin = Number(beyond[1]) + 1;
    const saveAgainst = entry.event === "SAVING_THROW" && lc.match(/\bsaving throw to end the (\w+) condition\b/);
    if (saveAgainst) entry.saveAgainst = saveAgainst[1];
    if (entry.event === "POWER_ROLL_RESULT" && /\bscores? a critical hit\b/.test(lc)) {
      Object.assign(entry, { critical: true, postRoll: true, abilityType: "main" });
      if (entry.scope === "SELF") entry.rollerScoped = true;
      if (/\bwith a melee free strike\b/.test(lc)) entry.abilityDsid = "melee-free-strike";
    }
    
    const dmgTypes = lc.match(/\b(acid|cold|corruption|fire|holy|lightning|poison|psychic|sonic)\b/g);
    const notTypes = lc.match(NOT_DAMAGE_TYPES) ?? lc.match(NOT_DAMAGE_TYPES_AFTER);
    if (notTypes) {
      entry.damageTypes = DAMAGE_TYPES.filter((t) => !notTypes[0].includes(t));
      entry.qualifiers = entry.qualifiers.filter((q) => !notTypes[0].includes(q));
    }
    else if (dmgTypes && /damage/.test(lc)) entry.damageTypes = [...new Set([...dmgTypes, ...(/\buntyped\b/.test(lc) ? ["untyped"] : [])])];
    else if (/\buntyped damage\b/.test(lc)) entry.damageTypes = ["untyped"];
    const using = clause.match(/\busing (?:their |its |the )?([A-Z][\w' ]*?)(?=[.,]|$| (?:ability|maneuver|action))/);
    if (using) entry.abilityDsid = generateDSID(using[1]);

    Object.assign(entry, abilityFiltersFrom(clause, effectText));
    
    const victim = entry.event === "DEALS_DAMAGE" && lc.match(/\b(?:deals? [\w, ]*damage to|damages?) (?:an?|any) (ally|enemy)\b/);
    if (victim) entry.victimScope = victim[1] === "ally" ? "ALLY" : "ENEMY";
    const dealerSide = entry.event === "TAKES_DAMAGE" && (lc.match(/\btakes? [\w, ]*damage from an? (ally|enemy)\b/)
      ?? lc.match(/^(?:an?|any|another) (?:adjacent )?(ally|enemy)\b[^.]*?\b(?:deals [\w, ]*damage to|damages) /));
    if (dealerSide) entry.dealerScope = dealerSide[1] === "ally" ? "ALLY" : "ENEMY";
    const from = entry.event === "TAKES_DAMAGE" && lc.match(/\btakes? [\w, ]*damage from (you|the [\w'’ -]+?)(?=[.,]|$| while| with| using)/);
    if (from && (/^(?:you|the self)$/.test(from[1]) || ownerWords(ownerName).some((w) => new RegExp(`\\b${w}\\b`).test(from[1])))) {
      Object.assign(entry, { event: "DEALS_DAMAGE", events: ["DEALS_DAMAGE"], scope: "SELF" });
      const side = lc.match(/^(?:an?|any|one) (?:[\w-]+ )*?(enemy|ally)\b/)?.[1];
      if (side) entry.victimScope = side.toUpperCase();
    }
    const eff = lc.match(/ends? the ([\w -]+?) effect/); if (eff) entry.effectName = eff[1];
    const zone = lc.match(/\b(?:enters?|starts? their turn (?:in|within|adjacent to)) (?:the|a) ([\w -]+?)(?: or|,|$)/); if (zone) entry.zone = zone[1];
    const excl = lc.match(/(?:doesn['’]t|does not) also targets? (?:the )?([\w'’ -]+?)(?=[.,]|$| with| using)/);
    if (excl) {
      const words = ownerWords(ownerName);
      if (/\b(self|you)\b/.test(excl[1]) || !words.length || words.some((w) => excl[1].includes(w))) entry.excludeSelfTarget = true;
    }
    if (/\b(gains? (an|a double) edge|has an edge|with an edge)\b/.test(lc)) {
      entry.edgeRequired = true;
      const also = [/\bbanes?\b/.test(lc) && "bane", /\bsurges?\b/.test(lc) && "surge"].filter(Boolean);
      if (also.length) entry.rollHas = ["edge", ...also];
    }
    if (/\b(?:damage from|incorporating) (?:one or more|a|\d+) surges?\b/.test(lc)) entry.rollHas = [...new Set([...(entry.rollHas ?? []), "surge"])];
    if (/\bsaving throw\b|ends? at the end of their turn/.test(lc) && entry.event === "CONDITION_GAIN") entry.durationFilter = "save-or-eot";
    if (entry.event === "CONDITION_GAIN") {
      const conds = [...new Set([...lc.matchAll(/\b(grabbed|restrained|frightened|taunted|prone|slowed|weakened|dazed|bleeding|hidden)\b/g)].map((m) => m[1]))];
      if (conds.length) entry.condition = conds.length > 1 && /\bor\b/.test(lc) ? conds : conds[0];
      const grabs = lc.match(/\bgrabs (two|three|\d+|a|an|one)\b/);
      if (grabs) {
        entry.condition = "grabbed";
        entry.asSource = true;
        const n = { two: 2, three: 3, a: 1, an: 1, one: 1 }[grabs[1]] ?? Number(grabs[1]);
        if (n > 1) entry.grabCount = n;
      }
    }
    if (entry.event === "CONDITION_GAIN" && /^(?:you|the self) grab (?:a|an|any|one|two)\b/.test(lc)) {
      Object.assign(entry, { condition: "grabbed", asSource: true, scope: "ANY" });
    }
    if (entry.event === "CONDITION_GAIN" && /^(?:you|the self) knocks? (?:a|an|any|the) [\w -]+? prone\b/.test(lc)) {
      Object.assign(entry, { condition: "prone", asSource: true, scope: "ANY" });
    }
    if (entry.event === "CONDITION_GAIN" && entry.condition && /^(?:you|the self) causes? (?:a|an|any|the) [\w -]+? to become\b/.test(lc)) {
      Object.assign(entry, { asSource: true, scope: "ANY" });
    }
    const hitState = entry.event === "DEALS_DAMAGE" && lc.match(/\bdamage to (?:a|an|any|the) (bleeding|dazed|frightened|grabbed|prone|restrained|slowed|taunted|weakened) (?:creature|enemy|target)\b/);
    if (hitState) entry.victimCondition = hitState[1];
    
    const outcome = lc.match(/^(?:you|the self) (?:reduces? (?:an?|any|another|the) ([\w -]+?) to 0 stamina|(?:makes?|causes?) (?:an?|any|another|the) ([\w -]+?) (?:to become )?winded|kills? (?:an?|any|another|the) ([\w -]+?))(?=$|[ ,.])/);
    if (outcome && ["DIES", "DYING", "WINDED", "WINDED_OR_DYING"].includes(entry.event)) {
      const who = outcome[1] ?? outcome[2] ?? outcome[3];
      const outcomes = [/winded/.test(lc) ? "winded" : null, /0 stamina|\bkills?\b/.test(lc) ? "zero" : null].filter(Boolean);
      Object.assign(entry, { event: "DEALS_DAMAGE", events: ["DEALS_DAMAGE"], scope: "SELF", damageOutcome: outcomes });
      if (/\benemy\b/.test(who)) entry.victimScope = "ENEMY";
      else if (/\bally\b/.test(who)) entry.victimScope = "ALLY";
    }
    
    if (entry.event === "FORCE_MOVES" && /\binto (?:an?|another|the) (?:object|creature|wall)/.test(lc)
      && !(/\binto (?:an?|the) object\b/.test(lc) && /\bextra damage equal to\b/i.test(effectText ?? ""))) unsure = true;
    if (/\b(?:with concealment|while (?:you are |the self is )?concealed)\b/.test(lc)) entry.subjectConcealed = true;
    if (entry.event === "TURN_START" && /\bturn (?:with|while)\b(?!.*\bgrabbed\b)/.test(lc) && !entry.subjectConcealed) unsure = true;
    if (/\btakes? damage from (?:being )?(?:force moved|forced movement|a collision)\b/.test(lc)) {
      Object.assign(entry, { event: "TAKES_DAMAGE", events: ["TAKES_DAMAGE"], fromForcedMovement: true });
      unsure = entry.scope === "UNKNOWN";
      const cut = String(effectText ?? "").match(/\breduce (?:that|the) damage by (?:(\d+)|an amount equal to your level)\b/i);
      if (cut) entry.damageReduction = cut[1] ? Number(cut[1]) : "level";
    }
    if (entry.event === "FORCE_MOVES") {
      const kind = lc.match(/\b(push|pull|slide)(?:e?s)?\b/)?.[1];
      if (kind) entry.fmType = kind;
      const victim = lc.match(/\b(?:push|pull|slide)(?:e?s)? (?:an?|any|that|the) (enemy|ally)\b/)?.[1];
      if (victim) entry.victimScope = victim.toUpperCase();
      const ends = lc.match(/\b(?:adjacent to (you|the self)|end[\w ]*? adjacent to (?:one of )?(?:your|their) (all(?:y|ies)))\b/);
      if (ends) entry.victimEndsAdjacent = ends[1] ? "self" : "ally";
      if (/\binstead\b/i.test(effectText ?? "")) entry.fmBefore = true;
    }
    
    if (side === "hero" && entry.event === "DIES" && /\b0 stamina\b/.test(lc) && !/\b(?:dies|die)\b/.test(lc)
      && /^(?:you|your stamina|an? (?:[\w-]+ )*?(?:ally|hero))\b/.test(lc) && ["SELF", "ALLY", "SELF_OR_ALLY"].includes(entry.scope)) {
      entry.event = "DYING";
      entry.events = ["DYING"];
    }
    if (entry.event === "FALL_START") {
      const fx = String(effectText ?? "");
      const by = fx.match(/\breduce (?:the )?(?:effective height|distance) of (?:the|your) fall by (?:(\d+) squares|a number of squares equal to your jump distance)/i);
      if (by) entry.fallReduction = by[1] ? Number(by[1]) : "jump";
    }
    if (scope === "GROUP") entry.groupName = lc.match(/^(?:a|an|any|one)(?: other)? ([\w -]+?) (?:within|adjacent|acting|is|takes|dies|starts|moves|uses|makes|deals|ends|enters)\b/)?.[1];
    if (!["USES_ABILITY", "DEALS_DAMAGE", "TAKES_DAMAGE", "RESISTS_POTENCY", "FORCE_MOVES", "TARGETED_BY_STRIKE", "TARGETED_BY_ABILITY", "POWER_ROLL"].includes(entry.event)) {
      delete entry.abilityKeywords;
      delete entry.abilityKeywordsAll;
      delete entry.abilityKeywordGroups;
    }
    if (entry.event === "USES_ABILITY" && /\bagainst (?:you|the self)\b/.test(lc)) entry.targetsOwner = true;
    if (entry.event === "CONDITION_GAIN" && /\bgrabs the self\b/.test(lc)) {
      const side = lc.match(/^(?:an?|any|one) (?:[\w-]+ )*?(enemy|ally|creature)\b/)?.[1];
      Object.assign(entry, { condition: "grabbed", scope: "SELF" });
      delete entry.asSource;
      delete entry.grabCount;
      if (side === "enemy" || side === "ally") entry.sourceScope = side.toUpperCase();
    }
    if (entry.event === "DEALS_DAMAGE" && /\bother than the self\b/.test(lc)) entry.victimNotSelf = true;
    if (/\b(?:the self has|you have) taunted\b|\btaunted by (?:the self|you)\b/.test(lc)) entry.tauntedByOwner = true;
    const by = lc.match(OWNER_EFFECT);
    const byLabel = by?.[1] ?? by?.[3];
    if (by && !/^(?:taunted|grabbed|restrained|frightened|slowed|weakened|dazed|bleeding)$/.test(byLabel)) entry.ownerEffect = { label: byLabel, on: ownerEffectRole(lc, by[2] ? by.index + by[0].indexOf(by[2]) : by.index, entry.event) };
    const lacks = lc.match(/\b(?:you are|the self is) not (taunted|grabbed|restrained|frightened|prone|slowed|weakened|dazed|bleeding)\b/);
    if (lacks) entry.ownerLacks = lacks[1];
    if (entry.event === "MOVES" && /\benters? this space\b/.test(lc)) entry.entersSpace = true;
    if (entry.event === "MOVES" && /\bmoves? through\b/.test(lc)) {
      entry.through = true;
      const side = lc.match(/\bthrough (?:an?|any) (enemy|ally)\b/)?.[1];
      if (side) entry.throughScope = side.toUpperCase();
      if (/\bother than (?:their|its|your|the self['’]s) mentor\b/.test(lc)) entry.victimNotMentor = true;
    }
    if ((TARGETING_EVENTS.has(entry.event) || entry.event === "DEALS_DAMAGE") && /\bdeals? rolled damage\b/.test(lc)) entry.rolledDamage = true;
    if ((TARGETING_EVENTS.has(entry.event) || entry.event === "USES_ABILITY") && !entry.rolledDamage
      && /\bdamage-dealing\b|\b(?:abilit(?:y|ies)|strikes?) that deals? damage\b/.test(lc)) entry.abilityDealsDamage = true;
    const minDamage = (entry.event === "DEALS_DAMAGE" || entry.event === "TAKES_DAMAGE") && lc.match(MIN_DAMAGE);
    if (minDamage) entry.damageMin = minDamage[1] ? Number(minDamage[1]) : Number(minDamage[2]) + 1;
    const strikeKind = (TARGETING_EVENTS.has(entry.event) || entry.event === "MAKES_STRIKE") && !entry.abilityKeywords?.length && lc.match(/\b(melee|ranged) strike\b/);
    if (strikeKind) Object.assign(entry, { abilityKeywords: [strikeKind[1], "strike"], abilityKeywordsAll: true });
    else if (entry.event === "DEALS_DAMAGE" && !entry.abilityKeywords?.length && /\bwith a strike\b/.test(lc)) entry.abilityKeywords = ["strike"];
    if (TARGETING_EVENTS.has(entry.event) && /\bwhile (?:a second|another) creature is flanking (?:you|the self)\b/.test(lc)) entry.flankedByDealer = true;
    const dealerWithin = entry.event === "TAKES_DAMAGE" && lc.match(/^(?:an?|any) (adjacent )?(?:[\w-]+ )?(?:creature(?: or object)?|enemy|ally)(?: within (?:(\d+) squares?|distance|a number of squares equal to (?:your|the self['’]s) (might|agility|reason|intuition|presence) score)(?: of (?:you|the self))?)? (?:deals [\w, ]*damage to|damages) (you|the self|the [\w'’ -]+?)(?=[.,]|$| with| using| or)/);
    const atOwner = dealerWithin && (/^(?:you|the self)$/.test(dealerWithin[4]) || ownerWords(ownerName).some((w) => new RegExp(`\\b${w}\\b`).test(dealerWithin[4])));
    if (atOwner && (dealerWithin[1] || / within /.test(dealerWithin[0]))) {
      entry.rangeOn = "dealer";
      if (dealerWithin[3]) entry.range = { char: dealerWithin[3] };
    }
    const distanceOf = lc.match(/\bwithin distance of (?:your|the self['’]s) (?:(melee|ranged) (?:weapon )?free strike|([\w'’ -]+?) ability)\b/);
    if (distanceOf) entry.range = { ability: distanceOf[1] ? `${distanceOf[1]}-free-strike` : generateDSID(distanceOf[2]) };
    const areaOf = !distanceOf && lc.match(/\bin the area of (?:your|the self['’]s) ([\w'’ -]+?) ability\b/);
    if (areaOf) entry.range = { ability: generateDSID(areaOf[1]) };
    if (/\bwhile (?:you are|the self is) within the ability['’]s distance\b/.test(lc)) entry.ownerInAbilityRange = true;
    entry.qualifiers = entry.qualifiers.filter((q) => !coveredQualifier(q, entry));
    if (entry.through && /\binsubstantial to (?:you|the self)\b/.test(lc)) entry.throughMark = "insubstantial";
    const nonOrg = lc.match(/\bnon-(minion|leader|solo|elite)\b|\bwho (?:isn['’]t|is not) an? (minion|leader|solo|elite)\b/);
    if (nonOrg) entry.organization = { exclude: [nonOrg[1] ?? nonOrg[2]] };
    if (unsure) ambiguous = true;
    clauses.push(entry);
  }
  return reductionLayer(fmModLayer(todoLayer(bespokeLayer(rangeLayer(holdHalfLayer(postRollHalfLayer(rollModLayer(redirectLayer(damageModLayer(resolveTargetScope({ clauses, confidence: ambiguous ? "low" : "high", source: "regex" }, targetType), id, effectText), id, effectText), id, effectText), id, effectText), id, effectText)), id), id), id, effectText), effectText);
}
