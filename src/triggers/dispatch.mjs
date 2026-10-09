import { MODULE_ID, getSetting, dbg, isPrimaryGM } from "../util.mjs";
import { getTriggeredAbilities, isMaliceAbility } from "./registry.mjs";
import { isTriggeredActionSpent } from "./spent-tracking.mjs";
import { enqueuePromptEntries } from "./queue.mjs";
import { abilityRowsHTML, cardContent, postSystemCard, withFaces } from "../ui/system-card.mjs";
import { malicePill, sendMaliceCard } from "./malice.mjs";
import { isActorSnoozed, isSnoozedForAudience } from "../ui/snooze.mjs";
import { noteGainEvent } from "./resource-gains.mjs";
import { lingeringEffect } from "./lingering.mjs";
import { carriesEffect, carriesMark, labelKnown } from "./feature-triggers.mjs";

const DAMAGE_PROMPTS = new Set(["TAKES_DAMAGE", "DIES", "WINDED_OR_DYING", "DEALS_DAMAGE", "STAMINA_BELOW"]);
const CONDITION_PROMPTS = new Set(["CONDITION_GAIN", "EFFECT_ENDS", "GRAB_ENDS"]);
const PROMPT_EVENTS = new Set([...DAMAGE_PROMPTS, ...CONDITION_PROMPTS, "USES_ABILITY"]);
const SAVE_OR_EOT = new Set(["save", "turnEnd"]);

const BASE_SCOPES = new Set(["SELF", "ALLY", "ENEMY", "ANY", "GROUP", "SELF_OR_ALLY"]);

export function scopeMatches(clause, ownerActor, ownerDisposition, subjectActor, subjectDisposition) {
  if (!subjectActor) return true;
  if (!BASE_SCOPES.has(clause.scope)) return false;
  const isSelf = ownerActor === subjectActor;
  if (clause.notSelf && isSelf) return false;
  if (clause.heroOnly && subjectActor.type !== "hero") return false;
  const sameSide = ownerDisposition != null && subjectDisposition != null
    ? ownerDisposition === subjectDisposition
    : ownerActor.hasPlayerOwner === subjectActor.hasPlayerOwner;
  switch (clause.scope) {
    case "SELF": return isSelf;
    case "ALLY": return !isSelf && sameSide;
    case "SELF_OR_ALLY": return isSelf || sameSide;
    case "ENEMY": return !isSelf && !sameSide;
    case "ANY": return true;
    case "GROUP": {
      if (!clause.groupName) return false;
      const kw = clause.groupName;
      
      if (subjectActor.system?.monster?.keywords?.has?.(kw)) return true;
      const name = subjectActor.name.toLowerCase();
      if (name.includes(kw.toLowerCase())) return true;
      const kwLabel = ds.CONFIG.monsters?.keywords?.[kw]?.label;
      return !!kwLabel && name.includes(game.i18n.localize(kwLabel).toLowerCase());
    }
    default: return false;
  }
}

export const activeCombat = () => {
  const active = game.scenes.active;
  return game.combats.find((c) => c.started && (!c.scene || c.scene.id === active?.id)) ?? null;
};

export const triggersLive = () => !!activeCombat() || getSetting("combatOnly") === false;

function candidateEntries() {
  const seen = new Set();
  const entries = [];
  
  const addActor = (actor, disposition, token) => {
    if (!actor || seen.has(actor.uuid)) return;
    seen.add(actor.uuid);
    entries.push({ actor, disposition, token });
  };
  if (!triggersLive()) return entries;
  const combat = activeCombat();
  for (const combatant of combat?.combatants ?? []) {
    addActor(combatant.actor, combatant.token?.disposition ?? null, combatant.token ?? null);
  }
  if (!combat || getSetting("allSceneTokens")) {
    for (const token of canvas.tokens?.placeables ?? []) {
      addActor(token.actor, token.document.disposition, token.document);
    }
  }
  return entries;
}

const RANGED_DISTANCE_TYPES = new Set(["melee", "ranged", "meleeRanged", "aura", "burst"]);

