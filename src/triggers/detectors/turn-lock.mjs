import { MODULE_ID, getSetting, dbg } from "../../util.mjs";
import { collectTriggerMatches } from "../dispatch.mjs";
import { enqueueLockEntries, queueSocket } from "../queue.mjs";
import { getParsedTrigger } from "../registry.mjs";

const _skipStartOnce = new Set();
let _startedViaHesitation = null;

function _lockMatches(event, combatant) {
  const actor = combatant?.actor;
  if (!actor) return [];
  return collectTriggerMatches(event, actor, combatant.token ?? null).filter((m) =>
    m.clause?.turnLock && !m.malice && (m.parse?.confidence === "high" || m.parse?.source === "manual"));
}

Hooks.on("preUpdateCombat", (combat, changed, options, userId) => {
  
  if (("round" in changed) && changed.round !== combat.round) {
    _startedViaHesitation = null;
    _skipStartOnce.clear();
    return;
  }
  if (!("turn" in changed)) return;
  if (!getSetting("turnInterrupts") || !combat.started) return;
  if (options.dstTurnResume) return;
  if (userId !== game.user.id) return;

  const prev = combat.turn != null ? combat.combatant : null;
  const next = changed.turn != null ? combat.turns[changed.turn] : null;
  if (prev && next && prev.id === next.id) return;

  const matches = [];
  if (prev?.actor) {
    if (prev.id !== _startedViaHesitation) {
      for (const m of _lockMatches("TURN_END", prev)) {
        m._lockEvent = "TURN_END";
        m._causeLabel = game.i18n.format("DS_TRIGGERS.Queue.Cause.TURN_END_LOCK", { name: prev.name });
        matches.push(m);
      }
    }
    _startedViaHesitation = null;
  }
  if (next?.actor && !_skipStartOnce.delete(next.id)) {
    for (const m of _lockMatches("TURN_START", next)) {
      if (matches.some((x) => x.item.uuid === m.item.uuid)) continue;
      m._lockEvent = "TURN_START";
      m._causeLabel = game.i18n.format("DS_TRIGGERS.Queue.Cause.TURN_START_LOCK", { name: next.name });
      matches.push(m);
    }
  }
  if (!matches.length) return;

  const heldName = next?.name ?? prev?.name ?? "";
  const heldActor = next?.actor ?? prev?.actor;
  dbg(`turn lock: ${heldName} held by ${matches.length} triggers`);
  enqueueLockEntries(matches, {
    event: "TURN_LOCK",
    causeLabel: game.i18n.format("DS_TRIGGERS.Queue.TurnLockCause", { name: heldName }),
    resume: {
      kind: "turn",
      combatId: combat.id,
      turn: changed.turn ?? null,
      direction: options.direction ?? 1,
      prevId: prev?.id ?? null,
      nextId: next?.id ?? null,
      nextInitiative: next?.initiative ?? null,
    },
    held: {
      itemUuid: null,
      itemName: next
        ? game.i18n.format("DS_TRIGGERS.Queue.TurnHeldTitle", { name: next.name })
        : game.i18n.format("DS_TRIGGERS.Queue.TurnEndHeldTitle", { name: prev.name }),
      ownerActorUuid: heldActor.uuid,
      ownerName: heldName,
    },
  });
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.TurnHeld", { name: heldName }));
  return false;
});

function _combatantOfActor(combat, actorUuid) {
  const actor = actorUuid ? fromUuidSync(actorUuid) : null;
  return actor ? combat.combatants.find((c) => c.actor === actor) ?? null : null;
}

function _latestUseMessage(itemUuid) {
  for (let i = game.messages.contents.length - 1; i >= 0; i--) {
    const message = game.messages.contents[i];
    const part = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
    if (part?.abilityUuid === itemUuid) return message;
  }
  return null;
}

