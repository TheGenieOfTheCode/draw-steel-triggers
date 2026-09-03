import { MODULE_ID, getSetting, dbg } from "../util.mjs";
import { isMaliceAbility } from "./registry.mjs";

function combatantFor(actor, combat = game.combat) {
  return combat?.combatants.find(c => c.actor === actor) ?? null;
}

function dsctTriggeredEffect(actor) {
  if (!game.modules.get("draw-steel-combat-tools")?.active) return null;
  return actor?.effects.find((e) => e.getFlag("draw-steel-combat-tools", "effectType") === "triggered-action") ?? null;
}

export function isTriggeredActionSpent(actor) {
  if (!getSetting("spentTracking")) return false;
  const effect = dsctTriggeredEffect(actor);
  if (effect) return effect.disabled;
  return !!combatantFor(actor)?.getFlag(MODULE_ID, "spent");
}

export async function setTriggeredActionSpent(actor, spent = true) {
  const effect = dsctTriggeredEffect(actor);
  if (effect) {
    if (effect.disabled !== spent) await effect.update({ disabled: spent });
    return;
  }
  const combatant = combatantFor(actor);
  if (!combatant) return;
  if (spent) await combatant.setFlag(MODULE_ID, "spent", true);
  else await combatant.unsetFlag(MODULE_ID, "spent");
}

Hooks.on("createChatMessage", async (message) => {
  if (!game.users.activeGM?.isSelf) return;
  if (!getSetting("spentTracking")) return;
  const abilityUse = message.system?.parts?.contents?.find(p => p.type === "abilityUse");
  if (!abilityUse?.abilityUuid) return;
  const item = await fromUuid(abilityUse.abilityUuid).catch(() => null);
  if (item?.system?.type !== "triggered") return;
  if (isMaliceAbility(item)) return;
  const actor = ChatMessage.getSpeakerActor(message.speaker);
  if (!actor) return;
  dbg(`triggered action spent: ${actor.name} used ${item.name}`);
  await setTriggeredActionSpent(actor, true);
});

Hooks.on("combatTurnChange", async (combat, previous, current) => {
  if (!game.users.activeGM?.isSelf) return;
  if (!previous || current.round === previous.round) return;
  for (const combatant of combat.combatants) {
    if (combatant.getFlag(MODULE_ID, "spent")) await combatant.unsetFlag(MODULE_ID, "spent");
  }
});