function clauseRangeSquares(clause, item) {
  if (clause.range === "none") return null;
  if (Number.isFinite(clause.range)) return clause.range > 0 ? clause.range : null;
  return abilityRangeSquares(item);
}

export function abilityRangeSquares(item) {
  const dist = item?.system?.distance;
  if (!dist || !RANGED_DISTANCE_TYPES.has(dist.type)) return null;
  const primary = parseInt(dist.primary) || 0;
  const secondary = parseInt(dist.secondary) || 0;
  const range = dist.type === "meleeRanged" ? Math.max(primary, secondary) : primary;
  return range > 0 ? range : null;
}

export function footprintGap(docA, docB) {
  return game.modules.get("draw-steel-ctlib").api.footprintDistFromBounds(
    docA.x, docA.y, docA.width, docA.height,
    docB.x, docB.y, docB.width, docB.height,
  );
}

function rangeMatches(clause, item, ownerActor, ownerToken, subjectActor, subjectToken) {
  if (!subjectActor || ownerActor === subjectActor) return true;
  if (!ownerToken || !subjectToken) return true;
  if (ownerToken.parent !== canvas.scene || subjectToken.parent !== canvas.scene) return true;
  const range = clauseRangeSquares(clause, item);
  if (range == null) return true;
  if (footprintGap(ownerToken, subjectToken) >= range * canvas.grid.distance) return false;
  return !getSetting("requireLineOfEffect") || hasLineOfEffect(ownerToken, subjectToken);
}

const tokenDoc = (t) => {
  if (!t) return null;
  if (typeof t === "string") return fromUuidSync(t);
  if (t.document) return t.document;
  return t.documentName === "Token" ? t : t.uuid ? fromUuidSync(t.uuid) : null;
};

function lineOfEffectMatches(clause, ownerActor, ownerToken, subjectActor, subjectToken, ctx = {}) {
  if (!clause.lineOfEffect || !ownerToken || ownerToken.parent !== canvas.scene) return true;
  const others = clause.lineOfEffect === "victim"
    ? (ctx.victimToken ? [ctx.victimToken] : ctx.usedTargets ?? []).map(tokenDoc)
    : [subjectActor === ownerActor ? null : tokenDoc(subjectToken)];
  if (others.some((t) => t?.actor === ownerActor)) return true;
  const reachable = others.filter((t) => t && t.parent === canvas.scene);
  if (!reachable.length) return true;
  return reachable.some((t) => hasLineOfEffect(ownerToken, t));
}

function hasLineOfEffect(ownerToken, subjectToken) {
  const from = ownerToken.object, to = subjectToken.object;
  const check = game.modules.get("draw-steel-ctlib")?.api?.hasSightToToken;
  if (!from || !to || !check) return true;
  return !!check(from, to);
}

function inSameCombatGroup(actorA, actorB) {
  const combat = game.combat;
  if (!combat) return false;
  const groupA = combat.combatants.find(c => c.actor === actorA)?.group;
  if (!groupA) return false;
  return combat.combatants.find(c => c.actor === actorB)?.group === groupA;
}

export function activationsLeft(combatant) {
  return Number(combatant?.group ? combatant.group.initiative : combatant?.initiative) || 0;
}

function isSquadCaptain(actor) {
  const combatant = game.combat?.combatants.find((c) => c.actor === actor);
  const group = combatant?.group;
  return !!group && group.system?.captainId === combatant.id;
}

const _roundUses = new Map();
const _roundUseKey = (actor, item) => `${actor?.uuid}|${item?.system?._dsid ?? item?.dsid ?? item?.name ?? ""}`;

export function noteOncePerRoundUse(actor, item, round = game.combat?.round ?? 0) {
  _roundUses.set(_roundUseKey(actor, item), round);
}

export function usedThisRound(actor, item, round = game.combat?.round ?? 0) {
  return _roundUses.get(_roundUseKey(actor, item)) === round;
}

function resourceOf(actor) {
  const coreRes = actor.system.coreResource;
  if (!coreRes) return null;
  return foundry.utils.getProperty(coreRes.target, coreRes.path) ?? 0;
}

