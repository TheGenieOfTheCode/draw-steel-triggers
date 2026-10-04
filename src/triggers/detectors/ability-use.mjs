import { dispatchTriggerEvent } from "../dispatch.mjs";
import { getSetting, dbg, isPrimaryGM } from "../../util.mjs";
import { gainsActive } from "../resource-gains.mjs";

const ABILITY_PART = "abilityUse";

function _usedFromMessage(message) {
  const part = message.system?.parts?.contents?.find((p) => p.type === ABILITY_PART);
  if (!part?.abilityUuid) return null;
  const item = fromUuidSync(part.abilityUuid);
  if (!item?.system) return null;

  const actor = item.actor ?? null;
  if (!actor) return null;
  
  
  const token = actor.getActiveTokens(true, true)[0] ?? null;
  return { item, actor, token };
}

function _targetsOf(message) {
  const state = message.getFlag("draw-steel-target-damage", "state");
  return (state?.targets ?? [])
    .map((t) => (t.tokenUuid ? fromUuidSync(t.tokenUuid) : null))
    .filter(Boolean);
}

Hooks.on("createChatMessage", (message) => {
  if (!isPrimaryGM()) return;
  if (!getSetting("chatReminders") && !getSetting("damagePrompts") && !gainsActive()) return;
  if (!game.combat?.started) return;

  const used = _usedFromMessage(message);
  if (!used) return;

  const targets = _targetsOf(message);
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
});
