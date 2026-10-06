import { featureTriggerLines } from "../parser/feature-triggers.mjs";
import { MODULE_ID, getSetting } from "../util.mjs";

export const FEATURE_ITEM_TYPES = new Set(["feature", "subclass", "ancestryTrait", "perk", "title", "complication", "treasure", "kit", "career", "culture"]);
const LINES_FLAG = "featureLines";
const TRIGGERED = new Set(["triggered", "freeTriggered"]);

const MANUAL = [
  [/summoner['’]s range/i, "SummonerRange"],
  [/\bunwillingly\b/i, "Unwilling"],
  [/\bcompanion\b/i, "Companion"],
];

const _lineCache = new Map();
const _uses = new Map();

export const featureTriggersActive = () => getSetting("featureTriggers") !== false;
export const featureSnoozeId = (key) => `feature:${key}`;

const resourceOf = (actor) => actor?.items?.find((i) => i.type === "class")?.system?.primary ?? null;

export function ignoredList() {
  const raw = String(getSetting("featureIgnore") ?? "");
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list)) return list.filter((e) => e?.dsid).map((e) => ({ dsid: String(e.dsid).toLowerCase(), name: e.name || e.dsid }));
  } catch {}
  return raw.split(/[\s,]+/).filter(Boolean).map((dsid) => ({ dsid: dsid.toLowerCase(), name: dsid }));
}

export async function setIgnoredList(list) {
  const seen = new Set();
  const clean = list.filter((e) => e?.dsid && !seen.has(e.dsid) && seen.add(e.dsid));
  await game.settings.set(MODULE_ID, "featureIgnore", JSON.stringify(clean));
}

export const ignoreFeature = ({ dsid, name }) => setIgnoredList([...ignoredList(), { dsid: String(dsid).toLowerCase(), name: name || dsid }]);
export const unignoreFeature = (dsid) => setIgnoredList(ignoredList().filter((e) => e.dsid !== dsid));
export const ignoredFeatures = () => new Set(ignoredList().map((e) => e.dsid));

export function itemFeatureLines(item) {
  if (!item || !FEATURE_ITEM_TYPES.has(item.type)) return [];
  if (ignoredFeatures().has(String(item.system?._dsid ?? "").toLowerCase())) return [];
  const html = item.system?.description?.value ?? "";
  const resource = resourceOf(item.actor);
  const cached = _lineCache.get(item.uuid);
  if (cached && cached.html === html && cached.resource === resource && cached.name === item.name) return cached.lines;
  const lines = featureTriggerLines(html, { dsid: item.system?._dsid ?? "", name: item.name, resource })
    .filter((l) => l.kind === "trigger")
    .map((l) => ({ ...l, manual: MANUAL.filter(([rx]) => rx.test(l.sentence)).map(([, why]) => why) }));
  _lineCache.set(item.uuid, { html, resource, name: item.name, lines });
  return lines;
}

/* A feature whose trigger already ships as its own triggered ability (Resist the Unnatural in 1.2) would fire twice. */
export function coveredBy(item) {
  const actor = item?.actor;
  if (!actor) return null;
  const dsid = item.system?._dsid;
  const grants = new Set(Object.values(item.system?.advancements ?? {}).filter((a) => a.type === "itemGrant")
    .flatMap((a) => a.pool ?? []).map((p) => p.uuid).filter(Boolean));
  return actor.items.find((i) => i.type === "ability" && TRIGGERED.has(i.system?.type)
    && ((dsid && i.system?._dsid === dsid) || grants.has(i._stats?.compendiumSource))) ?? null;
}

export function effectiveFeatureLine(item, line, index = 0, count = 1) {
  const saved = item.getFlag(MODULE_ID, LINES_FLAG)?.[line.key] ?? {};
  const covered = coveredBy(item);
  const out = { ...line, covered: covered?.name ?? null, overridden: !!item.getFlag(MODULE_ID, LINES_FLAG)?.[line.key] };
  out.enabled = saved.enabled ?? !covered;
  if (Array.isArray(saved.clauses) && saved.clauses.length) out.parse = { ...line.parse, clauses: saved.clauses, confidence: "high", source: "manual" };
  else if (line.manual.length) out.parse = { ...line.parse, confidence: "low" };
  if (saved.once !== undefined) out.once = saved.once;
  if (saved.action !== undefined) out.action = saved.action;
  out.name = saved.name || (count > 1 ? `${item.name} ${index + 1}` : item.name);
  return out;
}

export function itemEffectiveLines(item) {
  const lines = itemFeatureLines(item);
  return lines.map((l, i) => effectiveFeatureLine(item, l, i, lines.length));
}

export function lineAutomationLevel(line, levelFromParse) {
  if (!featureTriggersActive() || !line.enabled) return { level: "none", detail: [] };
  if (line.overridden && line.parse?.source === "manual") return { level: "manual", detail: [] };
  if (line.manual.length || line.parse?.confidence !== "high") return { level: "unknown", detail: [] };
  return levelFromParse(line.parse) ?? { level: "none", detail: [] };
}