Hooks.on("createChatMessage", (message, options, userId) => {
  if (userId !== game.user.id) return;
  const part = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  const item = part?.abilityUuid ? fromUuidSync(part.abilityUuid) : null;
  if (!item?.system) return;
  const parse = getParsedTrigger(item);
  if (!parse?.clauses?.some((c) => c.turnLock)) return;
  const targets = [...game.user.targets].map((t) => t.document.uuid);
  message.setFlag(MODULE_ID, "useTargets", targets).catch(() => {});
});

async function _useTargets(itemUuid) {
  const message = _latestUseMessage(itemUuid);
  if (!message) return [];
  for (let tries = 0; tries < 10; tries++) {
    const stamped = message.getFlag(MODULE_ID, "useTargets");
    if (Array.isArray(stamped)) return stamped.map((uuid) => fromUuidSync(uuid)).filter(Boolean);
    const state = message.getFlag("draw-steel-target-damage", "state");
    if (state?.targets?.length) {
      return state.targets.map((t) => (t.tokenUuid ? fromUuidSync(t.tokenUuid) : null)).filter(Boolean);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return [];
}

async function _turnTaker(combat, used) {
  for (const u of used) {
    const item = u.itemUuid ? fromUuidSync(u.itemUuid) : null;
    const dsid = item?.system?._dsid ?? item?.dsid ?? "";
    if (dsid === "hesitation-is-weakness") {
      const taker = _combatantOfActor(combat, u.ownerActorUuid);
      if (taker) return { taker, viaHesitation: true, used: u };
      continue;
    }
    const targets = await _useTargets(u.itemUuid);
    const tokenTargets = targets.map((doc) => combat.combatants.find((c) => c.tokenId === doc.id)).filter(Boolean);
    if (tokenTargets.length === 1) return { taker: tokenTargets[0], viaHesitation: false, used: u };
    if (!tokenTargets.length && item?.system?.target?.type === "self") {
      const taker = _combatantOfActor(combat, u.ownerActorUuid);
      if (taker) return { taker, viaHesitation: false, used: u };
    }
    return { taker: null, viaHesitation: false, used: u };
  }
  return null;
}

async function _onResumeTurn(resume, used = []) {
  const combat = game.combats.get(resume.combatId);
  if (!combat) return;
  const next = resume.nextId ? combat.combatants.get(resume.nextId) : null;
  const prev = resume.prevId ? combat.combatants.get(resume.prevId) : null;

  if (!used.length) {
    dbg(`turn lock released: ${next?.name ?? prev?.name ?? "turn"} continues`);
    await combat.update({ turn: resume.turn }, { direction: resume.direction ?? 1, dstTurnResume: true });
    return;
  }

  if (next && resume.nextInitiative != null) {
    await next.update({ initiative: resume.nextInitiative + 1 });
    _skipStartOnce.add(next.id);
  }
  const pick = await _turnTaker(combat, used);
  const putBack = next?.name ?? "";
  if (!pick?.taker) {
    ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Queue.TurnTakenManual", {
      owner: pick?.used?.ownerName ?? used[0].ownerName, ability: pick?.used?.itemName ?? used[0].itemName, name: putBack,
    }));
    if (!next) await combat.update({ turn: resume.turn }, { direction: resume.direction ?? 1, dstTurnResume: true });
    return;
  }
  const { taker, viaHesitation, used: u } = pick;
  if (viaHesitation) _startedViaHesitation = taker.id;
  const current = Number(taker.initiative) || 0;
  await taker.update({ initiative: Math.max(0, current - 1) });
  const turn = combat.turns.findIndex((c) => c === taker);
  dbg(`turn taken: ${taker.name} acts through ${u.itemName}${next ? `, ${next.name}'s turn put back` : ""}`);
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.TurnTaken", {
    owner: u.ownerName, ability: u.itemName, taker: taker.name, name: putBack,
  }));
  await combat.update({ turn }, { direction: 1, dstTurnResume: true });
}

Hooks.once("ready", () => {
  queueSocket()?.register("resumeTurn", _onResumeTurn);
});
