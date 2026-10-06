import { dispatchTriggerEvent, collectTriggerMatches } from "../dispatch.mjs";
import { getTriggeredAbilities } from "../registry.mjs";
import { lingeringTokens, endLingering } from "../lingering.mjs";
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

function walkedCells(doc, movement, { throughOnly }) {
  const passed = movement?.passed?.waypoints ?? [];
  if (!passed.length) return new Set();
  const origin = movement.origin ?? {};
  let steps = doc.getCompleteMovementPath(passed);
  if (throughOnly) steps = steps.slice(0, -1).filter((s) => s.action !== "teleport");
  steps = steps.filter((s) => !(s.x === origin.x && s.y === origin.y));
  return new Set(steps.flatMap((s) => cellsOf(s.x, s.y, s.width ?? doc.width, s.height ?? doc.height)));
}

const overlaps = (t, cells) => cellsOf(t.x, t.y, t.width, t.height).some((c) => cells.has(c));

export function passedThrough(doc, movement) {
  const walked = walkedCells(doc, movement, { throughOnly: true });
  if (!walked.size) return [];
  const defeated = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
  return (doc.parent?.tokens?.contents ?? []).filter((t) => t.id !== doc.id && t.actor && !t.hidden
    && !t.actor.statuses?.has(defeated) && overlaps(t, walked));
}

async function enteredSpaces(doc, movement) {
  const graves = lingeringTokens(doc.parent).filter((t) => t.id !== doc.id);
  if (!graves.length) return;
  const entered = walkedCells(doc, movement, { throughOnly: false });
  for (const grave of graves.filter((t) => overlaps(t, entered))) {
    const eventContext = { enteredActor: grave.actor, enteredToken: grave };
    if (!collectTriggerMatches("MOVES", doc.actor, doc, null, eventContext).length) continue;
    dbg(`${doc.name} entered the space where ${grave.name} fell`);
    dispatchTriggerEvent({
      event: "MOVES",
      subjectActor: doc.actor,
      subjectToken: doc,
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.EntersSpace", { name: doc.name, target: grave.name }),
      eventContext,
    });
    await endLingering(grave.actor);
  }
}

Hooks.on("updateToken", (doc, _changes, options) => {
  if (!isPrimaryGM()) return;
  if (!game.combat?.started) return;
  if (options?.isUndo || options?.isPaste || window._dsctTeleportActive) return;
  const movement = options?._movement?.[doc.id];
  if (!movement || !doc.actor) return;
  enteredSpaces(doc, movement);
  if (!movesThrough(doc.actor)) return;
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