function lineProxy(item, line) {
  const snooze = featureSnoozeId(line.key);
  return {
    documentName: "Item",
    type: "featureLine",
    uuid: item.uuid,
    id: item.id,
    name: line.name,
    img: item.img,
    actor: item.actor,
    parent: item.parent,
    dsid: snooze,
    system: {
      type: line.action ?? "none",
      trigger: line.trigger,
      resource: null,
      _dsid: snooze,
      restricted: false,
      keywords: new Set(),
      effects: { contents: [] },
      description: { value: `<p>${line.sentence}</p>` },
    },
    getFlag: (scope, key) => (scope === MODULE_ID && ["malice", "manual", "trigger"].includes(key) ? undefined : item.getFlag(scope, key)),
    feature: item,
    featureLine: { key: line.key, name: line.name, sentence: line.sentence, trigger: line.trigger, effect: line.effect, action: line.action, once: line.once ?? null, itemName: item.name },
  };
}

const _peaks = new Map();

const _resourceValue = (actor) => Number(actor?.system?.hero?.primary?.value ?? 0) || 0;
const _inCombat = (combat, actor) => !!combat?.started && combat.combatants.some((c) => c.actor === actor);
const _combatOf = (actor) => (_inCombat(game.combat, actor) ? game.combat : game.combats.find((c) => _inCombat(c, actor)) ?? null);
const _turnStamp = (combat) => (combat?.started ? `${combat.id}|${combat.round}|${combat.turn}` : null);

/* Growing Ferocity and the Null masteries count the most resource the hero held at any point this turn, so spending
   it mid turn keeps the benefit. */
export function turnPeakResource(actor) {
  const now = _resourceValue(actor);
  const stamp = _turnStamp(_combatOf(actor));
  if (!stamp) return now;
  const peak = _peaks.get(actor.uuid);
  if (!peak || peak.stamp !== stamp) {
    _peaks.set(actor.uuid, { stamp, value: now });
    return now;
  }
  peak.value = Math.max(peak.value, now);
  return peak.value;
}

export function tierText(tier) {
  if (!tier) return "";
  const resource = tier.resource ? tier.resource[0].toUpperCase() + tier.resource.slice(1) : "";
  return game.i18n.format(`DS_TRIGGERS.Feature.${tier.level ? "TierLevel" : "Tier"}`, { n: tier.min, resource, level: tier.level });
}

export function tierQualifies(actor, tier) {
  if (!tier) return true;
  if (tier.level && (Number(actor.system?.level) || 0) < tier.level) return false;
  if (tier.resource !== String(resourceOf(actor) ?? "").toLowerCase()) return true;
  return turnPeakResource(actor) >= tier.min;
}

/* Rows of one table that share a trigger replace each other: the highest row the hero qualifies for wins. */
function _bestTiers(actor, lines) {
  const best = new Map();
  for (const line of lines) {
    if (!line.tier || !tierQualifies(actor, line.tier)) continue;
    const held = best.get(line.family);
    if (!held || held.tier.min < line.tier.min) best.set(line.family, line);
  }
  return lines.filter((l) => !l.tier || best.get(l.family) === l);
}

Hooks.on("updateActor", (actor, changes) => {
  if (actor.type !== "hero" || !foundry.utils.hasProperty(changes, "system.hero.primary.value")) return;
  if (_combatOf(actor)) turnPeakResource(actor);
});

Hooks.on("updateCombat", (combat, changes) => {
  if (!("turn" in changes || "round" in changes)) return;
  for (const c of combat.combatants) if (c.actor?.type === "hero") turnPeakResource(c.actor);
});

const _useKey = (actor, key) => `${actor?.uuid}|${key}`;

function _stamp(combat = game.combat) {
  return { combat: combat?.id ?? null, round: combat?.round ?? 0, turn: combat?.turn ?? 0 };
}

export function noteFeatureLineUse(actor, key) {
  _uses.set(_useKey(actor, key), _stamp());
}

export function featureLineSpent(actor, key, once) {
  if (!once) return false;
  const used = _uses.get(_useKey(actor, key));
  const now = _stamp();
  if (!used || used.combat !== now.combat) return false;
  if (once === "encounter") return true;
  if (once === "round") return used.round === now.round;
  if (once === "turn") return used.round === now.round && used.turn === now.turn;
  return false;
}

/**
 * Feature lines on an actor as pipeline entries, shaped like getTriggeredAbilities' { item, free, parse } with
 * `noAction` set for lines that spend nothing ("whenever ..."): those never consult the triggered action.
 */
export function featureTriggerEntries(actor) {
  if (!actor || actor.type !== "hero" || !featureTriggersActive()) return [];
  const entries = [];
  const seen = new Set();
  for (const item of actor.items) {
    if (!FEATURE_ITEM_TYPES.has(item.type)) continue;
    for (const line of _bestTiers(actor, itemEffectiveLines(item))) {
      if (seen.has(line.key)) continue;
      seen.add(line.key);
      if (!line.enabled || !line.parse?.clauses?.some((c) => c.event && c.event !== "UNKNOWN")) continue;
      if (featureLineSpent(actor, line.key, line.once)) continue;
      entries.push({
        item: lineProxy(item, line),
        free: line.action === "freeTriggered",
        noAction: !line.action,
        parse: line.parse,
        featureLine: true,
      });
    }
  }
  return entries;
}

export function clearFeatureLineCache(uuid) {
  if (uuid) _lineCache.delete(uuid);
  else _lineCache.clear();
}

Hooks.on("deleteItem", (item) => _lineCache.delete(item.uuid));
Hooks.on("deleteCombat", (combat) => {
  for (const [k, v] of _uses) if (v.combat === combat.id) _uses.delete(k);
});
