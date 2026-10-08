import { getSetting, dbg, isPrimaryGM, batchedNotice } from "../../util.mjs";
import { collectTriggerMatches, footprintGap, triggersLive } from "../dispatch.mjs";
import { enqueueLockEntries, queueSocket, asPrimaryGM } from "../queue.mjs";
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

function _fmMatches(event, subjectActor, subjectToken) {
  return collectTriggerMatches(event, subjectActor, subjectToken).filter((m) => {
    if (m.malice) return false;
    if (m.parse?.confidence !== "high" && m.parse?.source !== "manual") return false;
    return !!FM_INTERRUPTS[generateDSID(m.item.name)];
  });
}

Hooks.on("dsct.preForcedMovement", (ctx) => {
  if (!getSetting("fmInterrupts")) return;
  if (!triggersLive()) return;
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
  add(_fmMatches("FORCE_MOVED", targetActor, target.document ?? target), "FmCauseMoved", target.name);
  if (source?.actor && source.actor !== targetActor) {
    add(_fmMatches("FORCE_MOVES", source.actor, source.document ?? source), "FmCauseMover", source.name);
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

  const typeKey = String(ctx.type ?? "push").toLowerCase();
  const typeName = ds.CONFIG?.abilities?.forcedMovement?.[typeKey]?.label
    ?? (typeKey.charAt(0).toUpperCase() + typeKey.slice(1));
  const fmTitle = source
    ? game.i18n.format("DS_TRIGGERS.Queue.FmHeldTitle", { type: typeName, distance: ctx.distance, source: source.name, target: target.name })
    : game.i18n.format("DS_TRIGGERS.Queue.FmHeldTitleNoSource", { type: typeName, distance: ctx.distance, target: target.name });
  const detailParts = [];
  if ((Number(ctx.verticalHeight) || 0) !== 0) detailParts.push(game.i18n.format("DS_TRIGGERS.Queue.FmDetailVertical", { n: ctx.verticalHeight }));
  if ((Number(ctx.fallReduction) || 0) > 0) detailParts.push(game.i18n.format("DS_TRIGGERS.Queue.FmDetailFallReduction", { n: ctx.fallReduction }));
  if (ctx.noFallDamage) detailParts.push(game.i18n.localize("DS_TRIGGERS.Queue.FmDetailNoFallDamage"));
  if (ctx.ignoreStability) detailParts.push(game.i18n.localize("DS_TRIGGERS.Queue.FmDetailIgnoreStability"));
  if (ctx.noCollisionDamage) detailParts.push(game.i18n.localize("DS_TRIGGERS.Queue.FmDetailNoCollision"));
  if (ctx.noMoverCollisionDamage) detailParts.push(game.i18n.localize("DS_TRIGGERS.Queue.FmDetailNoMoverCollision"));
  if (ctx.noObstacleCollisionDamage) detailParts.push(game.i18n.localize("DS_TRIGGERS.Queue.FmDetailNoObstacleCollision"));
  if (ctx.fastMove) detailParts.push(game.i18n.localize("DS_TRIGGERS.Queue.FmDetailFastMove"));

  dbg(`fm lock: ${ctx.type} ${ctx.distance} on ${target.name} held by ${matches.length} triggers`);
  enqueueLockEntries(matches, {
    event: "FM_LOCK",
    causeLabel: game.i18n.format("DS_TRIGGERS.Queue.FmLockCause", { name: target.name }),
    resume: { userId: game.user.id, fmId },
    held: {
      itemUuid: null,
      itemName: fmTitle,
      heldDetail: detailParts.join(" · ") || null,
      fmDistance: Number(ctx.distance) || 0,
      ownerActorUuid: targetActor.uuid,
      ownerName: target.name,
    },
  });
  batchedNotice("FmHeld", target.name);
  return false;
});

function _deltaPayload(deltas) {
  return (deltas ?? []).map((d) => {
    const owner = d.ownerActorUuid ? fromUuidSync(d.ownerActorUuid) : null;
    const tok = owner?.getActiveTokens?.(true, false)?.[0] ?? null;
    return { amount: d.amount, modName: d.modName, ownerName: d.ownerName ?? null, srcTokenId: tok?.id ?? null };
  });
}

async function _onResumeFm(fmId, mods) {
  const pending = _pendingFm.get(fmId);
  if (!pending) return;
  _pendingFm.delete(fmId);

  const before = mods?.deltas ?? [];
  const after = mods?.after ?? [];
  let distance = pending.distance;
  let reduced = false;
  const announce = (d) => {
    distance += d.amount;
    if (d.amount < 0) reduced = true;
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.FmDelta", {
      modName: d.modName, amount: d.amount > 0 ? `+${d.amount}` : String(d.amount),
    }));
  };
  for (const d of before) announce(d);

  
  if (mods?.redirect && distance > 0) {
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.FmRedirected", {
      modName: mods.redirect.modName, owner: mods.redirect.ownerName,
    }));
    const payload = {
      modName: mods.redirect.modName,
      ownerActorUuid: mods.redirect.ownerActorUuid,
      ownerName: mods.redirect.ownerName,
      amount: mods.redirect.amount,
      distance,
      baseDistance: pending.distance,
      carried: _deltaPayload(before),
      after: _deltaPayload(after),
      sourceTokenId: pending.sourceTokenId ?? null,
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

  if (mods?.redirect) {
    ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Queue.FmRedirectStopped", {
      modName: mods.redirect.modName,
    }));
  }

  
  for (const d of after) announce(d);
  const deltas = [...before, ...after];

  
  
  
  if (deltas.length && pending.messageId && game.modules.get(DSTD_ID)?.active
    && game.messages.get(pending.messageId)) {
    const payload = {
      messageId: pending.messageId,
      origTargetUuid: pending.origTargetUuid,
      distance: pending.distance,
      moveBase: pending.moveBase,
      deltas: _deltaPayload(deltas),
      counter: null,
    };
    if (distance <= 0) {
      const reduceDelta = deltas.find((d) => d.amount < 0);
      const srcTok = pending.sourceTokenId ? canvas.tokens.get(pending.sourceTokenId) : null;
      if (reduceDelta && srcTok) {
        const doc = srcTok.document;
        payload.counter = {
          modName: reduceDelta.modName,
          ownerName: pending.targetName ?? "",
          amount: -reduceDelta.amount,
          srcTokenId: pending.targetTokenId ?? null,
          newTarget: {
            tokenUuid: doc.uuid, tokenId: doc.id ?? null, sceneId: doc.parent?.id ?? null,
            actorUuid: srcTok.actor?.uuid ?? null, actorId: srcTok.actor?.id ?? null,
            name: srcTok.name ?? doc.name, tokenImg: doc.texture?.src ?? null, actorImg: srcTok.actor?.img ?? null,
          },
        };
      }
      ui.notifications.warn(game.i18n.localize(reduced ? "DS_TRIGGERS.Queue.FmStoppedCounter" : "DS_TRIGGERS.Queue.FmStopped"));
    }
    asPrimaryGM("applyFmDeltas", payload);
    return;
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
  
  const ownerIsSource = !!payload.sourceTokenId && payload.sourceTokenId === ownerToken.id;
  const eligible = canvas.tokens.placeables.filter((t) =>
    t.actor && !(ownerIsSource && t.id === ownerToken.id)
    && (t.document.width ?? 1) <= maxWidth
    && footprintGap(ownerToken.document, t.document) < 1 * gridDist);
  if (!eligible.length) {
    ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Queue.FmRedirectNoTargets", { modName: payload.modName }));
    return;
  }
  let picked = eligible[0];
  const picker = game.modules.get("draw-steel-ctlib")?.api?.runColoredTokenPicker;
  if (picker) {
    picked = await picker({
      tokens: eligible,
      colorMap: new Map(eligible.map((t) => [t.id, "#d9a63f"])),
      hint: game.i18n.format("DS_TRIGGERS.Queue.FmRedirectPick", { modName: payload.modName }),
    }).catch(() => null);
    if (!picked) return;
  }

  
  
  
  
  
  
  
  const sameTarget = !!origTarget && picked.id === origTarget.id;

  if (payload.messageId && game.modules.get(DSTD_ID)?.active && sameTarget) {
    asPrimaryGM("applyFmDeltas", {
      messageId: payload.messageId,
      origTargetUuid: payload.origTargetUuid,
      moveBase: payload.moveBase,

      
      distance: Number(payload.baseDistance ?? payload.distance) || 0,
      deltas: [...(payload.carried ?? []), {
        amount: Number(payload.amount) || 0,
        modName: payload.modName,
        ownerName: payload.ownerName ?? owner?.name ?? "",
        ownerActorUuid: payload.ownerActorUuid ?? null,
        srcTokenId: ownerToken.id,
        newSourceTokenId: ownerToken.id,
        forcePush: true,
      }, ...(payload.after ?? [])],
    });
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.FmRedirectSameTarget", {
      modName: payload.modName, name: picked.name,
    }));
    return;
  }

  if (payload.messageId && game.modules.get(DSTD_ID)?.active) {
    const doc = picked.document;
    asPrimaryGM("applyFmRedirect", {
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
      carried: payload.carried ?? [],
      after: payload.after ?? [],
      moveBase: payload.moveBase,
    });
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.FmRedirectApplied", {
      modName: payload.modName, name: picked.name ?? doc.name,
    }));
    return;
  }

  
  const trailing = (payload.after ?? []).reduce((n, d) => n + (Number(d.amount) || 0), 0);
  const distance = Math.max(0, (Number(payload.distance) || 0) + (Number(payload.amount) || 0) + trailing);
  await api.forcedMovement({
    type: "Push", distance,
    sourceId: ownerToken.id, targetId: picked.id,
  });
}

