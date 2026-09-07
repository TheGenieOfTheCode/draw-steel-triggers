import { getSetting, dbg } from "../../util.mjs";
import { collectTriggerMatches, footprintGap } from "../dispatch.mjs";
import { enqueueLockEntries, queueSocket } from "../queue.mjs";
import { generateDSID } from "../../parser/trigger-parser.mjs";
import { noteTargetsChange } from "./resolution.mjs";

const DSCT_ID = "draw-steel-combat-tools";
const DSTD_ID = "draw-steel-target-damage";

const FM_INTERRUPTS = {
  "lines-of-force": { mode: "redirect", char: "might" },
  "repel": { mode: "reduce", char: "reason" },
  "explosive-assistance": { mode: "boost", char: "reason" },
};

const _pendingFm = new Map();

function _pruneFm() {
  const now = Date.now();
  for (const [id, rec] of _pendingFm) {
    if (now - rec.at > 300000) _pendingFm.delete(id);
  }
}

function _fmMatches(event, subjectActor, subjectToken, sourceActor) {
  return collectTriggerMatches(event, subjectActor, subjectToken).filter((m) => {
    if (m.malice) return false;
    if (m.actor === sourceActor) return false;
    if (m.parse?.confidence !== "high" && m.parse?.source !== "manual") return false;
    return !!FM_INTERRUPTS[generateDSID(m.item.name)];
  });
}

Hooks.on("dsct.preForcedMovement", (ctx) => {
  if (!getSetting("fmInterrupts")) return;
  if (!game.combat?.started) return;
  const target = ctx.target;
  const source = ctx.source;
  const targetActor = target?.actor;
  if (!targetActor) return;

  const matches = [];
  const seen = new Set();
  const add = (list, causeKey, causeName) => {
    for (const m of list) {
      if (seen.has(m.item.uuid)) continue;
      seen.add(m.item.uuid);
      const eff = FM_INTERRUPTS[generateDSID(m.item.name)];
      m._fmMode = eff.mode;
      m._fmChar = eff.char;
      m._causeLabel = game.i18n.format(`DS_TRIGGERS.Queue.${causeKey}`, { name: causeName });
      matches.push(m);
    }
  };
  add(_fmMatches("FORCE_MOVED", targetActor, target.document ?? target, source?.actor ?? null), "FmCauseMoved", target.name);
  if (source?.actor && source.actor !== targetActor) {
    add(_fmMatches("FORCE_MOVES", source.actor, source.document ?? source, null), "FmCauseMover", source.name);
  }
  if (!matches.length) return;

  const fmId = foundry.utils.randomID();
  _pendingFm.set(fmId, {
    resume: ctx.resume, type: ctx.type, distance: Number(ctx.distance) || 0,
    targetTokenId: target.id, targetName: target.name,
    origTargetUuid: (target.document ?? target)?.uuid ?? null,
    sourceTokenId: source?.id ?? null, at: Date.now(),
    messageId: ctx.messageId ?? null,
    moveBase: {
      movement: String(ctx.type ?? "push").toLowerCase(),
      vertical: (Number(ctx.verticalHeight) || 0) !== 0,
      verticalDistance: "",
      fallReduction: Number(ctx.fallReduction) || 0,
      noFallDamage: !!ctx.noFallDamage,
      noCollisionDamage: !!ctx.noCollisionDamage,
      noMoverCollisionDamage: !!ctx.noMoverCollisionDamage,
      noObstacleCollisionDamage: !!ctx.noObstacleCollisionDamage,
      ignoreStability: !!ctx.ignoreStability,
      fastMove: !!ctx.fastMove,
    },
  });
  _pruneFm();

  dbg(`fm lock: ${ctx.type} ${ctx.distance} on ${target.name} held by ${matches.length} triggers`);
  enqueueLockEntries(matches, {
    event: "FM_LOCK",
    causeLabel: game.i18n.format("DS_TRIGGERS.Queue.FmLockCause", { name: target.name }),
    resume: { userId: game.user.id, fmId },
    held: {
      itemUuid: null,
      itemName: game.i18n.format("DS_TRIGGERS.Queue.FmHeldEntry", { name: target.name }),
      ownerActorUuid: targetActor.uuid,
      ownerName: target.name,
    },
  });
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.FmHeld", { name: target.name }));
  return false;
});

async function _onResumeFm(fmId, mods) {
  const pending = _pendingFm.get(fmId);
  if (!pending) return;
  _pendingFm.delete(fmId);

  if (mods?.redirect) {
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.FmRedirected", {
      modName: mods.redirect.modName, owner: mods.redirect.ownerName,
    }));
    const payload = {
      modName: mods.redirect.modName,
      ownerActorUuid: mods.redirect.ownerActorUuid,
      ownerName: mods.redirect.ownerName,
      amount: mods.redirect.amount,
      distance: pending.distance,
      origTargetTokenId: pending.targetTokenId,
      origTargetUuid: pending.origTargetUuid,
      messageId: pending.messageId,
      moveBase: pending.moveBase,
    };
    if (mods.redirect.driveUserId && mods.redirect.driveUserId !== game.user.id) {
      queueSocket()?.executeForUsers("driveFmRedirect", [mods.redirect.driveUserId], payload);
    } else {
      _onDriveFmRedirect(payload);
    }
    return;
  }

  let distance = pending.distance;
  let reduced = false;
  for (const d of mods?.deltas ?? []) {
    distance += d.amount;
    if (d.amount < 0) reduced = true;
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.FmDelta", {
      modName: d.modName, amount: d.amount > 0 ? `+${d.amount}` : String(d.amount),
    }));
  }
  if (distance <= 0) {
    ui.notifications.warn(game.i18n.localize(reduced ? "DS_TRIGGERS.Queue.FmStoppedCounter" : "DS_TRIGGERS.Queue.FmStopped"));
    return;
  }
  pending.resume({ distance });
}

