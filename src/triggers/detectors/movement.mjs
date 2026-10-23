import { dispatchTriggerEvent, collectTriggerMatches, triggersLive, footprintGap } from "../dispatch.mjs";
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

const watchesArrivals = (actor) => getTriggeredAbilities(actor)
  .some((e) => e.parse?.clauses?.some((c) => c.event === "MOVES" && c.arrives));

async function arrivals(doc, movement) {
  const origin = movement.origin;
  if (!origin) return;
  const watchers = (doc.parent?.tokens?.contents ?? []).filter((t) => t.id !== doc.id && t.actor && watchesArrivals(t.actor));
  if (!watchers.length) return;
  
  const box = (p) => ({ x: p?.x ?? doc.x, y: p?.y ?? doc.y, width: p?.width ?? doc.width, height: p?.height ?? doc.height });
  const start = box(origin);
  const end = box(movement.destination);
  const near = canvas.grid.distance;
  const adjacentBefore = new Set(watchers.filter((t) => footprintGap(t, start) < near).map((t) => t.actor.uuid));
  if (!watchers.some((t) => !adjacentBefore.has(t.actor.uuid) && footprintGap(t, end) < near)) return;
  for (let i = 0; i < 40 && (doc.x !== end.x || doc.y !== end.y); i++) await new Promise((r) => setTimeout(r, 100));
  dbg(`${doc.name} moved adjacent to a creature watching for arrivals`);
  dispatchTriggerEvent({
    event: "MOVES",
    subjectActor: doc.actor,
    subjectToken: doc,
    causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.MovesAdjacent", { name: doc.name }),
    eventContext: { arrived: true, adjacentBefore },
  });
}

const teleported = (doc, changes, options) => foundry.utils.hasProperty(changes, "flags.draw-steel-combat-tools.lastTpMoveId")
  || !!options?._movement?.[doc.id]?.passed?.waypoints?.some((w) => w.action === "teleport");

Hooks.on("updateToken", (doc, _changes, options) => {
  if (!isPrimaryGM()) return;
  if (!triggersLive()) return;
  if (doc.actor && !options?.isPaste && teleported(doc, _changes, options)) {
    dbg(`${doc.name} teleported`);
    dispatchTriggerEvent({
      event: "TELEPORTS",
      subjectActor: doc.actor,
      subjectToken: doc,
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.Teleports", { name: doc.name }),
    });
  }
  if (options?.isUndo || options?.isPaste || window._dsctTeleportActive) return;
  const movement = options?._movement?.[doc.id];
  if (!movement || !doc.actor) return;
  enteredSpaces(doc, movement);
  if (options?.dsMovement || doc.movementAction === "forced") return;
  arrivals(doc, movement);
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
