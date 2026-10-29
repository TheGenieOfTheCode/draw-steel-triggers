import { getSetting, dbg, isPrimaryGM, batchedNotice } from "../../util.mjs";
import { collectTriggerMatches, dispatchTriggerEvent, footprintGap, triggersLive } from "../dispatch.mjs";
import { enqueueLockEntries, queueSocket, asPrimaryGM } from "../queue.mjs";
import { noteTargetsChange } from "./resolution.mjs";
import { autoApplies } from "../auto-use.mjs";
import { setTip, tip } from "../../ui/tips.mjs";

const DSCT_ID = "draw-steel-combat-tools";
const DSTD_ID = "draw-steel-target-damage";

const OPTIONAL = /\b(?:you|they) (?:can|may)(?!['’]t)\b/i;

const _pendingFm = new Map();
const _resolvedOnCard = new Map();
const lineId = (m) => `${m.item.uuid}#${m.item.featureLine?.key ?? ""}`;
const cardKey = (messageId, targetUuid) => `${messageId}|${targetUuid}`;

function _pruneFm() {
  const now = Date.now();
  for (const [id, rec] of _pendingFm) {
    if (now - rec.at > 300000) _pendingFm.delete(id);
  }
  for (const [k, rec] of _resolvedOnCard) {
    if (now - rec.at > 1800000) _resolvedOnCard.delete(k);
  }
}

const fmTypeOf = (type) => String(type ?? "").toLowerCase().replace(/^vertical\s*/, "") || null;

function _fmMatches(event, subjectActor, subjectToken, eventContext) {
  return collectTriggerMatches(event, subjectActor, subjectToken, null, eventContext).filter((m) =>
    !m.malice && !!m.clause?.fmMod && (m.parse?.confidence === "high" || m.parse?.source === "manual"));
}

const passive = (m) => !!m.item.featureLine && !m.item.featureLine.action
  && !OPTIONAL.test(String(m.item.featureLine.effect ?? "").split(/(?<=[.!?])\s+/)[0])
  && !["vertical", "redirect"].includes(m.clause.fmMod.mode);

function _modAmount(mod, actor) {
  if (mod.amount != null) return Number(mod.amount) || 0;
  return Math.max(0, Number(actor?.system?.characteristics?.[mod.char]?.value ?? 0));
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);

function _applyPassive(ctx, m, applied) {
  const mod = m.clause.fmMod;
  const n = _modAmount(mod, m.actor);
  const tell = (change) => ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.FmChange", { modName: m.item.name, change }));
  if ((mod.mode === "boost" || mod.mode === "reduce") && n > 0) {
    const before = Number(ctx.distance) || 0;
    ctx.distance = Math.max(0, before + (mod.mode === "reduce" ? -n : n));
    applied.push({ amount: ctx.distance - before, modName: m.item.name, ownerActorUuid: m.actor?.uuid ?? null, ownerName: m.actor?.name ?? "" });
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.FmDelta", { modName: m.item.name, amount: `${mod.mode === "reduce" ? "-" : "+"}${n}` }));
  } else if (mod.mode === "objectDamage" && n > 0) {
    ctx.bonusObjectDmg = (Number(ctx.bonusObjectDmg) || 0) + n;
    tell(game.i18n.format("DS_TRIGGERS.Queue.FmObjectDamage", { n }));
  } else if ((mod.mode === "slide" || mod.mode === "pull") && fmTypeOf(ctx.type) === "push") {
    ctx.type = String(ctx.type).replace(/push/i, (w) => (w[0] === "P" ? cap(mod.mode) : mod.mode));
    applied.push({ amount: 0, movement: mod.mode, modName: m.item.name, ownerActorUuid: m.actor?.uuid ?? null, ownerName: m.actor?.name ?? "" });
    tell(game.i18n.localize(mod.mode === "pull" ? "DS_TRIGGERS.Queue.FmToPull" : "DS_TRIGGERS.Queue.FmToSlide"));
  }
}

Hooks.on("dsct.preForcedMovement", (ctx) => {
  if (!triggersLive()) return;
  const target = ctx.target;
  const source = ctx.source;
  const targetActor = target?.actor;
  if (!targetActor) return;

  const parts = ctx.messageId ? game.messages.get(ctx.messageId)?.system?.parts?.contents ?? [] : [];
  const use = parts.find((p) => p.type === "abilityUse") ?? null;
  
  const fromPowerRoll = ctx.origin ? ctx.origin === "powerRoll"
    : parts.some((p) => (p.rolls ?? []).some((r) => r?.constructor?.name === "PowerRoll"));
  const eventContext = {
    preMove: true, fmType: fmTypeOf(ctx.type), keywords: ctx.keywords ?? [], fromPowerRoll,
    ability: use?.abilityUuid ? fromUuidSync(use.abilityUuid) : null,
    victimActor: targetActor, victimToken: target.document ?? target,
    dealerActor: source?.actor ?? null, dealerToken: source?.document ?? source ?? null,
  };
  const found = [];
  const seen = new Set();
  
  const done = ctx.messageId ? _resolvedOnCard.get(cardKey(ctx.messageId, (target.document ?? target)?.uuid))?.ids : null;
  const add = (list, causeKey, causeName) => {
    for (const m of list) {
      const id = lineId(m);
      if (seen.has(id) || done?.has(id)) continue;
      seen.add(id);
      m._causeLabel = game.i18n.format(`DS_TRIGGERS.Queue.${causeKey}`, { name: causeName });
      found.push(m);
    }
  };
  add(_fmMatches("FORCE_MOVED", targetActor, target.document ?? target, eventContext), "FmCauseMoved", target.name);
  if (source?.actor && source.actor !== targetActor) {
    add(_fmMatches("FORCE_MOVES", source.actor, source.document ?? source, eventContext), "FmCauseMover", source.name);
  }
  const baseDistance = Number(ctx.distance) || 0;
  const baseType = ctx.type;
  const passiveApplied = [];
  
  const applyNow = (m) => passive(m) && (!getSetting("fmInterrupts") || autoApplies({ mandatory: true, line: m.item.featureLine }));
  for (const m of found.filter(applyNow)) _applyPassive(ctx, m, passiveApplied);

  if (!getSetting("fmInterrupts")) return;
  const matches = found.filter((m) => !applyNow(m));
  for (const m of matches) {
    const mod = m.clause.fmMod;
    m._fmMode = mod.mode;
    m._fmChar = mod.char ?? null;
    m._fmAmount = mod.amount ?? null;
    m._fmPerSurge = mod.perSurge ?? null;
    m._fmCanPush = !!mod.canPush;
    m._fmTargetUuid = (target.document ?? target)?.uuid ?? null;
  }
  if (!matches.length) return;

  const fmId = foundry.utils.randomID();
  _pendingFm.set(fmId, {
    resume: ctx.resume, type: ctx.type, distance: Number(ctx.distance) || 0, bonusObjectDmg: Number(ctx.bonusObjectDmg) || 0,
    targetTokenId: target.id, targetName: target.name,
    origTargetUuid: (target.document ?? target)?.uuid ?? null,
    sourceTokenId: source?.id ?? null, at: Date.now(),
    messageId: ctx.messageId ?? null,
    fmKey: ctx.fmKey ?? null,
    origin: ctx.origin ?? null,
    baseDistance, baseType, passiveApplied,
    lineIds: found.map(lineId),
    moveBase: {
      movement: String(baseType ?? "push").toLowerCase(),
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

  let heldAt = null;
  if (ctx.messageId) {
    const origKey = String((target.document ?? target)?.uuid ?? "").replace(/\./g, "__");
    const rowKey = fmSubKey(ctx.fmKey ?? null, origKey, origKey, String(baseType ?? "push").toLowerCase());
    _pendingFm.get(fmId).rowKey = rowKey;
    heldAt = { messageId: ctx.messageId, rowKey };
    asPrimaryGM("markFmRowHeld", ctx.messageId, rowKey, true);
  }
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
      heldAt,
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
  let handedOff = false;
  try { handedOff = await _resumeFm(fmId, mods); }
  finally { if (!handedOff) asPrimaryGM("fmSettled", fmId); }
}

async function _onDriveFmRedirectSettled(payload) {
  try { await _onDriveFmRedirect(payload); }
  finally { if (payload.fmId) asPrimaryGM("fmSettled", payload.fmId); }
}

async function _resumeFm(fmId, mods) {
  const pending = _pendingFm.get(fmId);
  if (!pending) return false;
  _pendingFm.delete(fmId);
  if (pending.messageId && pending.rowKey) await asPrimaryGM("markFmRowHeld", pending.messageId, pending.rowKey, false);

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
      fmKey: pending.fmKey ?? null,
      moveBase: pending.moveBase,
      fmId,
      origin: pending.origin ?? null,
      type: pending.type ?? null,
      canPush: !!mods.redirect.canPush,
    };
    if (mods.redirect.driveUserId && mods.redirect.driveUserId !== game.user.id) {
      queueSocket()?.executeForUsers("driveFmRedirect", [mods.redirect.driveUserId], payload);
      return true;
    }
    await _onDriveFmRedirect(payload);
    return false;
  }

  if (mods?.redirect) {
    ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Queue.FmRedirectStopped", {
      modName: mods.redirect.modName,
    }));
  }

  
  for (const d of after) announce(d);
  const deltas = [...before, ...after];
  const toSlide = !!mods?.movement && fmTypeOf(pending.type) === "push";
  for (const c of [toSlide ? mods.movement : null, mods?.vertical].filter(Boolean)) {
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.FmChange", {
      modName: c.modName, change: game.i18n.localize(c === mods.vertical ? "DS_TRIGGERS.Queue.FmToVertical" : c.to === "pull" ? "DS_TRIGGERS.Queue.FmToPull" : "DS_TRIGGERS.Queue.FmToSlide"),
    }));
  }
  const shapes = [
    ...(toSlide ? [{ ...mods.movement, amount: 0, movement: mods.movement.to ?? "slide" }] : []),
    ...(mods?.vertical ? [{ ...mods.vertical, amount: 0, vertical: true }] : []),
  ];

  
  if ((deltas.length || shapes.length) && pending.messageId && pending.origin !== "enricher" && game.modules.get(DSTD_ID)?.active
    && game.messages.get(pending.messageId)) {
    
    const passives = pending.passiveApplied ?? [];
    const passiveShapes = passives.filter((d) => d.movement && !toSlide);
    const payload = {
      messageId: pending.messageId,
      origTargetUuid: pending.origTargetUuid,
      fmKey: pending.fmKey ?? null,
      distance: pending.baseDistance ?? pending.distance,
      moveBase: pending.moveBase,
      deltas: [
        ..._deltaPayload(passives.filter((d) => d.amount)),
        ..._deltaPayload(deltas),
        ..._deltaPayload([...passiveShapes, ...shapes]).map((d, i) => { const sh = [...passiveShapes, ...shapes][i]; return { ...d, movement: sh.movement ?? null, vertical: !!sh.vertical }; }),
      ],
      counter: null,
    };
    _resolvedOnCard.set(cardKey(pending.messageId, pending.origTargetUuid), { ids: new Set(pending.lineIds ?? []), at: Date.now() });
    if (distance <= 0) {
      const reduceDelta = deltas.find((d) => d.amount < 0);
      const srcTok = pending.sourceTokenId ? canvas.tokens.get(pending.sourceTokenId) : null;
      if (reduceDelta && srcTok) {
        const doc = srcTok.document;
        const reducer = reduceDelta.ownerActorUuid ? fromUuidSync(reduceDelta.ownerActorUuid) : null;
        payload.counter = {
          modName: reduceDelta.modName,
          ownerName: reduceDelta.ownerName ?? reducer?.name ?? pending.targetName ?? "",
          amount: -reduceDelta.amount,
          srcTokenId: reducer?.getActiveTokens?.(true, false)?.[0]?.id ?? pending.targetTokenId ?? null,
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
    return false;
  }

  if (distance <= 0) {
    ui.notifications.warn(game.i18n.localize(reduced ? "DS_TRIGGERS.Queue.FmStoppedCounter" : "DS_TRIGGERS.Queue.FmStopped"));
    return false;
  }
  const moved = pending.resume({
    distance,
    modifierNotes: deltas.filter((d) => d.amount).map((d) => `${d.amount > 0 ? "+" : ""}${d.amount} ${d.modName}`),
    ...(toSlide ? { type: String(pending.type).replace(/push/i, (w) => (w[0] === "P" ? cap(mods.movement.to) : mods.movement.to)) } : {}),
    ...(mods?.vertical ? { verticalHeight: distance } : {}),
    ...(mods?.objectDamage ? { bonusObjectDmg: pending.bonusObjectDmg + mods.objectDamage } : {}),
  });
  if (pending.messageId && pending.rowKey) {
    Promise.resolve(moved).then(() => asPrimaryGM("markFmRowHeld", pending.messageId, pending.rowKey, false, true)).catch(() => {});
  }
  await Promise.resolve(moved).catch(() => {});
  return false;
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
  const original = fmTypeOf(payload.type) ?? "push";
  const movement = payload.canPush && original !== "push" ? await _pickRedirectMovement(payload.modName, original) : payload.canPush ? "push" : original;

  const ownerIsSource = !!payload.sourceTokenId && payload.sourceTokenId === ownerToken.id;
  const eligible = canvas.tokens.placeables.filter((t) =>
    t.actor && !(ownerIsSource && t.id === ownerToken.id)
    && (t.document.width ?? 1) <= maxWidth
    && footprintGap(ownerToken.document, t.document) < 1 * gridDist);
  if (!eligible.length) {
    ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Queue.FmRedirectNoTargets", { modName: payload.modName }));
    return;
  }
  
  const keep = eligible.find((t) => t.id === origTarget?.id) ?? null;
  let picked = keep ?? eligible[0];
  const picker = game.modules.get("draw-steel-ctlib")?.api?.runColoredTokenPicker;
  if (picker) {
    picked = await picker({
      tokens: eligible,
      colorMap: new Map(eligible.map((t) => [t.id, "#d9a63f"])),
      hint: game.i18n.format(keep ? "DS_TRIGGERS.Queue.FmRedirectPickKeep" : "DS_TRIGGERS.Queue.FmRedirectPick", { modName: payload.modName, name: keep?.name ?? "" }),
      preselect: keep,
    }).catch(() => null) ?? keep;
    if (!picked) return;
  }
  const rowless = payload.origin === "enricher";
  
  const trailing = (payload.after ?? []).reduce((n, d) => n + (Number(d.amount) || 0), 0);
  const cancelled = picked.id === ownerToken.id && movement !== "slide";
  const amount = cancelled ? -((Number(payload.distance) || 0) + trailing) : Number(payload.amount) || 0;

  
  
  
  
  
  
  
  const sameTarget = !!origTarget && picked.id === origTarget.id;

  if (payload.messageId && !rowless && game.modules.get(DSTD_ID)?.active && sameTarget) {
    asPrimaryGM("applyFmDeltas", {
      messageId: payload.messageId,
      origTargetUuid: payload.origTargetUuid,
      fmKey: payload.fmKey ?? null,
      moveBase: payload.moveBase,

      
      distance: Number(payload.baseDistance ?? payload.distance) || 0,
      deltas: [...(payload.carried ?? []), {
        amount,
        modName: payload.modName,
        ownerName: payload.ownerName ?? owner?.name ?? "",
        ownerActorUuid: payload.ownerActorUuid ?? null,
        srcTokenId: ownerToken.id,
        newSourceTokenId: ownerToken.id,
        forcePush: movement === "push",
      }, ...(payload.after ?? [])],
    });
    if (!cancelled) ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.FmRedirectSameTarget", {
      modName: payload.modName, name: picked.name,
    }));
    return;
  }

  if (payload.messageId && !rowless && game.modules.get(DSTD_ID)?.active) {
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
      amount,
      carried: payload.carried ?? [],
      after: payload.after ?? [],
      fmKey: payload.fmKey ?? null,
      moveBase: payload.moveBase,
      movement,
    });
    if (!cancelled) ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.FmRedirectApplied", {
      modName: payload.modName, name: picked.name ?? doc.name,
    }));
    return;
  }

  
  const distance = Math.max(0, (Number(payload.distance) || 0) + amount + trailing);
  
  let fastMove = false;
  try { fastMove = !!game.settings.get(DSCT_ID, "fmAutoForOwnAbilities"); } catch {}
  await api.forcedMovement({
    type: cap(movement), distance, fastMove,
    sourceId: ownerToken.id, targetId: picked.id,
  });
}

