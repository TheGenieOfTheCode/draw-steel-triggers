import { MODULE_ID, dbg, isPrimaryGM } from "../util.mjs";
import { dispatchTriggerEvent, triggersLive, activeCombat } from "./dispatch.mjs";
import { isTriggeredActionSpent, setTriggeredActionSpent } from "./spent-tracking.mjs";
import { isMaliceAbility } from "./registry.mjs";
import { noteTargetsChange } from "./detectors/resolution.mjs";

const DSCT_ID = "draw-steel-combat-tools";
const DSTD_ID = "draw-steel-target-damage";
const FLAG = "squad";

const groupOf = (actor) => (activeCombat() ?? game.combat)?.combatants.find((c) => c.actor === actor)?.group?.id ?? null;
const tokenIdOf = (actor) => actor?.token?.id ?? actor?.getActiveTokens?.(false, true)[0]?.id ?? null;

export function squadBase(e) {
  if (e.kind || e.villain || e.gain || (e.featureLine && !e.squadBatch) || e.state !== "pending") return null;
  const actor = fromUuidSync(e.ownerActorUuid);
  if (!actor?.system?.isMinion) return null;
  const group = groupOf(actor);
  const item = fromUuidSync(e.itemUuid);
  const dsid = item?.system?._dsid || item?.name;
  if (!group || !dsid) return null;
  return [group, dsid, e.event].join("|");
}

function squadKey(e) {
  if (e.choices?.length || e.squadChooser) return null;
  const base = squadBase(e);
  const batch = e.squadBatch ?? e.promptId ?? e.damageId ?? e.resolutionId ?? e.resumeId;
  if (!base || !batch) return null;
  return [base, e.squadBatch ? "" : e.subjectTokenUuid ?? "", batch].join("|");
}

export const squadMember = (e) => ({ ownerActorUuid: e.ownerActorUuid, ownerName: e.ownerName, itemUuid: e.itemUuid, tokenId: tokenIdOf(fromUuidSync(e.ownerActorUuid)) });

export function joinSquad(e, pool) {
  const key = squadKey(e);
  if (!key) return false;
  const into = pool.find((q) => q !== e && squadKey(q) === key);
  if (!into) return false;
  (into.squad ??= []).push(squadMember(e));
  dbg(`squad: ${e.ownerName} joins ${into.ownerName}'s ${into.itemName} (${into.squad.length + 1} minions)`);
  return true;
}

const _pending = new Map();

export function noteSquadUse(entry) {
  if (!entry.squad?.length) return;
  _pending.set(entry.itemUuid, { extras: entry.squad, at: Date.now() });
}

const bleeds = (item) => ["main", "triggered"].includes(item.system.type)
  || (!!item.system.power?.roll?.enabled && [...(item.system.power.roll.characteristics ?? [])].some((c) => c === "might" || c === "agility"));

async function countExtras(message, extras) {
  const targets = (message.getFlag(DSTD_ID, "state")?.targets ?? [])
    .map((t) => (t.tokenUuid ? fromUuidSync(t.tokenUuid) : null)).filter(Boolean);
  const bleed = game.modules.get(DSCT_ID)?.api?.rollBleeding;
  for (const m of extras) {
    const actor = fromUuidSync(m.actorUuid);
    const item = fromUuidSync(m.itemUuid);
    if (!actor || !item) continue;
    const token = actor.getActiveTokens(true, true)[0] ?? null;
    if (item.system.type === "triggered" && !isMaliceAbility(item)) await setTriggeredActionSpent(actor, true);
    if (triggersLive()) {
      dispatchTriggerEvent({
        event: "USES_ABILITY",
        subjectActor: actor,
        subjectToken: token,
        usedAbility: item,
        usedTargets: targets,
        sourceMessageId: message.id,
        causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.UsesAbility", { name: actor.name, ability: item.name }),
      });
    }
    if (bleed && actor.statuses?.has("bleeding") && bleeds(item)) await bleed(actor, { tokenId: token?.id ?? m.tokenId, sourceMessageId: message.id });
  }
}

Hooks.on("createChatMessage", async (message) => {
  if (!isPrimaryGM() || !_pending.size) return;
  const use = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  const rec = use?.abilityUuid ? _pending.get(use.abilityUuid) : null;
  if (!rec) return;
  _pending.delete(use.abilityUuid);
  if (Date.now() - rec.at > 120000) return;
  const primary = fromUuidSync(use.abilityUuid)?.actor ?? null;
  const extras = rec.extras.map((m) => ({ actorUuid: m.ownerActorUuid, itemUuid: m.itemUuid, tokenId: m.tokenId, name: m.ownerName }));
  const squad = { primary: { actorUuid: primary?.uuid ?? null, itemUuid: use.abilityUuid, tokenId: tokenIdOf(primary), name: primary?.name ?? "" }, extras };
  const bursts = burstPlan(squad);
  const rolled = bursts ? await burstRolls(squad, bursts) : null;
  const rolls = rolled?.rolls ?? null;
  await message.setFlag(MODULE_ID, FLAG, rolls ? { ...squad, bursts, rolls, formula: rolled.formula } : squad);
  if (rolls) await widenTargets(message, bursts);
  await countExtras(message, extras);
});

