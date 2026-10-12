const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const asList = (v) => (v == null ? [] : [].concat(v));

const DAMAGE = ["TAKES_DAMAGE", "WOULD_TAKE_DAMAGE", "DEALS_DAMAGE"];
const TARGETED = ["TARGETED_BY_STRIKE", "TARGETED_BY_ABILITY"];
const FORCED = ["FORCE_MOVES", "FORCE_MOVED"];

export const CONDITIONS = ["bleeding", "dazed", "frightened", "grabbed", "prone", "restrained", "slowed", "taunted", "weakened"];
export const ORGANIZATIONS = ["minion", "horde", "platoon", "elite", "leader", "solo"];
export const SIDES = ["SELF", "ALLY", "SELF_OR_ALLY", "ENEMY", "ANY", "FRIENDLY", "NEUTRAL", "HOSTILE", "SECRET"];

const check = (key, events = null, extra = {}) => ({
  key, kind: "check", events,
  read: (c) => (c[key] ? true : undefined),
  write: (c, v) => { if (v) c[key] = true; else delete c[key]; },
  ...extra,
});
const number = (key, events = null, extra = {}) => ({
  key, kind: "number", events,
  read: (c) => (Number.isFinite(c[key]) ? c[key] : undefined),
  write: (c, v) => { if (Number.isFinite(v)) c[key] = v; else delete c[key]; },
  ...extra,
});
const text = (key, events = null, extra = {}) => ({
  key, kind: "text", events,
  read: (c) => (c[key] ? String(c[key]) : undefined),
  write: (c, v) => { if (v) c[key] = v; else delete c[key]; },
  ...extra,
});
const select = (key, options, events = null, extra = {}) => ({
  key, kind: "select", options, events,
  read: (c) => (c[key] ?? undefined),
  write: (c, v) => { if (v) c[key] = v; else delete c[key]; },
  ...extra,
});
const multi = (key, options, events = null, extra = {}) => ({
  key, kind: "multi", options, events,
  read: (c) => (asList(c[key]).length ? asList(c[key]) : undefined),
  write: (c, v) => {
    const list = asList(v);
    if (!list.length) delete c[key];
    else c[key] = extra.single && list.length === 1 ? list[0] : list;
  },
  ...extra,
});

