import { MODULE_ID, dbg, isPrimaryGM } from "../util.mjs";
import { dispatchTriggerEvent, triggersLive } from "./dispatch.mjs";
import { isTriggeredActionSpent, setTriggeredActionSpent } from "./spent-tracking.mjs";
import { isMaliceAbility } from "./registry.mjs";

const DSCT_ID = "draw-steel-combat-tools";
const DSTD_ID = "draw-steel-target-damage";
const FLAG = "squad";

const groupOf = (actor) => game.combat?.combatants.find((c) => c.actor === actor)?.group?.id ?? null;
const tokenIdOf = (actor) => actor?.token?.id ?? actor?.getActiveTokens?.(false, true)[0]?.id ?? null;

function squadKey(e) {
  if (e.kind || e.villain || e.gain || e.featureLine || e.state !== "pending") return null;
  const actor = fromUuidSync(e.ownerActorUuid);
  if (!actor?.system?.isMinion) return null;
  const group = groupOf(actor);
  const item = fromUuidSync(e.itemUuid);
  const dsid = item?.system?._dsid || item?.name;
  const batch = e.promptId ?? e.damageId ?? e.resolutionId ?? e.resumeId;
  if (!group || !dsid || !batch) return null;
  return [group, dsid, e.event, e.subjectTokenUuid ?? "", batch].join("|");
}

export function joinSquad(e, pool) {
  const key = squadKey(e);
  if (!key) return false;
  const into = pool.find((q) => q !== e && squadKey(q) === key);
  if (!into) return false;
  (into.squad ??= []).push({ ownerActorUuid: e.ownerActorUuid, ownerName: e.ownerName, itemUuid: e.itemUuid, tokenId: tokenIdOf(fromUuidSync(e.ownerActorUuid)) });
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
  await message.setFlag(MODULE_ID, FLAG, { primary: { actorUuid: primary?.uuid ?? null, itemUuid: use.abilityUuid, tokenId: tokenIdOf(primary), name: primary?.name ?? "" }, extras });
  await countExtras(message, extras);
});

const members = (squad) => [squad.primary, ...squad.extras].filter((m) => m?.actorUuid && m.itemUuid);

export function squadPills(message) {
  const squad = message.getFlag(MODULE_ID, FLAG);
  if (!squad?.extras?.length) return [];
  const targets = message.getFlag(DSTD_ID, "state")?.targets ?? [];
  const label = message.title || fromUuidSync(squad.extras[0].itemUuid)?.name || "";
  const pills = [
    ...members(squad).map((m) => ({ kind: "delta", repeat: true, splitBase: true, value: null, label, src: m.name, srcTokenId: m.tokenId, source: "trigger" })),
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