async function _onDriveFmRedirect(payload) {
  const api = game.modules.get(DSCT_ID)?.active ? game.modules.get(DSCT_ID)?.api : null;
  const owner = payload.ownerActorUuid ? await fromUuid(payload.ownerActorUuid).catch(() => null) : null;
  const ownerToken = owner?.getActiveTokens?.(true, false)?.[0] ?? null;
  if (!api?.forcedMovement || !ownerToken) {
    ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Queue.FmRedirectManual", { modName: payload.modName }));
    return;
  }
  const origTarget = canvas.tokens.get(payload.origTargetTokenId);
  const maxWidth = origTarget?.document?.width ?? 1;
  const gridDist = canvas.grid.distance || 1;
  const eligible = canvas.tokens.placeables.filter((t) =>
    t.actor && t.id !== ownerToken.id
    && (t.document.width ?? 1) <= maxWidth
    && footprintGap(ownerToken.document, t.document) < 1 * gridDist);
  if (!eligible.length) {
    ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Queue.FmRedirectNoTargets", { modName: payload.modName }));
    return;
  }
  let picked = eligible[0];
  if (api.colorTokenPicker) {
    picked = await api.colorTokenPicker({
      tokens: eligible,
      colorMap: new Map(eligible.map((t) => [t.id, "#d9a63f"])),
      hint: game.i18n.format("DS_TRIGGERS.Queue.FmRedirectPick", { modName: payload.modName }),
    }).catch(() => null);
    if (!picked) return;
  }

  
  
  
  if (payload.messageId && game.modules.get(DSTD_ID)?.active) {
    const doc = picked.document;
    queueSocket()?.executeAsGM("applyFmRedirect", {
      messageId: payload.messageId,
      origTargetUuid: payload.origTargetUuid,
      newTarget: {
        tokenUuid: doc.uuid, tokenId: doc.id ?? null, sceneId: doc.parent?.id ?? null,
        actorUuid: picked.actor?.uuid ?? null, actorId: picked.actor?.id ?? null,
        name: picked.name ?? doc.name, tokenImg: doc.texture?.src ?? null, actorImg: picked.actor?.img ?? null,
      },
      modName: payload.modName,
      ownerName: payload.ownerName ?? owner?.name ?? "",
      srcTokenId: ownerToken.id,
      amount: Number(payload.amount) || 0,
      moveBase: payload.moveBase,
    });
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.FmRedirectApplied", {
      modName: payload.modName, name: picked.name ?? doc.name,
    }));
    return;
  }

  const distance = (Number(payload.distance) || 0) + (Number(payload.amount) || 0);
  api.bypassNextFmGate?.();
  await api.forcedMovement({
    type: "Push", distance,
    sourceId: ownerToken.id, targetId: picked.id,
  });
}

async function _onApplyFmRedirect(payload) {
  if (!game.users.activeGM?.isSelf) return;
  const message = game.messages.get(payload.messageId);
  if (!message) return;
  const state = foundry.utils.getProperty(message.flags, `${DSTD_ID}.state`);
  if (!state) return;
  const targets = (state.targets ?? []).filter((t) =>
    t.tokenUuid !== payload.origTargetUuid && t.actorUuid !== payload.origTargetUuid);
  targets.push(payload.newTarget);
  noteTargetsChange(payload.messageId, targets.map((t) => String(t.tokenUuid ?? t.actorUuid ?? "")));

  const base = payload.moveBase ?? {};
  const modState = {
    distanceDelta: 0,
    movement: base.movement ?? "push",
    vertical: !!base.vertical,
    verticalDistance: base.verticalDistance ?? "",
    fallReduction: Number(base.fallReduction) || 0,
    noFallDamage: !!base.noFallDamage,
    noCollisionDamage: !!base.noCollisionDamage,
    noMoverCollisionDamage: !!base.noMoverCollisionDamage,
    noObstacleCollisionDamage: !!base.noObstacleCollisionDamage,
    ignoreStability: !!base.ignoreStability,
    fastMove: !!base.fastMove,
  };
  const modStack = [{
    modState: [{ ...modState, distanceDelta: Number(payload.amount) || 0, sourceTokenId: payload.srcTokenId ?? null }],
    noteName: payload.modName, noteDesc: "",
    noteSrc: payload.ownerName || null, srcTokenId: payload.srcTokenId ?? null,
  }];
  if (modState.movement !== "push") {
    modStack.push({
      modState: [{ ...modState, movement: "push" }],
      noteName: payload.modName, noteDesc: "",
      noteSrc: payload.ownerName || null, srcTokenId: payload.srcTokenId ?? null,
    });
  }
  const newTargetKey = String(payload.newTarget.tokenUuid ?? payload.newTarget.actorUuid ?? "").replace(/\./g, "__");
  const subKey = `${newTargetKey}:${modState.movement}`;

  await message.update({
    [`flags.${DSTD_ID}.state.targets`]: targets,
    [`flags.${DSTD_ID}.state.updatedAt`]: Date.now(),
    [`flags.${DSCT_ID}.dstdFmState.${subKey}`]: { applied: false, undoMsgId: null, modStack },
  });
}

Hooks.once("ready", () => {
  const s = queueSocket();
  s?.register("resumeForcedMove", _onResumeFm);
  s?.register("driveFmRedirect", _onDriveFmRedirect);
  s?.register("applyFmRedirect", _onApplyFmRedirect);
});
