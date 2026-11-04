import { dispatchTriggerEvent, triggersLive, hasPotency } from "../dispatch.mjs";
import { getSetting, dbg, isPrimaryGM, rolledTargets } from "../../util.mjs";
import { gainsActive } from "../resource-gains.mjs";
import { itemFeatureLines, noteFeatureLineUse } from "../feature-triggers.mjs";
import { abilityOnce, abilityOnceKey } from "../registry.mjs";
import { recordAbilityUse } from "../ability-uses.mjs";

const ABILITY_PART = "abilityUse";

export function usedFromMessage(message) {
  const part = message.system?.parts?.contents?.find((p) => p.type === ABILITY_PART);
  if (!part?.abilityUuid) return null;
  const item = fromUuidSync(part.abilityUuid);
  if (!item?.system) return null;

  const actor = item.actor ?? null;
  if (!actor) return null;
  
  
  const token = actor.getActiveTokens(true, true)[0] ?? null;
  return { item, actor, token };
}

export function targetsOf(message) {
  return rolledTargets(message).map((t) => {
    const token = t.tokenUuid ? fromUuidSync(t.tokenUuid, { strict: false }) : null;
    return token ?? fromUuidSync(t.actorUuid, { strict: false })?.getActiveTokens?.(false, true)?.[0] ?? null;
  }).filter(Boolean);
}

function _rollTargetsOf(message) {
  return rolledTargets(message).map((t) => fromUuidSync(t.actorUuid, { strict: false })).filter(Boolean);
}

Hooks.on("createChatMessage", (message) => {
  if (!isPrimaryGM()) return;
  const used = usedFromMessage(message);
  if (used?.actor && abilityOnce(used.item)) noteFeatureLineUse(used.actor, abilityOnceKey(used.item));
  if (!getSetting("chatReminders") && !getSetting("damagePrompts") && !gainsActive()) return;
  if (!triggersLive()) return;
  if (!used) return;

  const targets = targetsOf(message);
  dbg(`ability used: ${used.actor.name} used ${used.item.name} `
    + `(${used.item.system.type}, cost ${used.item.system.resource ?? 0}, ${targets.length} targets)`);
  dispatchTriggerEvent({
    event: "USES_ABILITY",
    subjectActor: used.actor,
    subjectToken: used.token,
    usedAbility: used.item,
    usedTargets: targets,
    sourceMessageId: message.id,
    causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.UsesAbility", {
      name: used.actor.name, ability: used.item.name,
    }),
  });
  const usedLine = itemFeatureLines(used.item).find((l) => l.watch === "used");
  if (usedLine) {
    recordAbilityUse(used.actor, used.item, targets.length ? targets : _rollTargetsOf(message), usedLine.used)
      .catch((err) => console.warn(`draw-steel-triggers | could not record the use of ${used.item.name}`, err));
  }
  if (!hasPotency(used.item)) return;
  for (const target of targets) {
    if (!target.actor || target.actor === used.actor) continue;
    dispatchTriggerEvent({
      event: "RESISTS_POTENCY",
      subjectActor: target.actor,
      subjectToken: target,
      sourceMessageId: message.id,
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.ResistsPotency", { name: target.name, ability: used.item.name }),
      eventContext: { ability: used.item, dealerActor: used.actor, dealerToken: used.token },
    });
  }
});