const members = (squad) => [squad.primary, ...squad.extras].filter((m) => m?.actorUuid && m.itemUuid);

function burstPlan(squad) {
  const around = game.modules.get(DSCT_ID)?.api?.burstTargetsAround;
  if (!around) return null;
  const bursts = {};
  for (const m of members(squad)) {
    const token = canvas.tokens.get(m.tokenId);
    const item = fromUuidSync(m.itemUuid);
    if (!token || !item) continue;
    const hits = around(item, token);
    if (hits === null) return null;
    bursts[m.tokenId] = hits.map((t) => t.document.uuid);
  }
  return Object.keys(bursts).length ? bursts : null;
}

async function burstRolls(squad, bursts) {
  const rolls = {};
  let used = null;
  for (const m of members(squad)) {
    if (!bursts[m.tokenId]?.length) continue;
    const item = fromUuidSync(m.itemUuid);
    const formula = (item?.system?.effects?.contents ?? []).find((e) => e.type === "dsct.flatDamage")?.flatDamage?.value;
    if (!formula) return null;
    const roll = await new Roll(String(formula), fromUuidSync(m.actorUuid)?.getRollData?.() ?? {}).evaluate();
    rolls[m.tokenId] = Math.floor(roll.total);
    used ??= String(formula);
  }
  return { rolls, formula: used };
}

async function widenTargets(message, bursts) {
  for (let i = 0; i < 20 && !message.getFlag(DSTD_ID, "state"); i++) await new Promise((r) => setTimeout(r, 150));
  const state = message.getFlag(DSTD_ID, "state");
  if (!state) return;
  const reach = new Set(Object.values(bursts).flat());
  const kept = (state.targets ?? []).filter((t) => reach.has(t.tokenUuid));
  const added = [...reach].filter((u) => !kept.some((t) => t.tokenUuid === u)).map((u) => {
    const doc = fromUuidSync(u);
    const actor = doc?.actor;
    return doc ? { tokenUuid: doc.uuid, tokenId: doc.id, sceneId: doc.parent?.id ?? null, actorUuid: actor?.uuid ?? null, actorId: actor?.id ?? null,
      name: doc.name, tokenImg: doc.texture?.src ?? null, actorImg: actor?.img ?? null, img: doc.texture?.src ?? actor?.img ?? null } : null;
  }).filter(Boolean);
  const targets = [...kept, ...added];
  noteTargetsChange(message.id, targets.map((t) => String(t.tokenUuid ?? t.actorUuid ?? "")));
  await message.update({ [`flags.${DSTD_ID}.state.targets`]: targets, [`flags.${DSTD_ID}.state.updatedAt`]: Date.now() });
}

export function squadPills(message) {
  const squad = message.getFlag(MODULE_ID, FLAG);
  if (!squad?.extras?.length) return [];
  const targets = message.getFlag(DSTD_ID, "state")?.targets ?? [];
  const label = message.title || fromUuidSync(squad.extras[0].itemUuid)?.name || "";
  if (squad.bursts && squad.rolls) {
    return targets.filter((t) => t.tokenUuid).flatMap((t) => members(squad)
      .filter((m) => squad.bursts[m.tokenId]?.includes(t.tokenUuid) && squad.rolls[m.tokenId] != null)
      .map((m) => ({ targetUuid: t.tokenUuid, pill: { kind: "delta", splitBase: true, value: squad.rolls[m.tokenId], ...(squad.formula ? { formula: squad.formula } : {}), label, src: m.name, srcTokenId: m.tokenId, source: "trigger", dealer: true } })));
  }
  const pills = [
    ...members(squad).map((m) => ({ kind: "delta", repeat: true, splitBase: true, value: null, label, src: m.name, srcTokenId: m.tokenId, source: "trigger", dealer: true })),
  ];
  return targets.filter((t) => t.tokenUuid).flatMap((t) => pills.map((pill) => ({ targetUuid: t.tokenUuid, pill })));
}

Hooks.on("updateChatMessage", (message, changes) => {
  if (!isPrimaryGM()) return;
  const squad = message.getFlag(MODULE_ID, FLAG);
  if (!squad?.extras?.length || !foundry.utils.hasProperty(changes, `flags.${DSTD_ID}.state`)) return;
  const overrides = message.getFlag(DSTD_ID, "state")?.damageOverrides ?? {};
  const pills = Object.values(overrides).flatMap((o) => o?.dstPills ?? []);
  for (const m of members(squad)) {
    const mine = pills.filter((p) => p.kind !== "note" && p.srcTokenId === m.tokenId);
    if (!mine.length) continue;
    const on = mine.some((p) => p.enabled !== false);
    const actor = fromUuidSync(m.actorUuid);
    const item = fromUuidSync(m.itemUuid);
    if (!actor || item?.system?.type !== "triggered" || isMaliceAbility(item)) continue;
    if (isTriggeredActionSpent(actor) !== on) setTriggeredActionSpent(actor, on).catch(() => {});
  }
});