function canAffordCost(actor, item) {
  const cost = item.system.resource;
  if (!Number.isFinite(cost) || cost <= 0) return true;
  const current = resourceOf(actor);
  return current == null || current >= cost;
}

const opposed = (docA, docB) => {
  if (!docA || !docB) return null;
  if (docA.disposition != null && docB.disposition != null) return docA.disposition !== docB.disposition;
  return (docA.actor?.hasPlayerOwner ?? false) !== (docB.actor?.hasPlayerOwner ?? false);
};

function keywordsMatch(clause, ability) {
  if (!clause.abilityKeywords?.length) return true;
  const kw = ability?.system?.keywords;
  const has = (k) => kw?.has?.(k) ?? kw?.includes?.(k) ?? false;
  if (clause.abilityKeywordGroups?.length) return clause.abilityKeywordGroups.every((g) => g.some(has));
  return clause.abilityKeywordsAll ? clause.abilityKeywords.every(has) : clause.abilityKeywords.some(has);
}

const damageKeywordsMatch = (clause, ctx) => keywordsMatch(clause, ctx.ability);

export function usedAbilityMatches(clause, used, owner, context = {}) {
  if (!used) return !clause.abilityDsid && !clause.abilityType && !clause.abilityKeywords?.length
    && clause.abilityCostMax == null && clause.abilityCategory == null && clause.abilityTargetCount == null && !clause.abilityPotency;

  const sys = used.system ?? {};
  if (clause.abilityDsid && (sys._dsid ?? used.dsid) !== clause.abilityDsid) return false;
  if (clause.abilityType === "triggered") {
    if (sys.type !== "triggered" && sys.type !== "freeTriggered") return false;
  } else if (clause.abilityType && sys.type !== clause.abilityType) return false;
  if (!keywordsMatch(clause, used)) return false;
  if (clause.targetsOwner) {
    const targets = context.usedTargets ?? [];
    if (targets.length && !targets.some((t) => (t?.actor ?? t) === owner)) return false;
  }

  if (clause.abilityCategory === "signature") {
    if (sys.category !== "signature") return false;
  } else if (clause.abilityCategory) {
    const wantHeroic = clause.abilityCategory === "heroic";
    if ((sys.category === "heroic") !== wantHeroic && !clause.abilityCostScales) return false;
  }

  if (clause.abilityCostMax != null || clause.abilityCostScales) {
    const usedCost = Number(sys.resource ?? 0);
    if (clause.abilityCostScales) {
      
      const owed = Math.max(clause.abilityCostMax ?? 0, usedCost);
      const held = owner ? resourceOf(owner) : null;
      if (held != null && held < owed) {
        dbg(`${owner.name} cannot pay the ${owed} this use would cost (has ${held}), a scaling trigger skipped on USES_ABILITY`);
        return false;
      }
    } else if (usedCost > clause.abilityCostMax) return false;
  }
  
  if (clause.abilityPotency && !hasPotency(used)) return false;
  if (clause.abilityTargetCount != null) {
    const targets = context.usedTargets ?? [];
    if (targets.length) {
      if (targets.length !== clause.abilityTargetCount) return false;
      if (clause.abilityTargetSide === "enemy" && opposed(context.userToken, targets[0]) === false) return false;
      if (clause.abilityTargetSide === "ally" && opposed(context.userToken, targets[0]) === true) return false;
    } else if (Number(sys.target?.value ?? 0) !== clause.abilityTargetCount) return false;
  }
  return true;
}

export const hasPotency = (ability) => (ability?.system?.power?.effects?.contents ?? []).some((e) =>
  [1, 2, 3].some((t) => String(e[e.type]?.[`tier${t}`]?.display ?? "").includes("{{potency}}")));

export const dealsRolledDamage = (ability) => !!ability?.system?.power?.roll?.enabled
  && (ability.system.power?.effects?.contents ?? []).some((e) => e.type === "damage");

export function isMinionActor(actor) {
  return actor?.system?.isMinion ?? actor?.system?.monster?.organization === "minion";
}

function tokenSide(tokenDoc) {
  return tokenDoc?.disposition ?? (tokenDoc?.actor?.hasPlayerOwner ? 1 : -1);
}

