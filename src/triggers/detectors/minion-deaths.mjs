import { isPrimaryGM } from "../../util.mjs";
import { dispatchTriggerEvent, triggersLive } from "../dispatch.mjs";

const BATCH_MS = 3000;
const _batches = new Map();

function batchFor(groupId) {
  const now = Date.now();
  const open = _batches.get(groupId);
  if (open && now - open.at < BATCH_MS) {
    open.at = now;
    return open.id;
  }
  const id = foundry.utils.randomID();
  _batches.set(groupId, { id, at: now });
  return id;
}

Hooks.on("createActiveEffect", (effect) => {
  if (!isPrimaryGM() || !triggersLive()) return;
  if (!effect.statuses?.has(CONFIG.specialStatusEffects?.DEFEATED ?? "dead")) return;
  const actor = effect.parent;
  if (actor?.documentName !== "Actor" || !actor.system?.isMinion) return;
  const combatant = game.combat?.combatants.find((c) => c.actor === actor || c.actor?.uuid === actor.uuid);
  const group = combatant?.group;
  if (group?.type !== "squad") return;
  const token = actor.token ?? actor.getActiveTokens(false, true)[0]?.document ?? null;
  dispatchTriggerEvent({
    event: "DIES",
    subjectActor: actor,
    subjectToken: token,
    causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.Dies", { name: token?.name ?? actor.name }),
    eventContext: { squadDeath: batchFor(group.id) },
  });
});
