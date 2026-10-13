import { MODULE_ID, dbg, isPrimaryGM } from "../util.mjs";
import { getTriggeredAbilities } from "./registry.mjs";
import { triggersLive, usedAbilityMatches } from "./dispatch.mjs";
import { addDamagePill } from "./bespoke.mjs";

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

export function damageBonusFor(actor, attackerToken, targetToken, message = null) {
  if (!actor || !triggersLive()) return [];
  const token = attackerToken ?? actor.getActiveTokens?.(true, true)?.[0] ?? null;
  const pills = highGroundOf(message);
  const key = pillKey((targetToken?.document ?? targetToken)?.uuid);
  const out = [];
  for (const entry of getTriggeredAbilities(actor)) {
    if (entry.item.system?.restricted) continue;
    if (entry.parse?.confidence !== "high" && entry.parse?.source !== "manual") continue;
    for (const c of entry.parse?.clauses ?? []) {
      const amount = Number(c.damageBonus) || 0;
      if (!(amount > 0)) continue;
      if (c.highGround && !(pills ? pills.has(key) : hasHighGround(token, targetToken))) continue;
      out.push({ name: entry.item.name, amount });
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
      if (!c.damageTypeChange || !usedAbilityMatches(c, ability, actor)) continue;
      out.push({ name: entry.item.name, type: c.damageTypeChange });
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
    for (const b of damageBonusFor(actor, attacker, target, message)) {
      const key = `${message.id}:${t.tokenUuid}:${b.name}`;
      if (_done.has(key)) continue;
      _done.add(key);
      dbg(`${b.name}: +${b.amount} damage to ${target.name} on ${ability.name}`);
      await addDamagePill(message, t.tokenUuid, { kind: "delta", value: b.amount, label: b.name, src: actor.name, source: "trigger" });
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