function lastMinionStanding(subjectActor, subjectToken) {
  if (!isMinionActor(subjectActor)) return false;
  const defeated = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
  const side = tokenSide(subjectToken);
  for (const token of canvas.tokens?.placeables ?? []) {
    const doc = token.document;
    const actor = doc.actor;
    if (!actor || actor === subjectActor) continue;
    if (!isMinionActor(actor) || tokenSide(doc) !== side) continue;
    if (actor.statuses?.has(defeated) || (actor.system?.stamina?.value ?? 1) <= 0) continue;
    return false;
  }
  return true;
}

function grabsHeldBy(ownerActor, status) {
  let count = 0;
  for (const token of canvas.tokens?.placeables ?? []) {
    const actor = token.document.actor;
    if (!actor?.statuses?.has(status)) continue;
    if (actor.system?.statuses?.[status]?.sources?.has?.(ownerActor.uuid)) count++;
  }
  
  if (status === "grabbed") {
    const held = ownerActor.effects.filter((e) => e.flags?.["draw-steel-combat-tools"]?.grab?.grabbedId).length;
    count = Math.max(count, held);
  }
  return count;
}

function eventContextMatches(clause, event, ownerActor, subjectActor, subjectToken, ctx, item = null, ownerDisposition = null) {
  switch (event) {
    case "DEALS_DAMAGE":
      if (!damageKeywordsMatch(clause, ctx)) return false;
      if (clause.victimNotSelf && ctx.victimActor === ownerActor) return false;
      if (!clause.victimScope || !ctx.victimActor) return true;
      return scopeMatches({ scope: clause.victimScope }, ownerActor, ownerDisposition, ctx.victimActor, ctx.victimToken?.disposition ?? null);
    
    case "TAKES_DAMAGE":
      if (!damageKeywordsMatch(clause, ctx)) return false;
      if (!clause.dealerScope) return !ctx.dealerOnly;
      if (!ctx.dealerActor) return false;
      return scopeMatches({ scope: clause.dealerScope }, ownerActor, ownerDisposition, ctx.dealerActor, ctx.dealerToken?.disposition ?? null);
    case "TARGETED_BY_ABILITY":
    case "TARGETED_BY_STRIKE":
      if (clause.rolledDamage && ctx.ability && !dealsRolledDamage(ctx.ability)) return false;
      if (!clause.dealerScope || !ctx.dealerActor) return true;
      return scopeMatches({ scope: clause.dealerScope }, ownerActor, ownerDisposition, ctx.dealerActor, ctx.dealerToken?.disposition ?? null);
    case "CONDITION_GAIN": {
      if (clause.condition && ctx.condition !== clause.condition) return false;
      if (clause.sourceScope) {
        const sources = (ctx.sourceActorUuids ?? []).map((u) => fromUuidSync(u)).map((d) => d?.actor ?? d).filter(Boolean);
        if (sources.length && !sources.some((a) => scopeMatches({ scope: clause.sourceScope }, ownerActor, ownerDisposition, a, null))) return false;
      }
      if (clause.durationFilter === "save-or-eot" && !SAVE_OR_EOT.has(ctx.expiry)) return false;
      if (clause.asSource) {
        if (!(ctx.sourceActorUuids ?? []).includes(ownerActor.uuid)) return false;
        if (clause.grabCount && grabsHeldBy(ownerActor, ctx.condition ?? "grabbed") < clause.grabCount) {
          dbg(`${ownerActor.name} holds fewer than ${clause.grabCount} grabs, skipped on CONDITION_GAIN`);
          return false;
        }
      }
      return true;
    }
    case "GRAB_ENDS":
      return !clause.asSource || (ctx.sourceActorUuids ?? []).includes(ownerActor.uuid);
    case "EFFECT_ENDS":
      return !clause.effectName || (ctx.effectName ?? "").includes(clause.effectName);
    case "STAMINA_BELOW":
      return Number.isFinite(clause.value) && ctx.prevValue >= clause.value && ctx.curValue < clause.value;
    case "MOVES": {
      if (clause.entersSpace) return !!ctx.enteredActor && ctx.enteredActor === ownerActor;
      if (!clause.through || !ctx.throughActor) return false;
      if (clause.victimNotMentor) {
        const mentor = ownerActor.system?.retainer?.mentor;
        if (mentor && (ctx.throughActor === mentor || ctx.throughActor.id === mentor.id)) return false;
      }
      if (!clause.throughScope) return true;
      return scopeMatches({ scope: clause.throughScope }, ownerActor, ownerDisposition, ctx.throughActor, ctx.throughToken?.disposition ?? null);
    }
    case "DIES":
      if (ctx.deathOffered && item?.featureLine?.defersDeath) return false;
      if (clause.damageTypes?.length && ctx.damageType && !clause.damageTypes.includes(ctx.damageType)) return false;
      return !clause.lastMinion || lastMinionStanding(subjectActor, subjectToken);
    case "TURN_START":
    case "TURN_END": {
      if (clause.captainOnly && !isSquadCaptain(ownerActor)) {
        dbg(`${ownerActor.name} is not a squad captain, skipped on ${event}`);
        return false;
      }
      if (clause.oncePerRound && usedThisRound(ownerActor, item)) {
        dbg(`${ownerActor.name} already used ${item?.name} this round, skipped on ${event}`);
        return false;
      }
      return true;
    }
    default:
      return true;
  }
}

