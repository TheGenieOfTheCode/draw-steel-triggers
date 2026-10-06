import { MODULE_ID, dbg, isPrimaryGM, batchedNotice } from "../util.mjs";

const DT_ID = "draw-steel-death-tracker";

export function deferDeathApi() {
  const dt = game.modules.get(DT_ID);
  return dt?.active && dt.api?.deferDeath?.status ? dt.api.deferDeath : null;
}

export async function deferDeath(actor, itemName) {
  const api = deferDeathApi();
  if (!api || !actor || api.isDeferred(actor)) return;
  const effect = await ActiveEffect.implementation.fromStatusEffect(api.status);
  effect.updateSource({ [`flags.${MODULE_ID}.deferredBy`]: itemName ?? "" });
  await actor.createEmbeddedDocuments("ActiveEffect", [effect.toObject()], { keepId: true });
  dbg(`${itemName} deferred the death of ${actor.name}`);
  batchedNotice("DeathDeferred", actor.name);
}

Hooks.on("updateActor", (actor, changed) => {
  if (!isPrimaryGM()) return;
  if (changed.system?.stamina?.value === undefined || !(actor.system?.stamina?.value > 0)) return;
  const api = deferDeathApi();
  if (!api?.isDeferred(actor)) return;
  const ours = actor.effects.filter((e) => e.statuses?.has(api.status) && e.getFlag(MODULE_ID, "deferredBy") !== undefined);
  if (!ours.length) return;
  dbg(`${actor.name} is back above 0 Stamina, releasing the deferred death`);
  actor.deleteEmbeddedDocuments("ActiveEffect", ours.map((e) => e.id)).catch(() => {});
});