export const QUALIFIERS = [
  { id: "creatureIs", group: "who", icon: "fa-solid fa-user-tag", rules: [
    check("heroOnly"),
    check("notSelf"),
    check("victimNotSelf", ["DEALS_DAMAGE"]),
    text("groupName", null, { input: "keyword" }),
    {
      key: "organization", kind: "multi", options: () => ORGANIZATIONS,
      read: (c) => (c.organization?.exclude?.length ? clone(c.organization.exclude) : undefined),
      write: (c, v) => { const list = asList(v); if (list.length) c.organization = { ...(c.organization ?? {}), exclude: list }; else delete c.organization; },
    },
    check("victimNotMentor", ["MOVES"]),
    check("captainOnly", ["TURN_END"]),
    check("lastMinion", ["DIES"]),
  ] },
  { id: "recoveryByOwner", group: "who", icon: "fa-solid fa-heart-pulse", rules: [check("recoveryByOwner", ["SPENDS_RECOVERY"])] },

  { id: "disposition", group: "other", icon: "fa-solid fa-people-arrows", rules: [
    select("dealerScope", () => SIDES, ["TAKES_DAMAGE", ...TARGETED]),
    select("victimScope", () => SIDES, ["DEALS_DAMAGE", "FORCE_MOVES"]),
    select("throughScope", () => SIDES, ["MOVES"]),
  ] },

  { id: "lineOfEffect", group: "where", icon: "fa-solid fa-eye", rules: [select("lineOfEffect", () => ["subject", "victim"])] },
  { id: "flankedByDealer", group: "where", icon: "fa-solid fa-arrows-left-right-to-line", rules: [check("flankedByDealer", TARGETED)] },
  { id: "highGround", group: "where", icon: "fa-solid fa-mountain", rules: [check("highGround", ["DEALS_DAMAGE"])] },
  { id: "subjectConcealed", group: "where", icon: "fa-solid fa-cloud", rules: [check("subjectConcealed")] },
  { id: "zone", group: "where", icon: "fa-solid fa-draw-polygon", unchecked: true, rules: [text("zone", ["ZONE_ENTER", "ZONE_TURN_START"])] },

  { id: "ability", group: "ability", icon: "fa-solid fa-hand-sparkles", rules: [
    multi("abilityKeywords", null, ["USES_ABILITY", ...DAMAGE, ...TARGETED, "POWER_ROLL", "RESISTS_POTENCY", ...FORCED], { input: "keywords", lockedBy: "abilityKeywordGroups" }),
    check("abilityKeywordsAll", ["USES_ABILITY", ...DAMAGE, ...TARGETED, "POWER_ROLL", "RESISTS_POTENCY", ...FORCED], { lockedBy: "abilityKeywordGroups" }),
    select("abilityType", null, ["USES_ABILITY"], { input: "abilityType" }),
    select("abilityCategory", () => ["heroic", "signature", "non-heroic"], ["USES_ABILITY"]),
    check("signatureOnly", ["POWER_ROLL_RESULT"]),
    number("abilityCostMax", ["USES_ABILITY"]),
    check("abilityCostScales", ["USES_ABILITY"]),
    check("abilityPotency", ["USES_ABILITY"]),
    number("abilityTargetCount", ["USES_ABILITY"]),
    select("abilityTargetSide", () => ["ally", "enemy"], ["USES_ABILITY"]),
    check("targetsOwner", ["USES_ABILITY"]),
    check("excludeSelfTarget", TARGETED),
    check("rolledDamage", TARGETED),
    check("notForceMoved", ["DEALS_DAMAGE"]),
    text("abilityDsid", ["USES_ABILITY", "POWER_ROLL_RESULT"], { input: "ability" }),
  ] },

  { id: "roll", group: "roll", icon: "fa-solid fa-dice-d10", rules: [
    {
      key: "rollHas", kind: "multi", options: () => ["edge", "bane", "surge"], events: ["TAKES_DAMAGE", "DEALS_DAMAGE", "POWER_ROLL"],
      read: (c) => (c.rollHas?.length ? clone(c.rollHas) : c.edgeRequired ? ["edge"] : undefined),
      write: (c, v) => { const list = asList(v); delete c.edgeRequired; if (list.length) c.rollHas = list; else delete c.rollHas; },
    },
    {
      key: "tierFilter", kind: "multi", options: () => [1, 2, 3], events: ["POWER_ROLL_RESULT", ...TARGETED],
      read: (c) => (c.tierFilter?.length ? clone(c.tierFilter) : undefined),
      write: (c, v) => { const list = asList(v).map(Number).filter((n) => n >= 1 && n <= 3); if (list.length) c.tierFilter = list; else delete c.tierFilter; },
    },
    check("selfRoll", ["POWER_ROLL", "MAKES_STRIKE"]),
  ] },

  { id: "damage", group: "damage", icon: "fa-solid fa-droplet", rules: [
    multi("damageTypes", null, [...DAMAGE, "DIES", "DYING"], { input: "damageTypes" }),
    check("fromFalling", ["TAKES_DAMAGE", "WOULD_TAKE_DAMAGE"]),
    check("fromForcedMovement", ["TAKES_DAMAGE", "WOULD_TAKE_DAMAGE"]),
    multi("damageOutcome", () => ["winded", "zero"], ["TAKES_DAMAGE", "DEALS_DAMAGE"]),
    select("wouldLeave", () => ["dying"], ["WOULD_TAKE_DAMAGE"]),
    check("reducedByImmunity", ["TAKES_DAMAGE"]),
  ] },

  { id: "hasEffect", group: "state", icon: "fa-solid fa-wand-magic-sparkles", rules: [
    {
      key: "effects", kind: "effects",
      read: (c) => (c.effects?.length ? clone(c.effects) : undefined),
      write: (c, v) => { const list = asList(v).filter((e) => e?.value); if (list.length) c.effects = list; else delete c.effects; },
    },
    {
      key: "ownerEffect", kind: "ownerEffect",
      read: (c) => (c.ownerEffect?.label ? clone(c.ownerEffect) : undefined),
      write: (c, v) => { if (v?.label) c.ownerEffect = { ...v }; else delete c.ownerEffect; },
    },
    check("tauntedByOwner"),
    check("throughMark", ["MOVES"]),
    select("victimCondition", () => CONDITIONS, ["DEALS_DAMAGE"]),
    select("ownerLacks", () => CONDITIONS),
    select("sourceScope", () => ["ALLY", "ENEMY"], ["CONDITION_GAIN"]),
    check("asSource", ["CONDITION_GAIN"]),
  ] },
  { id: "which", group: "state", icon: "fa-solid fa-list-check", rules: [
    multi("condition", () => CONDITIONS, ["CONDITION_GAIN"], { single: true }),
    text("effectName", ["EFFECT_ENDS"]),
    select("durationFilter", () => ["save-or-eot"], ["CONDITION_GAIN"]),
  ] },
  { id: "grabbing", group: "state", icon: "fa-solid fa-hand-back-fist", rules: [
    number("grabCount", ["CONDITION_GAIN"]),
    check("ownerGrabbing", ["USES_ABILITY"]),
  ] },

  { id: "movement", group: "move", icon: "fa-solid fa-person-walking-arrow-right", rules: [
    multi("fmType", () => ["push", "pull", "slide"], FORCED, { single: true }),
    check("through", ["MOVES"]),
    check("arrives", ["MOVES"]),
    select("victimEndsAdjacent", () => ["self", "ally"], FORCED),
    check("entersSpace", ["MOVES"]),
  ] },

  { id: "acted", group: "time", icon: "fa-solid fa-hourglass-start", rules: [
    check("ownerUnacted"),
    check("anyHeroUnacted"),
    check("firstTurn", ["TURN_START"]),
  ] },
  { id: "value", group: "time", icon: "fa-solid fa-heart-crack", rules: [number("value", ["STAMINA_BELOW"])] },
];

