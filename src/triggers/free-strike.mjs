import { MODULE_ID, getSetting } from "../util.mjs";

export async function postFreeStrikeCard(actor) {
  const strike = actor.system.freeStrike;
  const title = game.i18n.localize("DRAW_STEEL.Actor.npc.FreeStrike.DialogTitle");
  const roll = new ds.rolls.DamageRoll(String(strike.value), { type: strike.type, flavor: ds.CONFIG.damageTypes[strike.type]?.label });
  await roll.evaluate();
  return ChatMessage.implementation.create({
    title,
    speaker: ChatMessage.implementation.getSpeaker({ actor, token: actor.token ?? undefined }),
    type: "standard",
    "system.parts": [{ rolls: [roll], flavor: title, type: "roll" }],
    flags: { core: { canPopout: true }, [MODULE_ID]: { freeStrike: true } },
  });
}

Hooks.once("ready", () => {
  if (!game.modules.get("lib-wrapper")?.active) return;
  libWrapper.register(MODULE_ID, "ds.data.Actor.NPCModel.prototype.performFreeStrike", async function (wrapped, ...args) {
    if (!game.user.isGM || !getSetting("freeStrikeCards")) return wrapped(...args);
    if (await game.modules.get("draw-steel-combat-tools")?.api?.squadFreeStrike?.(this.parent)) return;
    await postFreeStrikeCard(this.parent);
  }, "MIXED");
});
