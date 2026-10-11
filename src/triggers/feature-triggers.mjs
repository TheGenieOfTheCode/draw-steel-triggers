import { featureTriggerLines, abilityTriggerLines, abilityEffectHTML, defersDeath, marksSpace } from "../parser/feature-triggers.mjs";
import { MODULE_ID, getSetting } from "../util.mjs";
import { derivedFor, derivedParse, derivedOnce, derivedActive, isDerived } from "./derived.mjs";
import { isMaliceAbility } from "./registry.mjs";
import { ignoredByRule } from "./ignore-rules.mjs";

export const FEATURE_ACTOR_TYPES = new Set(["hero", "npc", "retainer"]);
export const FEATURE_ITEM_TYPES =new Set(["feature", "subclass", "ancestryTrait", "perk", "title", "complication", "treasure", "kit", "career", "culture"]);
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
    if (Array.isArray(list)) return list.filter((e) => e?.dsid).map((e) => ({ dsid: String(e.dsid).toLowerCase(), name: e.name || e.dsid, line: e.line ? String(e.line) : null }));
  } catch {}
  return raw.split(/[\s,]+/).filter(Boolean).map((dsid) => ({ dsid: dsid.toLowerCase(), name: dsid, line: null }));
}

export const ignoreEntryId = (e) => (e.line ? `${e.dsid}#${e.line}` : e.dsid);

export async function setIgnoredList(list) {
  const seen = new Set();
  const clean = list.filter((e) => e?.dsid && !seen.has(ignoreEntryId(e)) && seen.add(ignoreEntryId(e)))
    .map((e) => (e.line ? { dsid: e.dsid, name: e.name, line: e.line } : { dsid: e.dsid, name: e.name }));
  await game.settings.set(MODULE_ID, "featureIgnore", JSON.stringify(clean));
}

export const ignoreFeature = ({ dsid, name }) => setIgnoredList([...ignoredList(), { dsid: String(dsid).toLowerCase(), name: name || dsid }]);
export const ignoreLine = ({ dsid, line, name }) => setIgnoredList([...ignoredList(), { dsid: String(dsid).toLowerCase(), line, name: name || dsid }]);
export const unignoreFeature = (id) => setIgnoredList(ignoredList().filter((e) => ignoreEntryId(e) !== id));
export const ignoredFeatures = () => new Set(ignoredList().filter((e) => !e.line).map((e) => e.dsid));
export const ignoredLines = () => new Set(ignoredList().filter((e) => e.line).map((e) => e.line));

export const isAbilitySource = (item) => item?.type === "ability" && !TRIGGERED.has(item.system?.type) && !isDerived(item) && !isMaliceAbility(item);
export const isLineSource = (item) => FEATURE_ITEM_TYPES.has(item?.type) || isAbilitySource(item);
const appliesEffects = (item) => !!(item.effects?.some((e) => !e.transfer) || item.system?.power?.effects?.contents?.some((e) => e.type === "applied"));

export const carriesEffect = (actor, origin) => !!origin && !!actor?.effects?.some((e) => e.origin === origin && e.active);


function nearbyActors(owner) {
  const actors = new Set([owner]);
  for (const c of game.combat?.combatants ?? []) if (c.actor) actors.add(c.actor);
  for (const t of canvas?.tokens?.placeables ?? []) if (t.actor) actors.add(t.actor);
  return [...actors].filter(Boolean);
}

export function abilityEffectLive(item) {
  return nearbyActors(item.actor).some((a) => carriesEffect(a, item.uuid));
}

const APPLY_LABEL = /\[\[\/apply\s[^\]]*\]\]\{([^}]+)\}/g;
const CT_KEYS = { judged: "judgement", marked: "mark" };

export function labelSources(owner, label) {
  const want = String(label ?? "").toLowerCase();
  return (owner?.items ?? []).filter((i) => i.type === "ability"
    && [...abilityEffectHTML(i).matchAll(APPLY_LABEL)].some((m) => m[1].trim().toLowerCase() === want));
}