export const QUALIFIER_GROUPS = ["who", "other", "where", "ability", "roll", "damage", "state", "move", "time"];

export const qualifierById = (id) => QUALIFIERS.find((q) => q.id === id);

export const ownedFields = (q) => q.rules.flatMap((r) => [r.key, ...(r.key === "rollHas" ? ["edgeRequired"] : [])]);

export const ruleValue = (rule, clause) => rule.read(clause);

export const hasQualifier = (q, clause) => q.rules.some((r) => r.read(clause) !== undefined);

export const ruleFits = (rule, event) => !rule.events || rule.events.includes(event);

export const qualifierFits = (q, event) => q.rules.some((r) => ruleFits(r, event));

export function readSettings(q, clause) {
  const out = {};
  for (const r of q.rules) {
    const v = r.read(clause);
    if (v !== undefined) out[r.key] = v;
  }
  return out;
}

export function writeSettings(q, clause, settings) {
  const changed = [];
  for (const r of q.rules) {
    if (r.lockedBy && clause[r.lockedBy] !== undefined) continue;
    const before = r.read(clause);
    const after = settings[r.key];
    if (sameValue(before, after)) continue;
    r.write(clause, after);
    changed.push(r.key);
  }
  return changed;
}

export function clearQualifier(q, clause) {
  return writeSettings(q, clause, {});
}

export function formValue(rule, value) {
  if (value === undefined) return rule.kind === "check" ? false : rule.kind === "multi" ? [] : rule.kind === "effects" ? [] : "";
  if (rule.kind === "number") return String(value);
  if (rule.kind === "multi") return asList(value).map(String);
  return clone(value);
}

export function parseFormValue(rule, raw) {
  switch (rule.kind) {
    case "check": return raw ? true : undefined;
    case "number": {
      if (raw === "" || raw == null) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case "text": {
      const s = String(raw ?? "").trim();
      return s || undefined;
    }
    case "select": return raw ? String(raw) : undefined;
    case "multi": {
      const list = asList(raw).map(String).filter(Boolean);
      if (!list.length) return undefined;
      return rule.key === "tierFilter" ? list.map(Number) : list;
    }
    case "ownerEffect": return raw?.label ? { label: String(raw.label).trim(), ...(raw.on ? { on: raw.on } : {}) } : undefined;
    case "effects": {
      const list = asList(raw).filter((e) => e?.value);
      return list.length ? list : undefined;
    }
    default: return raw;
  }
}

export function sameSettings(a, b) {
  return sameValue(a, b);
}
