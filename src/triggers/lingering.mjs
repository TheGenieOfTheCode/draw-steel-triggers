import { getTriggeredAbilities } from "./registry.mjs";
import { MODULE_ID, dbg, isPrimaryGM } from "../util.mjs";

const DT_ID = "draw-steel-death-tracker";
const defeatedId = () => CONFIG.specialStatusEffects?.DEFEATED ?? "dead";

export const lingeringEffect = (actor) => actor?.effects?.find((e) => e.getFlag(MODULE_ID, "lingering") !== undefined) ?? null;

export const lingeringTokens = (scene = canvas.scene) =>
  (scene?.tokens?.contents ?? []).filter((t) => t.actor?.statuses?.has(defeatedId()) && lingeringEffect(t.actor));

export async function endLingering(actor) {
  const effect = lingeringEffect(actor);
  if (effect) await effect.delete().catch(() => {});
}

Hooks.on("createActiveEffect", async (effect) => {
  if (!isPrimaryGM() || !effect.statuses?.has(defeatedId())) return;
  const actor = effect.parent;
  if (actor?.documentName !== "Actor" || lingeringEffect(actor)) return;
  const entry = getTriggeredAbilities(actor).find((e) => e.item.featureLine?.marksSpace);
  if (!entry) return;
  const line = entry.item.featureLine;
  const text = String(line.effect ?? "");
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: entry.item.feature?.name ?? line.itemName ?? entry.item.name,
    img: entry.item.img,
    description: `<p>${foundry.utils.escapeHTML(text[0]?.toUpperCase() + text.slice(1))}</p>`,
    flags: { [MODULE_ID]: { lingering: line.key }, [DT_ID]: { keepVisible: true } },
  }]);
  dbg(`${actor.name} died and left ${line.itemName} in their space`);
});

Hooks.on("deleteActiveEffect", (effect) => {
  if (!isPrimaryGM() || !effect.statuses?.has(defeatedId())) return;
  const actor = effect.parent;
  if (actor?.documentName === "Actor") endLingering(actor);
});