async function _pickRedirectMovement(modName, original) {
  const L = (k, data) => game.i18n.format(`DS_TRIGGERS.Queue.${k}`, data ?? {});
  const kind = (m) => game.i18n.localize(`DS_TRIGGERS.Queue.FmKind_${m}`);
  return await foundry.applications.api.DialogV2.wait({
    window: { title: modName },
    content: `<p>${foundry.utils.escapeHTML(L("RedirectMovePick", { modName, kind: kind(original).toLowerCase() }))}</p>`,
    buttons: [
      { action: "original", label: L("RedirectMoveOriginal", { kind: kind(original) }), icon: "fa-solid fa-arrow-right", callback: () => original, default: true },
      { action: "push", label: kind("push"), icon: "fa-solid fa-arrow-right-from-bracket", callback: () => "push" },
    ],
    rejectClose: false,
  }).catch(() => null) ?? original;
}

const fmSubKey = (fmKey, origKey, targetKey, movement) => (fmKey && fmKey.startsWith(`${origKey}:`)
  ? `${targetKey}${fmKey.slice(origKey.length)}` : `${targetKey}:${movement}`);

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
  const origSubKey = fmSubKey(payload.fmKey, origKey, origKey, modState.movement);
  const allFm = foundry.utils.getProperty(message.flags, `${DSCT_ID}.dstdFmState`) ?? {};

  
  
  let running = Number(payload.distance) || 0;
  const deltaPills = [];
  for (const d of payload.deltas ?? []) {
    const applied = Math.max(Number(d.amount) || 0, -running);
    running += applied;
    
    
    const changed = { ...(d.newSourceTokenId ? { sourceTokenId: d.newSourceTokenId } : {}), ...(d.movement ? { movement: d.movement } : {}), ...(d.vertical ? { vertical: true } : {}) };
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
    const newSubKey = fmSubKey(payload.fmKey, origKey, newKey, modState.movement);
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
  const subKey = fmSubKey(payload.fmKey, origTargetKey, newTargetKey, modState.movement);
  const origSubKey = fmSubKey(payload.fmKey, origTargetKey, origTargetKey, modState.movement);
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
  const movement = payload.movement ?? "push";
  if (modState.movement !== movement) {
    modStack.push({
      modState: [{ ...modState, movement }],
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

function _onForcedMovement({ type, targetUuid, sourceUuid, keywords = [], resisted = false }) {
  if (!isPrimaryGM() || !triggersLive()) return;
  const target = targetUuid ? fromUuidSync(targetUuid) : null;
  const source = sourceUuid ? fromUuidSync(sourceUuid) : null;
  if (!target?.actor) return;
  const fmType = String(type ?? "").toLowerCase().replace(/^vertical\s*/, "") || null;
  dispatchTriggerEvent({
    event: "FORCE_MOVED", subjectActor: target.actor, subjectToken: target,
    causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.ForceMoved", { name: target.name }),
    eventContext: { dealerActor: source?.actor ?? null, dealerToken: source ?? null, fmType, keywords, resisted },
  });
  if (!source?.actor || source.actor === target.actor) return;
  dispatchTriggerEvent({
    event: "FORCE_MOVES", subjectActor: source.actor, subjectToken: source,
    causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.ForceMoves", { name: source.name, target: target.name }),
    eventContext: { victimActor: target.actor, victimToken: target, fmType, keywords, resisted },
  });
}

Hooks.on("dsct.forcedMovement", (ctx) => {
  if (!(Number(ctx?.moved) > 0) && !ctx?.resisted) return;
  const uuidOf = (t) => (t?.document ?? t)?.uuid ?? null;
  const payload = { type: ctx.type ?? null, targetUuid: uuidOf(ctx.target), sourceUuid: uuidOf(ctx.source), keywords: [...(ctx.keywords ?? [])], resisted: !!ctx.resisted };
  if (isPrimaryGM()) _onForcedMovement(payload);
  else asPrimaryGM("forcedMovementEvent", payload);
});

Hooks.once("ready", () => {
  const s = queueSocket();
  s?.register("forcedMovementEvent", _onForcedMovement);
  s?.register("resumeForcedMove", _onResumeFm);
  s?.register("driveFmRedirect", _onDriveFmRedirectSettled);
  s?.register("applyFmRedirect", _onApplyFmRedirect);
  s?.register("applyFmDeltas", _onApplyFmDeltas);
  s?.register("markFmRowHeld", _onMarkFmRowHeld);
});

async function _onMarkFmRowHeld(messageId, rowKey, held, applied = false) {
  if (!isPrimaryGM()) return;
  const message = game.messages.get(messageId);
  if (!message || !rowKey) return;
  const path = `flags.${DSCT_ID}.dstdFmState.${rowKey}`;
  if (held) await message.update({ [`${path}.dstHeld`]: true });
  else if (applied) await message.update({ [`${path}.applied`]: true, [`${path}.dstHeld`]: new foundry.data.operators.ForcedDeletion() });
  else if (foundry.utils.getProperty(message, `${path}.dstHeld`)) await message.update({ [`${path}.dstHeld`]: new foundry.data.operators.ForcedDeletion() });
}

async function _clearStaleHeldFmRows() {
  if (!isPrimaryGM() || _pendingFm.size) return;
  for (const message of game.messages.contents) {
    const fm = message.flags?.[DSCT_ID]?.dstdFmState ?? {};
    const updates = {};
    for (const [rowKey, row] of Object.entries(fm)) if (row?.dstHeld) updates[`flags.${DSCT_ID}.dstdFmState.${rowKey}.dstHeld`] = new foundry.data.operators.ForcedDeletion();
    if (!Object.keys(updates).length) continue;
    dbg(`fm-lock: cleared a stale held forced movement row on ${message.id}`);
    await message.update(updates).catch(() => {});
  }
}

Hooks.once("ready", () => _clearStaleHeldFmRows());

function _markHeldFmRows({ message, root }) {
  const fm = message.flags?.[DSCT_ID]?.dstdFmState ?? {};
  for (const row of root.querySelectorAll("[data-dsct-fm-key]")) {
    const rowKey = row.dataset.dsctFmKey.slice(row.dataset.dsctFmKey.indexOf(":") + 1);
    if (!fm[rowKey]?.dstHeld) continue;
    const [apply, ...rest] = [...row.children].filter((c) => c.tagName === "BUTTON");
    if (!apply) continue;
    apply.disabled = true;
    apply.classList.add("dst-dstd-held-btn");
    const icon = apply.querySelector("i");
    if (icon && !icon.classList.contains("fa-hourglass-half")) icon.className = "fa-solid fa-hourglass-half";
    const span = apply.querySelector("span");
    const label = game.i18n.localize("DS_TRIGGERS.Queue.DstdHeldLabel");
    if (span && span.textContent !== label) span.textContent = label;
    setTip(apply, tip("FmHeld", { body: game.i18n.localize("DS_TRIGGERS.Queue.FmRowHeldTip") }));
    for (const b of rest) b.disabled = true;
  }
}

Hooks.once("setup", () => {
  game.modules.get("draw-steel-ctlib")?.api?.registerPanelDecorator?.({
    id: "triggers-held-fm", priority: 510, watch: "any", immediate: true, retry: [100, 400], decorate: _markHeldFmRows,
  });
});
