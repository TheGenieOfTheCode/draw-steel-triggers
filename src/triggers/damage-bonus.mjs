import { MODULE_ID, dbg, isPrimaryGM } from "../util.mjs";
import { getTriggeredAbilities } from "./registry.mjs";
import { triggersLive, usedAbilityMatches, abilityDamageTypes, dealsRolledDamage, effectsMatch, footprintGap, isMinionActor } from "./dispatch.mjs";
import { addDamagePill } from "./bespoke.mjs";
import { autoApplies } from "./auto-use.mjs";
import { enqueuePromptEntries } from "./queue.mjs";

const DSCT_ID = "draw-steel-combat-tools";
const DSTD_ID = "draw-steel-target-damage";

const objectOf = (t) => t?.object ?? t ?? null;

function hasHighGround(attacker, target) {
  const check = game.modules.get(DSCT_ID)?.active ? game.modules.get(DSCT_ID).api?.hasHighGround : null;
  const a = objectOf(attacker), b = objectOf(target);
  if (typeof check !== "function" || !a || !b) return false;
  try { return !!check(a, b); } catch (err) { console.error(`${MODULE_ID} | high ground check failed`, err); return false; }
}

const pillKey = (uuid) => String(uuid ?? "").replace(/\./g, "__");

export function highGroundOf(message) {
  const targets = message?.getFlag?.(DSCT_ID, "rollPills")?.targets;
  if (!targets) return null;
  return new Set(Object.entries(targets)
    .filter(([, pills]) => (pills ?? []).some((p) => p.reason === "High Ground" && p.enabled !== false)).map(([k]) => k));
}

const CHARS = ["might", "agility", "reason", "intuition", "presence"];
const charValue = (actor, c) => Number(actor?.system?.characteristics?.[c]?.value) || 0;

export function bonusAmount(actor, bonus) {
  if (bonus === "highest") return Math.max(0, ...CHARS.map((c) => charValue(actor, c)));
  if (CHARS.includes(bonus)) return Math.max(0, charValue(actor, bonus));
  return Number(bonus) || 0;
}

const orgOf = (actor) => actor?.system?.monster?.organization ?? (isMinionActor(actor) ? "minion" : null);

function otherMinionInReach(attacker, target, ability) {
  const a = attacker?.document ?? attacker;
  const t = target?.document ?? target;
  if (!a?.parent) return false;
  const reach = Math.max(1, Number(ability?.system?.distance?.primary) || 1);
  return a.parent.tokens.some((d) => d !== t && d !== a && d.actor && isMinionActor(d.actor) && !d.actor.statuses?.has?.("dead")
    && footprintGap(a, d) < reach * canvas.grid.distance);
}

export function damageBonusFor(actor, attackerToken, targetToken, message = null, ability = null) {
  if (!actor || !triggersLive()) return [];
  const token = attackerToken ?? actor.getActiveTokens?.(true, true)?.[0] ?? null;
  const pills = highGroundOf(message);
  const key = pillKey((targetToken?.document ?? targetToken)?.uuid);
  const victim = (targetToken?.document ?? targetToken)?.actor ?? null;
  const disposition = (token?.document ?? token)?.disposition ?? null;
  const out = [];
  for (const entry of getTriggeredAbilities(actor)) {
    if (entry.item.system?.restricted) continue;
    if (entry.parse?.confidence !== "high" && entry.parse?.source !== "manual") continue;
    for (const c of entry.parse?.clauses ?? []) {
      if (c.damageBonus == null) continue;
      const amount = bonusAmount(actor, c.damageBonus);
      if (!(amount > 0)) continue;
      if (c.highGround && !(pills ? pills.has(key) : hasHighGround(token, targetToken))) continue;
      if (ability && !usedAbilityMatches(c, ability, actor)) continue;
      if (c.rolledDamage && !dealsRolledDamage(ability)) continue;
      if (c.victimOrganization?.length && !c.victimOrganization.includes(orgOf(victim))) continue;
      if (c.alsoMinionNear && !otherMinionInReach(token, targetToken, ability)) continue;
      if (c.effects?.length && !effectsMatch(c, actor, disposition, actor, { victimActor: victim, victimToken: targetToken?.document ?? targetToken })) continue;
      out.push({ name: entry.item.name, amount, optional: !!c.optional, item: entry.item, actor: entry.actor ?? actor,
        perRound: entry.item.featureLine?.once === "round", auto: autoApplies({ mandatory: !c.optional, perRound: entry.item.featureLine?.once === "round" }) });
    }
  }
  return out;
}

