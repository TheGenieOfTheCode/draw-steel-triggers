import { dispatchTriggerEvent } from "../dispatch.mjs";
import { getTriggeredAbilities } from "../registry.mjs";
import { dbg, isPrimaryGM } from "../../util.mjs";

const cellsOf = (x, y, width, height) => {
  const size = canvas.grid.size;
  const gx = Math.round(x / size);
  const gy = Math.round(y / size);
  const out = [];
  for (let i = 0; i < Math.max(1, Math.round(width)); i++) {
    for (let j = 0; j < Math.max(1, Math.round(height)); j++) out.push(`${gx + i},${gy + j}`);
  }
  return out;
};

const movesThrough = (actor) => getTriggeredAbilities(actor)
  .some((e) => e.parse?.clauses?.some((c) => c.event === "MOVES" && c.through));

export function passedThrough(doc, movement) {
  const passed = movement?.passed?.waypoints ?? [];
  if (!passed.length) return [];
  const origin = movement.origin ?? {};
  const steps = doc.getCompleteMovementPath(passed).slice(0, -1)
    .filter((s) => s.action !== "teleport" && !(s.x === origin.x && s.y === origin.y));
  if (!steps.length) return [];
  const walked = new Set(steps.flatMap((s) => cellsOf(s.x, s.y, s.width ?? doc.width, s.height ?? doc.height)));
  const defeated = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
  return (doc.parent?.tokens?.contents ?? []).filter((t) => t.id !== doc.id && t.actor && !t.hidden
    && !t.actor.statuses?.has(defeated)
    && cellsOf(t.x, t.y, t.width, t.height).some((c) => walked.has(c)));
}

Hooks.on("updateToken", (doc, _changes, options) => {
  if (!isPrimaryGM()) return;
  if (!game.combat?.started) return;
  if (options?.isUndo || options?.isPaste || window._dsctTeleportActive) return;
  const movement = options?._movement?.[doc.id];
  if (!movement || !doc.actor || !movesThrough(doc.actor)) return;
  for (const victim of passedThrough(doc, movement)) {
    dbg(`${doc.name} moved through ${victim.name}`);
    dispatchTriggerEvent({
      event: "MOVES",
      subjectActor: doc.actor,
      subjectToken: doc,
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.MovesThrough", { name: doc.name, target: victim.name }),
      eventContext: { throughActor: victim.actor, throughToken: victim },
    });
  }
});
