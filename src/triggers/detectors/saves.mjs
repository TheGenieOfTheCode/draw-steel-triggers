import { dispatchTriggerEvent, triggersLive } from "../dispatch.mjs";
import { MODULE_ID, isPrimaryGM, dbg } from "../../util.mjs";

let _saving = null;

Hooks.once("ready", () => {
  if (!game.modules.get("lib-wrapper")?.active || !CONFIG.ActiveEffect.dataModels?.base?.prototype?.rollSave) return;
  libWrapper.register(MODULE_ID, "CONFIG.ActiveEffect.dataModels.base.prototype.rollSave", async function (wrapped, ...args) {
    _saving = this.parent?.uuid ?? null;
    try {
      return await wrapped(...args);
    } finally {
      _saving = null;
    }
  }, "WRAPPER");
});

const isSave = (r) => r?.constructor?.name === "SavingThrowRoll";

Hooks.on("preCreateChatMessage", (message) => {
  if (_saving && message.rolls?.some(isSave)) message.updateSource({ [`flags.${MODULE_ID}.saveEffect`]: _saving });
});

Hooks.on("createChatMessage", (message) => {
  if (!isPrimaryGM() || !triggersLive()) return;
  const part = message.system?.parts?.contents?.find((p) => p.type === "savingThrow" || p.rolls?.some?.(isSave));
  const roll = message.rolls?.find(isSave) ?? part?.rolls?.find?.(isSave);
  if (!roll) return;
  const effectUuid = part?.effectUuid ?? message.getFlag(MODULE_ID, "saveEffect") ?? null;
  const effect = effectUuid ? fromUuidSync(effectUuid) : null;
  const actor = effect?.target ?? (effect?.parent?.documentName === "Actor" ? effect.parent : effect?.parent?.actor)
    ?? ChatMessage.implementation.getSpeakerActor(message.speaker) ?? null;
  if (!actor) return;
  const succeeded = !!roll.product;
  const token = actor.getActiveTokens?.(false, true)?.[0] ?? null;
  const effectName = effect?.name ?? "";
  dbg(`${actor.name} ${succeeded ? "succeeded on" : "failed"} a saving throw${effectName ? ` against ${effectName}` : ""}`);
  dispatchTriggerEvent({
    event: "SAVING_THROW",
    subjectActor: actor,
    subjectToken: token,
    causeLabel: game.i18n.format(succeeded ? "DS_TRIGGERS.Reminder.SaveSucceeds" : "DS_TRIGGERS.Reminder.SaveFails", { name: actor.name, effect: effectName }),
    sourceMessageId: message.id,
    eventContext: { saveSucceeds: succeeded, effectName, effectUuid, effectStatuses: [...(effect?.statuses ?? [])] },
  });
});
