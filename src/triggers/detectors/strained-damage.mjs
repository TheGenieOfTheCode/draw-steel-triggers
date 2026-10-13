import { MODULE_ID } from "../../util.mjs";

let _pending = null;

function effectAt(dl) {
  const li = dl.closest("[data-message-id]");
  const message = li ? game.messages.get(li.dataset.messageId) : null;
  const part = message?.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  const ability = part?.abilityUuid ? fromUuidSync(part.abilityUuid) : null;
  const effects = ability?.system?.effects;
  if (!effects) return null;
  const shown = (effects.sortedContents ?? [...effects]).filter((e) => !part.effects?.size || part.effects.has(e.id));
  const section = dl.closest("section.effect");
  if (!section) return null;
  const before = section.classList.contains("before");
  const index = [...section.querySelectorAll(":scope > dl")].indexOf(dl);
  return { effect: shown.filter((e) => !!e.before === before)[index] ?? null, ability };
}

document.addEventListener("click", (event) => {
  const link = event.target?.closest?.("[data-type='damageHeal'][data-roll-type='damage']");
  const dl = link?.closest("dd.effect")?.parentElement;
  if (!dl) return;
  const found = effectAt(dl);
  if (found?.effect?.type !== "strained") return;
  _pending = { at: Date.now(), abilityUuid: found.ability.uuid };
}, { capture: true });

Hooks.on("preCreateChatMessage", (message, data, options, userId) => {
  if (!_pending || userId !== game.user.id) return;
  const fresh = Date.now() - _pending.at < 30000;
  const parts = data.system?.parts ?? data["system.parts"];
  const rolls = Object.values(parts ?? {}).some((p) => p?.type === "roll");
  if (!fresh || !rolls) return;
  message.updateSource({ [`flags.${MODULE_ID}`]: { damageSource: "strained", strainedAbility: _pending.abilityUuid } });
  _pending = null;
});