export const labelKnown = (owner, label) => !!CT_KEYS[String(label ?? "").toLowerCase()] || labelSources(owner, label).length > 0;

export function carriesMark(actor, owner, label) {
  if (!actor || !owner || !label) return false;
  const origins = new Set(labelSources(owner, label).map((i) => i.uuid));
  const ctKey = CT_KEYS[String(label).toLowerCase()];
  return !!actor.effects?.some((e) => e.active
    && (origins.has(e.origin) || (!!ctKey && e.getFlag?.("draw-steel-combat-tools", ctKey)?.actorId === owner.id)));
}

export function abilityLineLive(item, line) {
  if (line.watchMark && labelSources(item.actor, line.watchMark).some((i) => i.id === item.id)) return nearbyActors(item.actor).some((a) => carriesMark(a, item.actor, line.watchMark));
  return abilityEffectLive(item);
}

export function itemFeatureLines(item, { withIgnored = false } = {}) {
  if (!item || !isLineSource(item)) return [];
  if (ignoredFeatures().has(String(item.system?._dsid ?? "").toLowerCase()) || ignoredByRule(item)) return [];
  const ability = item.type === "ability";
  const html = ability ? abilityEffectHTML(item) : item.system?.description?.value ?? "";
  const resource = ability ? null : resourceOf(item.actor);
  const ownerName = item.actor && item.actor.type !== "hero" ? item.actor.name : "";
  const applies = ability && appliesEffects(item);
  const ignored = withIgnored ? new Set() : ignoredLines();
  const cached = _lineCache.get(item.uuid);
  if (cached && cached.html === html && cached.resource === resource && cached.name === item.name && cached.ownerName === ownerName && cached.applies === applies) {
    return ignored.size ? cached.lines.filter((l) => !ignored.has(l.key)) : cached.lines;
  }
  const opts = { dsid: item.system?._dsid ?? "", name: item.name, resource, ownerName };
  const found = ability ? abilityTriggerLines(html, { ...opts, appliesEffects: applies }).filter((l) => l.watch !== "self")
    : featureTriggerLines(html, opts);
  const lines = found.filter((l) => l.kind === "trigger")
    .map((l) => ({ ...l, manual: MANUAL.filter(([rx]) => rx.test(l.sentence)).map(([, why]) => why) }));
  _lineCache.set(item.uuid, { html, resource, name: item.name, ownerName, applies, lines });
  return ignored.size ? lines.filter((l) => !ignored.has(l.key)) : lines;
}

export function coveredBy(item) {
  const actor = item?.actor;
  if (!actor) return null;
  const dsid = item.system?._dsid;
  const grants = new Set(Object.values(item.system?.advancements ?? {}).filter((a) => a.type === "itemGrant")
    .flatMap((a) => a.pool ?? []).map((p) => p.uuid).filter(Boolean));
  return actor.items.find((i) => i.type === "ability" && TRIGGERED.has(i.system?.type)
    && ((dsid && i.system?._dsid === dsid) || grants.has(i._stats?.compendiumSource))) ?? null;
}

const _lineNames = [];

export function registerDerivedNames(source) {
  if (!source || !["object", "function"].includes(typeof source)) throw new Error("registerDerivedNames takes a map or a function");
  _lineNames.unshift(source);
  if (game.ready) Hooks.callAll("draw-steel-triggers.derivedNamesChanged");
  return () => {
    const at = _lineNames.indexOf(source);
    if (at < 0) return;
    _lineNames.splice(at, 1);
    if (game.ready) Hooks.callAll("draw-steel-triggers.derivedNamesChanged");
  };
}

function registeredName(item, line, index) {
  const sourceDsid = String(item.system?._dsid ?? "");
  const ctx = { item, line, key: line.key, index: index + 1, sourceDsid };
  for (const s of _lineNames) {
    const name = typeof s === "function" ? s(ctx) : s[line.key] ?? s[`${sourceDsid}#${index + 1}`];
    if (name) return String(name);
  }
  return null;
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
  out.name = saved.name || registeredName(item, line, index) || (count > 1 ? `${item.name} ${index + 1}` : item.name);
  return out;
}

