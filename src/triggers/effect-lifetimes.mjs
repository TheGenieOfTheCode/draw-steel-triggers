import { dbg, isPrimaryGM } from "../util.mjs";
import { abilityEffectHTML } from "../parser/feature-triggers.mjs";
import { featureTriggersActive } from "./feature-triggers.mjs";

const AGAIN = /\buntil (?:[^.]*?,\s*)?(?:or )?you use this ability again\b|,\s*you use this ability again\b/i;
const RIVAL = /\banother (\w+) (?:judges|marks)\b/i;
const DYING = /\buntil you are dying\b/i;

const textOf = (item) => abilityEffectHTML(item).replace(/<[^>]+>/g, " ");

function everyActor() {
  const actors = new Set(game.actors);
  for (const c of game.combat?.combatants ?? []) if (c.actor) actors.add(c.actor);
  for (const t of canvas?.tokens?.placeables ?? []) if (t.actor) actors.add(t.actor);
  return [...actors];
}

const CT_FLAGS = [[/judg/i, "judgement"], [/\bmark/i, "mark"]];

async function endEffectsFrom(origin, { except = null, why = "" } = {}) {
  const item = fromUuidSync(origin);
  const ctKey = CT_FLAGS.find(([rx]) => rx.test(item?.name ?? ""))?.[1] ?? null;
  const fromCT = (e) => !!ctKey && !e.origin && e.getFlag?.("draw-steel-combat-tools", ctKey)?.actorId === item?.actor?.id;
  for (const actor of everyActor()) {
    const ids = actor.effects.filter((e) => (e.origin === origin || fromCT(e)) && e.id !== except?.id).map((e) => e.id);
    if (!ids.length) continue;
    dbg(`effect lifetimes: ${why} ends ${ids.length} effect(s) on ${actor.name}`);
    await actor.deleteEmbeddedDocuments("ActiveEffect", ids).catch(() => {});
  }
}

const active = () => isPrimaryGM() && featureTriggersActive();

Hooks.on("createChatMessage", async (message) => {
  if (!active()) return;
  const use = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  const ability = use?.abilityUuid ? fromUuidSync(use.abilityUuid) : null;
  if (!ability || !AGAIN.test(textOf(ability))) return;
  await endEffectsFrom(ability.uuid, { why: `${ability.name} used again` });
});

Hooks.on("createActiveEffect", async (effect) => {
  if (!active() || !effect.origin) return;
  const source = fromUuidSync(effect.origin);
  if (source?.documentName !== "Item" || source.type !== "ability" || !RIVAL.test(textOf(source))) return;
  const target = effect.parent;
  const dsid = source.system?._dsid;
  const rivals = target.effects.filter((e) => {
    if (e.id === effect.id || !e.origin) return false;
    const other = fromUuidSync(e.origin);
    return other?.documentName === "Item" && other.actor?.id !== source.actor?.id && (other.system?._dsid === dsid || other.name === source.name);
  });
  if (!rivals.length) return;
  dbg(`effect lifetimes: ${source.actor?.name}'s ${source.name} replaces ${rivals.length} rival effect(s) on ${target.name}`);
  await target.deleteEmbeddedDocuments("ActiveEffect", rivals.map((e) => e.id)).catch(() => {});
});

Hooks.on("createActiveEffect", async (effect) => {
  if (!active() || !effect.statuses?.has?.("dying")) return;
  const owner = effect.parent;
  if (owner?.documentName !== "Actor") return;
  for (const item of owner.items) {
    if (item.type === "ability" && DYING.test(textOf(item))) await endEffectsFrom(item.uuid, { why: `${owner.name} is dying` });
  }
});