function _baseModState(base) {
  return {
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
}

async function _onApplyFmDeltas(payload) {
  if (!isPrimaryGM()) return;
  const message = game.messages.get(payload.messageId);
  if (!message) return;
  const state = foundry.utils.getProperty(message.flags, `${DSTD_ID}.state`);
  if (!state) return;

  const modState = _baseModState(payload.moveBase ?? {});
  const origKey = String(payload.origTargetUuid ?? "").replace(/\./g, "__");
  const origSubKey = `${origKey}:${modState.movement}`;
  const allFm = foundry.utils.getProperty(message.flags, `${DSCT_ID}.dstdFmState`) ?? {};

  
  
  let running = Number(payload.distance) || 0;
  const deltaPills = [];
  for (const d of payload.deltas ?? []) {
    const applied = Math.max(Number(d.amount) || 0, -running);
    running += applied;
    
    
    const changed = d.newSourceTokenId ? { sourceTokenId: d.newSourceTokenId } : {};
    deltaPills.push({
      modState: [{ ...modState, distanceDelta: applied, ...changed }],
      noteName: d.modName, noteDesc: "",
      noteSrc: d.ownerName || null, srcTokenId: d.srcTokenId ?? null,
      dstTrigger: true,
    });
    if (d.forcePush && modState.movement !== "push") {
      deltaPills.push({
        modState: [{ ...modState, movement: "push" }],
        noteName: d.modName, noteDesc: "",
        noteSrc: d.ownerName || null, srcTokenId: d.srcTokenId ?? null,
        dstTrigger: true,
      });
    }
  }

  const origExisting = allFm[origSubKey] ? foundry.utils.deepClone(allFm[origSubKey]) : null;
  const origEntry = origExisting
    ? { ...origExisting, modStack: [...(origExisting.modStack ?? []), ...deltaPills] }
    : { applied: false, undoMsgId: null, modStack: deltaPills };

  const upd = {
    [`flags.${DSTD_ID}.state.updatedAt`]: Date.now(),
    [`flags.${DSCT_ID}.dstdFmState.${origSubKey}`]: origEntry,
  };

  if (payload.counter) {
    const c = payload.counter;
    const targets = [...(state.targets ?? [])];
    const newWasTarget = targets.some((t) => t.tokenUuid === c.newTarget.tokenUuid);
    if (!newWasTarget) targets.push(c.newTarget);
    noteTargetsChange(payload.messageId, targets.map((t) => String(t.tokenUuid ?? t.actorUuid ?? "")));

    const newKey = String(c.newTarget.tokenUuid ?? c.newTarget.actorUuid ?? "").replace(/\./g, "__");
    const newSubKey = `${newKey}:${modState.movement}`;
    const newExisting = allFm[newSubKey] ? foundry.utils.deepClone(allFm[newSubKey]) : null;

    
    const stackDelta = (entry) => (entry?.modStack ?? [])
      .filter((e) => e.enabled !== false)
      .reduce((n, e) => n + (Number(e.modState?.[0]?.distanceDelta) || 0), 0);
    const abilityBase = (Number(payload.distance) || 0) - stackDelta(origExisting);
    const counterDelta = (Number(c.amount) || 0) - abilityBase - stackDelta(newExisting);

    const counterStack = [{
      modState: [{ ...modState, distanceDelta: counterDelta, sourceTokenId: c.srcTokenId ?? null }],
      noteName: c.modName, noteDesc: "",
      noteSrc: c.ownerName || null, srcTokenId: c.srcTokenId ?? null,
      dstRedirect: true,
    }];
    if (modState.movement !== "push") {
      counterStack.push({
        modState: [{ ...modState, movement: "push" }],
        noteName: c.modName, noteDesc: "",
        noteSrc: c.ownerName || null, srcTokenId: c.srcTokenId ?? null,
        dstRedirect: true,
      });
    }
    const newEntry = newExisting
      ? { ...newExisting, modStack: [...(newExisting.modStack ?? []), ...counterStack] }
      : { applied: false, undoMsgId: null, modStack: counterStack };

    origEntry.redirected = {
      modName: c.modName,
      newTargetKey: newKey,
      newTargetUuid: c.newTarget.tokenUuid ?? null,
      newTargetName: c.newTarget.name ?? "",
      newWasTarget,
    };
    upd[`flags.${DSTD_ID}.state.targets`] = targets;
    upd[`flags.${DSCT_ID}.dstdFmState.${newSubKey}`] = newEntry;
  }

  await message.update(upd);
}

async function _onApplyFmRedirect(payload) {
  if (!isPrimaryGM()) return;
  const message = game.messages.get(payload.messageId);
  if (!message) return;
  const state = foundry.utils.getProperty(message.flags, `${DSTD_ID}.state`);
  if (!state) return;
  const targets = [...(state.targets ?? [])];
  const newWasTarget = targets.some((t) => t.tokenUuid === payload.newTarget.tokenUuid);
  if (!newWasTarget) targets.push(payload.newTarget);
  noteTargetsChange(payload.messageId, targets.map((t) => String(t.tokenUuid ?? t.actorUuid ?? "")));

  const modState = _baseModState(payload.moveBase ?? {});
  const newTargetKey = String(payload.newTarget.tokenUuid ?? payload.newTarget.actorUuid ?? "").replace(/\./g, "__");
  const origTargetKey = String(payload.origTargetUuid ?? "").replace(/\./g, "__");
  const subKey = `${newTargetKey}:${modState.movement}`;
  const origSubKey = `${origTargetKey}:${modState.movement}`;
  const allFm = foundry.utils.getProperty(message.flags, `${DSCT_ID}.dstdFmState`) ?? {};

  
  const inherited = (allFm[origSubKey]?.modStack ?? [])
    .filter((e) => e.enabled !== false)
    .map((e) => foundry.utils.deepClone(e));

  
  const modStack = inherited.concat((payload.carried ?? []).map((d) => ({
    modState: [{ ...modState, distanceDelta: Number(d.amount) || 0 }],
    noteName: d.modName, noteDesc: "",
    noteSrc: d.ownerName || null, srcTokenId: d.srcTokenId ?? null,
    dstTrigger: true,
  })));
  modStack.push({
    modState: [{ ...modState, distanceDelta: Number(payload.amount) || 0, sourceTokenId: payload.srcTokenId ?? null }],
    noteName: payload.modName, noteDesc: "",
    noteSrc: payload.ownerName || null, srcTokenId: payload.srcTokenId ?? null,
    dstRedirect: true,
  });
  
  for (const d of payload.after ?? []) {
    modStack.push({
      modState: [{ ...modState, distanceDelta: Number(d.amount) || 0 }],
      noteName: d.modName, noteDesc: "",
      noteSrc: d.ownerName || null, srcTokenId: d.srcTokenId ?? null,
      dstTrigger: true,
    });
  }
  if (modState.movement !== "push") {
    modStack.push({
      modState: [{ ...modState, movement: "push" }],
      noteName: payload.modName, noteDesc: "",
      noteSrc: payload.ownerName || null, srcTokenId: payload.srcTokenId ?? null,
      dstRedirect: true,
    });
  }
  const existing = allFm[subKey] ? foundry.utils.deepClone(allFm[subKey]) : null;
  const newEntry = existing
    ? { ...existing, modStack: [...(existing.modStack ?? []), ...modStack] }
    : { applied: false, undoMsgId: null, modStack };

  await message.update({
    [`flags.${DSTD_ID}.state.targets`]: targets,
    [`flags.${DSTD_ID}.state.updatedAt`]: Date.now(),
    [`flags.${DSCT_ID}.dstdFmState.${subKey}`]: newEntry,
    [`flags.${DSCT_ID}.dstdFmState.${origSubKey}.redirected`]: {
      modName: payload.modName,
      newTargetKey,
      newTargetUuid: payload.newTarget.tokenUuid ?? null,
      newTargetName: payload.newTarget.name ?? "",
      newWasTarget,
    },
  });
}

Hooks.once("ready", () => {
  const s = queueSocket();
  s?.register("resumeForcedMove", _onResumeFm);
  s?.register("driveFmRedirect", _onDriveFmRedirect);
  s?.register("applyFmRedirect", _onApplyFmRedirect);
  s?.register("applyFmDeltas", _onApplyFmDeltas);
});