export function itemEffectiveLines(item) {
  const lines = itemFeatureLines(item, { withIgnored: true });
  const ignored = ignoredLines();
  return lines.map((l, i) => effectiveFeatureLine(item, l, i, lines.length)).filter((l) => !ignored.has(l.key));
}

export function lineAutomationLevel(line, levelFromParse) {
  if (!featureTriggersActive() || !line.enabled) return { level: "none", detail: [] };
  if (line.overridden && line.parse?.source === "manual") return { level: "manual", detail: [] };
  if (line.manual.length || line.parse?.confidence !== "high") return { level: "unknown", detail: [] };
  return levelFromParse(line.parse) ?? { level: "none", detail: [] };
}

export function lineCost(actor, line) {
  const cost = line?.cost;
  if (!cost?.amount) return null;
  const own = String(resourceOf(actor) ?? "").toLowerCase();
  return cost.resource === own || cost.resource === "heroic resource" ? cost.amount : null;
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
      resource: lineCost(item.actor, line),
      _dsid: snooze,
      restricted: false,
      keywords: new Set(),
      effects: { contents: [] },
      description: { value: `<p>${line.sentence}</p>` },
    },
    getFlag: (scope, key) => (scope === MODULE_ID && ["malice", "manual", "trigger"].includes(key) ? undefined : item.getFlag(scope, key)),
    feature: item,
    featureLine: { key: line.key, name: line.name, sentence: line.sentence, trigger: line.trigger, effect: line.effect, flavor: line.flavor ?? "", tier: line.tier ?? null, action: line.action, once: line.once ?? null, itemName: item.name, defersDeath: defersDeath(line.effect), marksSpace: marksSpace(line.effect), resourceCost: lineCost(item.actor, line), exclusive: line.exclusive ?? null },
  };
}

const _peaks = new Map();

const _resourceValue = (actor) => Number(actor?.system?.hero?.primary?.value ?? 0) || 0;
const _inCombat = (combat, actor) => !!combat?.started && combat.combatants.some((c) => c.actor === actor);
const _combatOf = (actor) => (_inCombat(game.combat, actor) ? game.combat : game.combats.find((c) => _inCombat(c, actor)) ?? null);
const _turnStamp = (combat) => (combat?.started ? `${combat.id}|${combat.round}|${combat.turn}` : null);

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

export function featureTriggerEntries(actor) {
  if (!actor || !FEATURE_ACTOR_TYPES.has(actor.type) || !featureTriggersActive()) return [];
  const entries = [];
  const seen = new Set();
  for (const item of actor.items) {
    if (!isLineSource(item)) continue;
    for (const line of _bestTiers(actor, itemEffectiveLines(item))) {
      if (seen.has(line.key)) continue;
      seen.add(line.key);
      if (line.watch === "parked") continue;
      if (line.watch && !abilityLineLive(item, line)) continue;
      const watch = line.watch ? { watch: line.watch, originUuid: item.uuid, watchMark: line.watchMark ?? null } : {};
      const derived = derivedActive() ? derivedFor(actor, item.id, line.key) : null;
      if (derived) {
        const once = derivedOnce(derived);
        const parse = derivedParse(derived);
        if (!parse?.clauses?.some((c) => c.event && c.event !== "UNKNOWN") || featureLineSpent(actor, line.key, once)) continue;
        const action = ["triggered", "freeTriggered"].includes(derived.system.type) ? derived.system.type : null;
        derived.featureLine = { ...lineProxy(item, line).featureLine, name: derived.name, trigger: derived.system.trigger, action, once, derived: true };
        entries.push({ item: derived, free: action === "freeTriggered", noAction: !action, parse, featureLine: true, ...watch });
        continue;
      }
      if (!line.enabled || !line.parse?.clauses?.some((c) => c.event && c.event !== "UNKNOWN")) continue;
      if (featureLineSpent(actor, line.key, line.once)) continue;
      entries.push({
        item: lineProxy(item, line),
        free: line.action === "freeTriggered",
        noAction: !line.action,
        parse: line.parse,
        featureLine: true,
        ...watch,
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