export function damageTypesFor(actor, ability) {
  if (!actor || !ability || !triggersLive()) return [];
  const out = [];
  for (const entry of getTriggeredAbilities(actor)) {
    if (entry.item.system?.restricted) continue;
    if (entry.parse?.confidence !== "high" && entry.parse?.source !== "manual") continue;
    for (const c of entry.parse?.clauses ?? []) {
      const types = c.damageTypeChange ? [c.damageTypeChange] : c.damageTypeChoices ?? [];
      if (!types.length || !usedAbilityMatches(c, ability, actor)) continue;
      const dealt = abilityDamageTypes(ability);
      if (!dealt.size) continue;
      if (c.damageTypes?.length && !c.damageTypes.some((t) => dealt.has(t))) continue;
      for (const type of types) if (!(dealt.size === 1 && dealt.has(type))) out.push({ name: entry.item.name, type });
    }
  }
  return out;
}

const _done = new Set();

async function _pillTargets(message) {
  if (!isPrimaryGM() || !game.modules.get(DSTD_ID)?.active) return;
  const targets = message.getFlag(DSTD_ID, "state")?.targets;
  if (!targets?.length) return;
  const use = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  const ability = use?.abilityUuid ? fromUuidSync(use.abilityUuid) : null;
  if (!ability?.system?.power?.roll?.enabled) return;
  const speaker = message.speaker ?? {};
  const attacker = speaker.token ? game.scenes.get(speaker.scene)?.tokens?.get(speaker.token) ?? null : null;
  const actor = attacker?.actor ?? ability.actor;
  if (!actor) return;
  for (const t of targets) {
    const target = t.tokenUuid ? fromUuidSync(t.tokenUuid) : null;
    if (!target || target.actor === actor) continue;
    for (const b of damageBonusFor(actor, attacker, target, message, ability)) {
      const key = `${message.id}:${t.tokenUuid}:${b.name}`;
      if (_done.has(key)) continue;
      _done.add(key);
      dbg(`${b.name}: +${b.amount} damage to ${target.name} on ${ability.name}${b.auto ? "" : " (on the stack)"}`);
      await addDamagePill(message, t.tokenUuid, { kind: "delta", value: b.amount, label: b.name, src: actor.name, source: "trigger", dstTarget: t.tokenUuid,
        ...(b.auto ? {} : { enabled: false }) });
      
      if (!b.auto) enqueuePromptEntries([{ item: b.item, actor: b.actor, _subjectTokenUuid: t.tokenUuid,
        _pill: { messageId: message.id, targetUuid: t.tokenUuid, label: b.name },
        _causeLabel: game.i18n.format("DS_TRIGGERS.Queue.BonusCause", { name: b.name, n: b.amount, target: target.name }) }],
      { event: "DEALS_DAMAGE", causeLabel: "", sourceMessageId: message.id });
    }
    for (const d of damageTypesFor(actor, ability)) {
      const key = `${message.id}:${t.tokenUuid}:${d.name}:type`;
      if (_done.has(key)) continue;
      _done.add(key);
      await addDamagePill(message, t.tokenUuid, { kind: "type", value: d.type, label: d.name, src: actor.name, source: "trigger", enabled: false });
    }
  }
  if (_done.size > 400) _done.clear();
}

Hooks.on("createChatMessage", (message) => { _pillTargets(message); });
Hooks.on("updateChatMessage", (message, changed) => {
  if (foundry.utils.hasProperty(changed, `flags.${DSTD_ID}.state.targets`)
    || foundry.utils.hasProperty(changed, `flags.${DSCT_ID}.rollPills`)) _pillTargets(message);
});
