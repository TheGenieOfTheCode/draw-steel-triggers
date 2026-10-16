import { featureTriggerLines, abilityTriggerLines, abilityEffectHTML, abilitySpendHTML, defersDeath, marksSpace } from "../parser/feature-triggers.mjs";
import { MODULE_ID, getSetting } from "../util.mjs";
import { derivedFor, derivedParse, derivedOnce, derivedActive, isDerived } from "./derived.mjs";
import { isMaliceAbility } from "./registry.mjs";
import { ignoredByRule } from "./ignore-rules.mjs";
import { countdownLeft } from "./countdowns.mjs";
import { useLive, useTargets } from "./ability-uses.mjs";

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

let _ignoredMemo = { raw: null, list: [] };
export function ignoredList() {
  const raw = String(getSetting("featureIgnore") ?? "");
  if (_ignoredMemo.raw === raw) return _ignoredMemo.list.map((e) => ({ ...e }));
  const list = _parseIgnored(raw);
  _ignoredMemo = { raw, list };
  return list.map((e) => ({ ...e }));
}

function _parseIgnored(raw) {
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

export const isAbilitySource = (item) => item?.type === "ability" && !TRIGGERED.has(item.system?.type) && !isDerived(item);
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

const _labelsByHtml = new Map();
const appliedLabels = (ability) => {
  const html = abilityEffectHTML(ability);
  let labels = _labelsByHtml.get(html);
  if (!labels) {
    labels = new Set([...html.matchAll(APPLY_LABEL)].map((m) => m[1].trim().toLowerCase()));
    if (_labelsByHtml.size > 2000) _labelsByHtml.clear();
    _labelsByHtml.set(html, labels);
  }
  return labels;
};

export function labelSources(owner, label) {
  const want = String(label ?? "").toLowerCase();
  return (owner?.items ?? []).filter((i) => i.type === "ability" && appliedLabels(i).has(want));
}

export const labelKnown = (owner, label) => !!CT_KEYS[String(label ?? "").toLowerCase()] || labelSources(owner, label).length > 0;

export function carriesMark(actor, owner, label) {
  if (!actor || !owner || !label) return false;
  const origins = new Set(labelSources(owner, label).map((i) => i.uuid));
  const ctKey = CT_KEYS[String(label).toLowerCase()];
  return !!actor.effects?.some((e) => e.active
    && (origins.has(e.origin) || (!!ctKey && e.flags?.["draw-steel-combat-tools"]?.[ctKey]?.actorId === owner.id)));
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
  const malice = ability && isMaliceAbility(item);
  const ignored = withIgnored ? new Set() : ignoredLines();
  const benefits = ability ? [] : grantedBenefits(item);
  const benefitKey = benefits.join("|");
  const cached = _lineCache.get(item.uuid);
  if (cached && cached.html === html && cached.resource === resource && cached.name === item.name && cached.ownerName === ownerName
    && cached.applies === applies && cached.benefitKey === benefitKey) {
    return ignored.size ? cached.lines.filter((l) => !ignored.has(l.key)) : cached.lines;
  }
  const opts = { dsid: item.system?._dsid ?? "", name: item.name, resource, ownerName, benefits };
  const found = ability ? abilityTriggerLines(html, { ...opts, appliesEffects: applies, distance: item.system?.distance, spendHtml: abilitySpendHTML(item) })
    .filter((l) => l.watch !== "self" && (!malice || l.watch === "used"))
    : featureTriggerLines(html, opts);
  const lines = found.filter((l) => l.kind === "trigger")
    .map((l) => ({ ...l, manual: MANUAL.filter(([rx]) => rx.test(l.sentence)).map(([, why]) => why) }));
  _lineCache.set(item.uuid, { html, resource, name: item.name, ownerName, applies, benefitKey, lines });
  return ignored.size ? lines.filter((l) => !ignored.has(l.key)) : lines;
}

const _benefitsByPool = new Map();
function grantedBenefits(item) {
  const advancements = item.system?.advancements;
  const pool = [...(advancements?.contents ?? Object.values(advancements ?? {}))].filter((a) => a.type === "itemGrant").flatMap((a) => a.pool ?? []);
  const key = pool.map((p) => p?.uuid ?? "").join("|");
  if (_benefitsByPool.has(key)) return _benefitsByPool.get(key);
  const docs = pool.map((p) => (p?.uuid ? fromUuidSync(p.uuid, { strict: false }) : null));
  const names = docs.filter((d) => d?.name && d.type !== "ability").map((d) => d.name);
  if (docs.every(Boolean)) {
    if (_benefitsByPool.size > 2000) _benefitsByPool.clear();
    _benefitsByPool.set(key, names);
  }
  return names;
}

export function coveredBy(item) {
  const actor = item?.actor;
  if (!actor) return null;
  const dsid = item.system?._dsid;
  const advancements = item.system?.advancements;
  const grants = new Set([...(advancements?.contents ?? Object.values(advancements ?? {}))].filter((a) => a.type === "itemGrant")
    .flatMap((a) => a.pool ?? []).flatMap((p) => [p.uuid, CONFIG.compendium.uuidRedirects?.[p.uuid]]).filter(Boolean));
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
  if (saved.neverAutoUse !== undefined) out.neverAutoUse = !!saved.neverAutoUse;
  if (saved.countdown !== undefined) out.countdown = saved.countdown?.start ? saved.countdown : null;
  if (saved.tier !== undefined) {
    const t = saved.tier;
    out.tier = t && (t.level || t.min) ? { level: Number(t.level) || null, min: Number(t.min) || 0,
      resource: t.min ? (line.tier?.resource ?? String(resourceOf(item.actor) ?? "").toLowerCase()) : null } : null;
    if (out.tier && !out.family) out.family = line.key;
  }
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

const epicOf = (actor) => actor?.items?.find((i) => i.type === "class")?.system?.epic ?? null;

export function linePool(actor, line) {
  const cost = line?.cost;
  if (!cost?.amount) return null;
  const own = String(resourceOf(actor) ?? "").toLowerCase();
  if (cost.resource === own || cost.resource === "heroic resource") return "system.hero.primary.value";
  const epic = String(epicOf(actor) ?? "").toLowerCase();
  return epic && cost.resource === epic ? "system.hero.epic.value" : null;
}

export function lineCost(actor, line) {
  return linePool(actor, line) ? line.cost.amount : null;
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
      resourcePath: linePool(item.actor, line),
      _dsid: snooze,
      restricted: false,
      keywords: new Set(),
      effects: { contents: [] },
      description: { value: `<p>${line.sentence}</p>` },
    },
    getFlag: (scope, key) => (scope === MODULE_ID && ["malice", "manual", "trigger"].includes(key) ? undefined : item.getFlag(scope, key)),
    feature: item,
    featureLine: { key: line.key, name: line.name, sourceDistance: item.system?.distance ?? null, sentence: line.sentence, trigger: line.trigger, effect: line.effect, flavor: line.flavor ?? "", tier: line.tier ?? null, action: line.action, once: line.once ?? null, itemName: item.name, defersDeath: defersDeath(line.effect), marksSpace: marksSpace(line.effect), resourceCost: lineCost(item.actor, line), resourcePath: linePool(item.actor, line), exclusive: line.exclusive ?? null,
      neverAutoUse: !!line.neverAutoUse, director: !!line.director, maliceCost: Number(line.maliceCost) || 0, countdown: line.countdown ?? null },
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
  if (!tier.resource) return game.i18n.format("DS_TRIGGERS.Feature.LevelOnly", { level: tier.level });
  return game.i18n.format(`DS_TRIGGERS.Feature.${tier.level ? "TierLevel" : "Tier"}`, { n: tier.min, resource, level: tier.level });
}

export function tierQualifies(actor, tier) {
  if (!tier) return true;
  if (tier.level && (Number(actor.system?.level) || 0) < tier.level) return false;
  if (tier.resource !== String(resourceOf(actor) ?? "").toLowerCase()) return true;
  return turnPeakResource(actor) >= tier.min;
}

export const levelMet = (actor, line) => !line.tier?.level || (Number(actor?.system?.level) || 0) >= line.tier.level;

function _bestTiers(actor, lines) {
  const best = new Map();
  for (const line of lines) {
    if (!line.tier?.resource || !tierQualifies(actor, line.tier)) continue;
    const held = best.get(line.family);
    if (!held || held.tier.min < line.tier.min) best.set(line.family, line);
  }
  return lines.filter((l) => (l.tier?.resource ? best.get(l.family) === l : levelMet(actor, l)));
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
    if (item.type === "treasure" && item.system?.category === "consumable" && Number(item.system?.quantity ?? 1) <= 0) continue;
    for (const line of _bestTiers(actor, itemEffectiveLines(item))) {
      if (seen.has(line.key)) continue;
      seen.add(line.key);
      if (line.watch === "parked") continue;
      if (line.watch === "used" ? !useLive(item) : line.watch && !abilityLineLive(item, line)) continue;
      if (line.countdown && countdownLeft(actor, line.key) > 0) continue;
      const watch = line.watch ? { watch: line.watch, originUuid: item.uuid, watchMark: line.watchMark ?? null, spendUsed: !!line.spendUsed,
        ...(line.watch === "used" ? { useTargets: line.used?.target ? useTargets(item) : null, aura: line.used?.aura ?? null, maliceLine: isMaliceAbility(item) } : {}) } : {};
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
