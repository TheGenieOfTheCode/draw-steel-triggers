import { MODULE_ID, getSetting, dbg } from "../../util.mjs";
import { activationsLeft, collectTriggerMatches, isMinionActor, noteOncePerRoundUse } from "../dispatch.mjs";
import { enqueueLockEntries, queueSocket } from "../queue.mjs";
import { getParsedTrigger } from "../registry.mjs";
import { villainMatches } from "../villain-actions.mjs";

const _skipStartOnce = new Set();
let _startedViaHesitation = null;

let _bonusTurn = null;

function _lockMatches(event, combatant) {
  const actor = combatant?.actor;
  if (!actor) return [];
  return collectTriggerMatches(event, actor, combatant.token ?? null).filter((m) =>
    m.clause?.turnLock && (m.parse?.confidence === "high" || m.parse?.source === "manual"));
}

Hooks.on("updateCombat", (combat, changed) => {
  if (!_bonusTurn || combat.id !== _bonusTurn.combatId) return;
  if (!("turn" in changed) && !("round" in changed)) return;
  if (combat.combatant?.id === _bonusTurn.takerId) return;
  const { takerId, initiative } = _bonusTurn;
  _bonusTurn = null;
  const taker = combat.combatants.get(takerId);
  if (!taker || !(initiative > 0) || taker.initiative > 0) return;
  dbg(`bonus turn over: ${taker.name}'s activation handed back`);
  taker.update({ initiative }).catch(() => {});
});

const HOLD_WINDOW_MS = 3000;
let _heldGroup = null;
let _passedStart = null;

