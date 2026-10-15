import { parseTrigger, generateDSID, SPECIAL_CASES } from "../parser/trigger-parser.mjs";
import { MODULE_ID } from "../util.mjs";
import { featureTriggerEntries } from "./feature-triggers.mjs";
import { isDerived, derivedParse } from "./derived.mjs";
import { ignoredByRule } from "./ignore-rules.mjs";

const TRIGGERED_TYPES = new Set(["triggered", "freeTriggered"]);

const _parseCache = new Map();

export function isTriggeredAbility(item) {
  return item?.type === "ability" && TRIGGERED_TYPES.has(item.system?.type);
}

const MALICE_ICON = "icons/magic/unholy/silhouette-robe-evil-power.webp";

export function isMaliceAbility(item) {
  if (isDerived(item)) return false;
  const flag = item?.getFlag(MODULE_ID, "malice");
  if (flag !== undefined) return !!flag;
  if (item?.system?.category === "maliceAncestry") return true;
  return item?.type === "ability" && item.img === MALICE_ICON;
}

export function isImplicitMaliceTrigger(item) {
  return item?.type === "ability"
    && !TRIGGERED_TYPES.has(item.system?.type)
    && !/malice features$/i.test(item.name ?? "")
    && isMaliceAbility(item);
}

function implicitMaliceParse() {
  return {
    clauses: [{ event: "TURN_START", scope: "SELF", qualifiers: [] }],
    confidence: "high",
    source: "malice-implicit",
  };
}

export function getParsedTrigger(item, { ignoreManual = false } = {}) {
  if (isDerived(item)) return derivedParse(item, { ignoreManual });
  if (!isTriggeredAbility(item)) {
    if (isImplicitMaliceTrigger(item)) return implicitMaliceParse();
    return null;
  }

  if (!ignoreManual && item.getFlag(MODULE_ID, "manual")) {
    const stored = item.getFlag(MODULE_ID, "trigger");
    if (stored?.clauses?.length) return { clauses: stored.clauses, confidence: "high", source: "manual" };
  }

  const text = item.system.trigger ?? "";
  const ownerName = item.actor?.name ?? "";
  const effectText = _effectText(item);
  const targetType = item.system.target?.type ?? "";
  const cached = _parseCache.get(item.uuid);
  if (cached && cached.text === text && cached.ownerName === ownerName && cached.effectText === effectText && cached.targetType === targetType) return cached.result;

  const side = !item.actor ? undefined : item.actor.type === "hero" ? "hero" : "monster";
  const result = parseTrigger(text, { dsid: item.dsid, ownerName, effectText, targetType, side });
  _parseCache.set(item.uuid, { text, ownerName, effectText, targetType, result });
  return result;
}

export function triggerEffectText(item) {
  return _effectText(item);
}

function _effectText(item) {
  const sys = item.system;
  const parts = [];
  for (const eff of sys.effects?.contents ?? []) {
    if (eff?.description) parts.push(eff.description);
  }
  for (const powerEffect of sys.power?.effects?.contents ?? []) {
    try {
      parts.push(JSON.stringify(powerEffect.toObject()));
    } catch {}
  }
  return parts.join(" ").replace(/<[^>]+>/g, " ");
}

export function getTriggeredAbilities(actor) {
  if (!actor) return [];
  const entries = [];
  for (const item of actor.items) {
    if (isDerived(item)) continue;
    const triggered = isTriggeredAbility(item);
    if (!triggered && !isImplicitMaliceTrigger(item)) continue;
    if (ignoredByRule(item)) continue;
    entries.push({ item, free: triggered && item.system.type === "freeTriggered", parse: getParsedTrigger(item) });
  }
  entries.push(...featureTriggerEntries(actor));
  return entries;
}

export function clearParseCache(uuid) {
  if (uuid) _parseCache.delete(uuid);
  else _parseCache.clear();
}

export function registerSpecialCase(dsid, data) {
  if (!dsid || !data?.clauses?.length) throw new Error("registerSpecialCase requires a dsid and at least one clause");
  SPECIAL_CASES[dsid] = data;
  clearParseCache();
}

export function scanWorld() {
  const entries = [];
  const summary = { actors: 0, abilities: 0, confidence: { high: 0, low: 0 }, source: {}, events: {} };
  for (const actor of game.actors) {
    const abilities = getTriggeredAbilities(actor);
    if (!abilities.length) continue;
    summary.actors++;
    for (const entry of abilities) {
      summary.abilities++;
      const parse = entry.parse;
      summary.confidence[parse.confidence] = (summary.confidence[parse.confidence] ?? 0) + 1;
      summary.source[parse.source] = (summary.source[parse.source] ?? 0) + 1;
      for (const clause of parse.clauses) summary.events[clause.event] = (summary.events[clause.event] ?? 0) + 1;
      entries.push({
        actor: actor.name,
        ability: entry.item.name,
        free: entry.free,
        trigger: entry.item.system.trigger,
        event: parse.clauses.map(c => c.event).join(" / "),
        scope: parse.clauses.map(c => c.scope).join(" / "),
        confidence: parse.confidence,
        source: parse.source,
        item: entry.item,
      });
    }
  }
  console.log("DS Triggers | world scan:", summary);
  console.table(entries.map(({ item, ...rest }) => rest));
  return entries;
}

Hooks.on("deleteItem", (item) => _parseCache.delete(item.uuid));