function statusMatches(clause, ownerActor, subjectActor) {
  if (clause.tauntedByOwner && !subjectActor?.system?.statuses?.taunted?.sources?.has?.(ownerActor.uuid)) return false;
  return !(clause.ownerLacks && ownerActor.statuses?.has(clause.ownerLacks));
}

function organizationMatches(clause, subjectActor) {
  const excluded = clause.organization?.exclude;
  if (!excluded?.length || !subjectActor) return true;
  const org = subjectActor.system?.monster?.organization ?? (isMinionActor(subjectActor) ? "minion" : null);
  return !excluded.includes(org);
}

const targetActors = (ctx) => (ctx.usedTargets ?? []).map((t) => t?.actor ?? fromUuidSync(t?.uuid ?? t)?.actor ?? null).filter(Boolean);

function watchedCreatures(subjectActor, ctx = {}) {
  return [subjectActor, ctx.victimActor, ...targetActors(ctx)].filter(Boolean);
}

function ownerEffectMatches(clause, ownerActor, subjectActor, ctx = {}) {
  const want = clause.ownerEffect;
  if (!want?.label || !labelKnown(ownerActor, want.label)) return true;
  const holders = want.on === "victim" ? (ctx.victimActor ? [ctx.victimActor] : targetActors(ctx))
    : want.on === "dealer" ? [ctx.dealerActor] : [subjectActor];
  return holders.some((a) => carriesMark(a, ownerActor, want.label));
}