function _holdTurn(combat, prev, next, { turn, direction = 1, group = null, skipStart = false }) {
  const matches = [];
  const locks = getSetting("turnInterrupts");
  if (prev?.actor && locks) {
    if (prev.id !== _startedViaHesitation) {
      for (const m of _lockMatches("TURN_END", prev)) {
        m._lockEvent = "TURN_END";
        m._causeLabel = game.i18n.format("DS_TRIGGERS.Queue.Cause.TURN_END_LOCK", { name: prev.name });
        matches.push(m);
      }
    }
    _startedViaHesitation = null;
  }
  if (next?.actor && !skipStart && locks) {
    for (const m of _lockMatches("TURN_START", next)) {
      if (matches.some((x) => x.item.uuid === m.item.uuid)) continue;
      m._lockEvent = "TURN_START";
      m._causeLabel = game.i18n.format("DS_TRIGGERS.Queue.Cause.TURN_START_LOCK", { name: next.name });
      matches.push(m);
    }
  }
  for (const m of villainMatches(combat, prev)) {
    if (!matches.some((x) => x.item.uuid === m.item.uuid)) matches.push(m);
  }
  if (!matches.length) return false;

  const heldName = next?.name ?? prev?.name ?? "";
  const heldActor = next?.actor ?? prev?.actor;
  dbg(`turn lock: ${heldName} held by ${matches.length} triggers${group ? ` (squad ${group.name})` : ""}`);
  if (group) _heldGroup = { groupId: group.id, until: Date.now() + HOLD_WINDOW_MS };
  enqueueLockEntries(matches, {
    event: "TURN_LOCK",
    causeLabel: game.i18n.format("DS_TRIGGERS.Queue.TurnLockCause", { name: heldName }),
    resume: {
      kind: "turn",
      combatId: combat.id,
      turn: turn ?? null,
      direction,
      prevId: prev?.id ?? null,
      nextId: next?.id ?? null,
      nextInitiative: next?.initiative ?? null,
      groupId: group?.id ?? null,
      groupInitiative: group?.initiative ?? null,
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
  return true;
}

const _groupHeld = (group) => !!group && _heldGroup?.groupId === group.id && Date.now() < _heldGroup.until;

Hooks.on("preUpdateCombat", (combat, changed, options, userId) => {

  if (("round" in changed) && changed.round !== combat.round) {
    _startedViaHesitation = null;
    _skipStartOnce.clear();
    _heldGroup = null;
    return;
  }
  if (!("turn" in changed)) return;
  if (!(getSetting("turnInterrupts") || getSetting("offerVillainActions")) || !combat.started) return;
  if (options.dstTurnResume) return;
  if (userId !== game.user.id) return;

  const prev = combat.turn != null ? combat.combatant : null;
  const next = changed.turn != null ? combat.turns[changed.turn] : null;
  if (prev && next && prev.id === next.id) return;
  if (_groupHeld(next?.group)) return false;

  const skipStart = !!next && _skipStartOnce.delete(next.id);
  if (skipStart) _passedStart = { id: next.id, until: Date.now() + HOLD_WINDOW_MS };
  if (_holdTurn(combat, prev, next, { turn: changed.turn, direction: options.direction ?? 1, group: next?.group ?? null, skipStart })) return false;
});

Hooks.on("preUpdateCombatantGroup", (group, changed, options, userId) => {
  if (!("initiative" in changed)) return;
  const combat = group.parent;
  if (!(getSetting("turnInterrupts") || getSetting("offerVillainActions")) || !combat?.started) return;
  if (options.dstTurnResume) return;
  if (userId !== game.user.id) return;
  if (!(changed.initiative < (Number(group.initiative) || 0))) return;
  if (_groupHeld(group)) return false;

  const next = [...group.members].find((c) => c.initiative) ?? null;
  if (!next) return;
  if (_passedStart?.id === next.id && Date.now() < _passedStart.until) return;
  const prev = combat.turn != null ? combat.combatant : null;
  if (prev && prev.id === next.id) return;
  const turn = combat.turns.findIndex((c) => c === next);
  if (_holdTurn(combat, prev, next, { turn, group, skipStart: _skipStartOnce.has(next.id) })) return false;
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
    const clause = getParsedTrigger(item)?.clauses?.find((c) => c.turnLock) ?? {};
    const pick = { taker: null, viaHesitation: false, squad: !!clause.squadTurn, bonus: !!clause.bonusTurn, manual: !!clause.manualTurn, item, used: u };
    if (clause.manualTurn) return pick;
    
    
    if (dsid === "hesitation-is-weakness" || clause.squadTurn || clause.bonusTurn || item?.system?.target?.type === "self") {
      const taker = _combatantOfActor(combat, u.ownerActorUuid);
      if (taker) return { ...pick, taker, viaHesitation: dsid === "hesitation-is-weakness" };
      continue;
    }
    const targets = await _useTargets(u.itemUuid);
    const tokenTargets = targets.map((doc) => combat.combatants.find((c) => c.tokenId === doc.id)).filter(Boolean);
    if (tokenTargets.length === 1) return { ...pick, taker: tokenTargets[0] };
    return pick;
  }
  return null;
}

function _squadRefusal(taker, u, others) {
  const names = game.i18n.getListFormatter().format(others.map((c) => c.name));
  ChatMessage.create({
    content: `<p>${game.i18n.format("DS_TRIGGERS.Queue.SquadTurnRefused", { owner: u.ownerName, ability: u.itemName, names })}</p>`,
    whisper: game.users.filter((user) => user.isGM).map((user) => user.id),
    speaker: { alias: game.i18n.localize("DS_TRIGGERS.Reminder.Speaker") },
  }).catch(() => {});
}

async function _onResumeTurn(resume, used = []) {
  const combat = game.combats.get(resume.combatId);
  if (!combat) return;
  const next = resume.nextId ? combat.combatants.get(resume.nextId) : null;
  const prev = resume.prevId ? combat.combatants.get(resume.prevId) : null;

  _heldGroup = null;
  const heldGroup = resume.groupId ? combat.groups?.get(resume.groupId) ?? null : null;
  if (!used.length) {
    dbg(`turn lock released: ${next?.name ?? prev?.name ?? "turn"} continues`);
    await combat.update({ turn: resume.turn }, { direction: resume.direction ?? 1, dstTurnResume: true });
    
    if (heldGroup) await heldGroup.update({ initiative: Math.max(0, (Number(resume.groupInitiative) || 1) - 1) }, { dstTurnResume: true });
    return;
  }

  if (next) {
    
    if (resume.nextInitiative != null && !resume.groupId) await next.update({ initiative: resume.nextInitiative + 1 });
    _skipStartOnce.add(next.id);
  }
  const pick = await _turnTaker(combat, used);
  const putBack = next?.name ?? "";
  const u = pick?.used ?? used[0];
  
  const standDown = async (key, extra = {}) => {
    
    
    if (next && !pick?.manual) _skipStartOnce.delete(next.id);
    ui.notifications.warn(game.i18n.format(key, { owner: u.ownerName, ability: u.itemName, name: putBack, ...extra }));
    if (!next) await combat.update({ turn: resume.turn }, { direction: resume.direction ?? 1, dstTurnResume: true });
  };
  if (!pick?.taker) return standDown(pick?.manual ? "DS_TRIGGERS.Queue.TurnPutBack" : "DS_TRIGGERS.Queue.TurnTakenManual");
  const { taker, viaHesitation, squad, bonus, item } = pick;
  if (!bonus && !(activationsLeft(taker) > 0)) return standDown("DS_TRIGGERS.Queue.TurnTakenActed", { taker: taker.name });

  if (squad) {
    const group = taker.group;
    const others = group ? [...group.members].filter((m) => m !== taker && m.actor && !isMinionActor(m.actor)) : [];
    if (!group || others.length) {
      if (others.length) _squadRefusal(taker, u, others);
      return standDown("DS_TRIGGERS.Queue.TurnTakenManual");
    }
    const turn = combat.turns.findIndex((c) => c === taker);
    dbg(`squad turn taken: ${taker.name}'s squad acts through ${u.itemName}${next ? `, ${next.name}'s turn put back` : ""}`);
    ui.notifications.info(game.i18n.format(next ? "DS_TRIGGERS.Queue.SquadTurnTaken" : "DS_TRIGGERS.Queue.SquadTurnTakenNoNext", {
      owner: u.ownerName, ability: u.itemName, taker: taker.name, name: putBack,
    }));
    
    await combat.update({ turn }, { direction: 1, dstTurnResume: true });
    await group.update({ initiative: Math.max(0, (Number(group.initiative) || 1) - 1) }, { dstTurnResume: true });
    return;
  }

  if (viaHesitation) _startedViaHesitation = taker.id;
  const current = Number(taker.initiative) || 0;
  if (bonus) {
    _bonusTurn = { combatId: combat.id, takerId: taker.id, initiative: current };
    noteOncePerRoundUse(taker.actor, item, combat.round);
  }
  await taker.update({ initiative: Math.max(0, current - 1) });
  const turn = combat.turns.findIndex((c) => c === taker);
  dbg(`turn taken: ${taker.name} acts through ${u.itemName}${bonus ? " (bonus turn)" : ""}${next ? `, ${next.name}'s turn put back` : ""}`);
  const key = bonus ? (next ? "BonusTurnTaken" : "BonusTurnTakenNoNext") : (next ? "TurnTaken" : "TurnTakenNoNext");
  ui.notifications.info(game.i18n.format(`DS_TRIGGERS.Queue.${key}`, {
    owner: u.ownerName, ability: u.itemName, taker: taker.name, name: putBack,
  }));
  await combat.update({ turn }, { direction: 1, dstTurnResume: true });
}

Hooks.once("ready", () => {
  queueSocket()?.register("resumeTurn", _onResumeTurn);
});