export function collectTriggerMatches(event, subjectActor = null, subjectToken = null, usedAbility = null, usedContext = {}) {
  const defeated = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
  const subjectDisposition = subjectToken?.disposition ?? null;
  const matches = [];

  const candidates = candidateEntries().sort((a, b) => (b.actor === subjectActor) - (a.actor === subjectActor));
  const maliceSeen = new Set();
  const featureSeen = new Set();

  for (const { actor, disposition, token } of candidates) {
    const fallen = actor.statuses?.has(defeated);
    if (fallen && (event !== "MOVES" || !lingeringEffect(actor))) continue;
    if (isActorSnoozed(actor)) continue;
    const dazed = actor.statuses?.has("dazed") ?? false;
    const spent = isTriggeredActionSpent(actor);
    for (const entry of getTriggeredAbilities(actor)) {
      if (dazed && (entry.item.system.type === "triggered" || entry.item.system.type === "freeTriggered")) continue;
      if (entry.item.system.restricted || entry.item.featureLine?.marksSpace) continue;
      
      
      if (isSnoozedForAudience(actor, entry.item.system?._dsid ?? entry.item.dsid ?? null)) continue;
      const malice = isMaliceAbility(entry.item);
      
      
      
      const takesTurn = malice && entry.parse?.clauses?.some((c) => c.turnLock);
      if (malice && !takesTurn && subjectActor && subjectActor !== actor && !inSameCombatGroup(actor, subjectActor)) continue;
      if (malice && !takesTurn) {
        if (maliceSeen.has(entry.item.name)) continue;
        maliceSeen.add(entry.item.name);
      }
      const clause = entry.parse?.clauses?.find(c =>
        c.event === event && (!fallen || c.entersSpace) && (event !== "USES_ABILITY" || usedAbilityMatches(c, usedAbility, actor, usedContext))
        && eventContextMatches(c, event, actor, subjectActor, subjectToken, usedContext, entry.item, disposition)
        && organizationMatches(c, subjectActor)
        && statusMatches(c, actor, subjectActor)
        && ownerEffectMatches(c, actor, subjectActor, usedContext)
        && lineOfEffectMatches(c, actor, token, subjectActor, subjectToken, usedContext)
        && ((malice && !takesTurn) || ((c.asSource || scopeMatches(c, actor, disposition, subjectActor, subjectDisposition))
          && rangeMatches(c, entry.item, actor, token, subjectActor, subjectToken))));
      if (!clause) continue;
      if (entry.watch === "subject" && !entry.watchMark && !watchedCreatures(subjectActor, usedContext).some((a) => carriesEffect(a, entry.originUuid))) continue;
      
      if (!(malice && !takesTurn && event === "TURN_START") && !canAffordCost(actor, entry.item)) {
        dbg(`${actor.name} cannot afford ${entry.item.name} (costs ${entry.item.system.resource}, has ${resourceOf(actor)}), skipped on ${event}`);
        continue;
      }
      if (spent && !entry.free && !entry.noAction && !malice) {
        dbg(`${actor.name} has spent their triggered action, ${entry.item.name} skipped on ${event}`);
        continue;
      }
      if (clause.ownerUnacted && game.combat?.started) {
        const combatant = game.combat.combatants.find(c => c.actor === actor);
        if (combatant && !(activationsLeft(combatant) > 0)) continue;
      }
      if (clause.anyHeroUnacted && game.combat?.started) {
        if (!game.combat.combatants.some(c => c.actor?.type === "hero" && c.initiative > 0)) continue;
      }
      if (entry.featureLine && actor.type !== "hero") {
        const group = game.combat?.combatants.find((c) => c.actor === actor)?.group?.id ?? actor.uuid;
        const squadKey = `${group}|${entry.item.featureLine.key}`;
        if (featureSeen.has(squadKey)) continue;
        featureSeen.add(squadKey);
      }
      matches.push({ actor, item: entry.item, free: entry.free, noAction: !!entry.noAction, malice, clause, parse: entry.parse });
    }
  }
  return matches;
}

export function dispatchTriggerEvent({ event, subjectActor = null, subjectToken = null, causeLabel = "", triggerDamage = null, usedAbility = null, usedTargets = null, sourceMessageId = null, eventContext = {} }) {
  const subjectTokenUuid = subjectToken?.uuid ?? subjectToken?.document?.uuid ?? null;
  if (!isPrimaryGM()) return;
  noteGainEvent({ event, subjectActor, subjectToken, usedAbility, triggerDamage, eventContext, causeLabel });

  let matches = collectTriggerMatches(event, subjectActor, subjectToken, usedAbility, { usedTargets, userToken: subjectToken, ...eventContext });
  if ((event === "TURN_START" || event === "TURN_END") && getSetting("turnInterrupts")) {
    matches = matches.filter((m) => !m.clause?.turnLock);
  }
  if (!matches.length) return;

  const promptsOn = DAMAGE_PROMPTS.has(event) ? getSetting("damagePrompts")
    : CONDITION_PROMPTS.has(event) ? getSetting("conditionPrompts") : true;
  if (PROMPT_EVENTS.has(event) && promptsOn) {
    const prompts = matches.filter((m) =>
      !m.malice && (m.parse?.confidence === "high" || m.parse?.source === "manual"));
    if (prompts.length) enqueuePromptEntries(prompts, { event, causeLabel, triggerDamage, subjectTokenUuid, sourceMessageId });
    matches = matches.filter((m) => !prompts.includes(m));
  }

  if (!matches.length) return;
  if (!getSetting("chatReminders")) return;

  
  if (event === "TURN_START" && subjectActor) {
    const maliceMatches = matches.filter((m) => m.malice);
    if (maliceMatches.length) {
      const recipients = new Set(game.users.filter((u) => u.isGM).map((u) => u.id));
      for (const m of maliceMatches) for (const u of game.users) if (m.actor.testUserPermission(u, "OWNER")) recipients.add(u.id);
      sendMaliceCard(maliceMatches, subjectActor, { causeLabel, people: [subjectToken ?? subjectActor], recipients: [...recipients] });
      matches = matches.filter((m) => !m.malice);
    }
  }
  if (!matches.length) return;
  dbg(`event ${event} matched ${matches.length} abilities`, { causeLabel, matches });

  
  const groups = new Map();
  for (const match of matches) {
    const recipients = game.users.filter(u => u.isGM || match.actor.testUserPermission(u, "OWNER")).map(u => u.id);
    const key = recipients.sort().join(".");
    if (!groups.has(key)) groups.set(key, { recipients, matches: [] });
    groups.get(key).matches.push(match);
  }

  for (const group of groups.values()) {

    group.matches.sort((a, b) => {
      if (a.malice !== b.malice) return a.malice ? 1 : -1;
      if (!a.malice) return 0;
      return (a.item.system.resource ?? 999) - (b.item.system.resource ?? 999);
    });
    _sendReminderCard(group, { event, causeLabel, subjectActor, people: [subjectToken ?? subjectActor, ...Object.values(eventContext ?? {}), usedTargets ?? []] });
  }
}

async function _sendReminderCard(group, { event, causeLabel, subjectActor, people = [] }) {
  const body = await abilityRowsHTML(group.matches.map((m) => ({
    item: m.item,
    owner: m.actor !== subjectActor ? m.actor : null,
    pills: m.malice ? [malicePill(m.item)] : [],
  })));
  postSystemCard({
    title: game.i18n.localize("DS_TRIGGERS.Reminder.Header"),
    flavor: null,
    kind: "Reminder",
    content: cardContent({ event: withFaces(causeLabel, people.flat().filter((p) => p && typeof p === "object")), body }),
    whisper: group.recipients,
    flags: { [MODULE_ID]: { reminder: { event } } },
  });
}

Hooks.on("renderChatMessageHTML", (message, html) => {
  if (!["reminder", "notice", "resourceGain", "maliceSelect"].some((k) => message.getFlag(MODULE_ID, k))) return;
  const avatar = html.querySelector(".message-header img, img.avatar");
  if (avatar) {
    avatar.src = `modules/${MODULE_ID}/icons/emblem-coin.png`;
    avatar.classList.add("dst-avatar-emblem");
  }
});

document.addEventListener("click", async (event) => {
  const expand = event.target.closest(".dst-malice-expand");
  if (expand) {
    const embed = expand.closest(".dst-malice-feature")?.querySelector(".dst-malice-feature-embed");
    if (!embed) return;
    embed.classList.toggle("dst-collapsed");
    expand.querySelector("i")?.classList.toggle("dst-malice-chevron--open", !embed.classList.contains("dst-collapsed"));
    return;
  }
  const link = event.target.closest(".dst-ability-link");
  if (!link) return;
  event.preventDefault();
  const item = await fromUuid(link.dataset.itemUuid).catch(() => null);
  if (!item) {
    ui.notifications.warn("DS_TRIGGERS.Reminder.MissingAbility", { localize: true });
    return;
  }
  if (item.type !== "ability" && !event.shiftKey) {
    item.sheet?.render(true);
    return;
  }
  if (event.shiftKey) {
    await ds.documents.DrawSteelChatMessage.create({
      content: `@Embed[${item.uuid} caption=false]`,
      type: "standard",
      "system.parts": [{ type: "content" }],
      speaker: ds.documents.DrawSteelChatMessage.getSpeaker({ actor: item.actor }),
      title: item.name,
      flags: { core: { canPopout: true } },
    });
  } else {
    await item.system.use();
  }
});
