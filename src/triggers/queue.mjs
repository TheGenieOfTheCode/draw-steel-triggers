import { MODULE_ID, getSetting, dbg } from "../util.mjs";
import { buildTriggerCardRows, triggerCardHTML } from "../ui/ability-preview.mjs";
import { openDamageModWindow, damagePillType } from "../ui/damage-mod-window.mjs";

let socket = null;

let _queue = [];
let _mirror = [];
const _rollBypass = new Set();
const _damageBypass = new Set();

const _pendingResumes = new Map();
const _damageHolds = new Map();
const _pendingDamageGraces = new Map();
const _resolutionHolds = new Map();
const _pendingResolutionGraces = new Map();

const _recentAbilityPosts = new Map();

function _postedAfterUse(itemUuid, usedAt) {
  const t = _recentAbilityPosts.get(itemUuid);
  return !!t && t >= (usedAt ?? 0) - 2000;
}

const _useWatches = new Map();

export function watchUseCancellation(itemUuid) {
  const now = Date.now();
  for (const [uuid, expires] of _useWatches) {
    if (expires < now) _useWatches.delete(uuid);
  }
  _useWatches.set(itemUuid, now + 120000);
}

Hooks.on("closeAbilityConfigurationDialog", (app) => {
  const uuid = app.options?.ability?.uuid;
  if (!uuid || !_useWatches.has(uuid)) return;
  _useWatches.delete(uuid);
  if (app.config != null) return;
  socket?.executeAsGM("useCancelled", uuid);
});

Hooks.on("createChatMessage", (message) => {
  if (!_useWatches.size) return;
  const abilityUse = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  if (abilityUse?.abilityUuid) _useWatches.delete(abilityUse.abilityUuid);
});

function _onUseCancelled(itemUuid) {
  if (!game.users.activeGM?.isSelf) return;
  dbg(`use cancelled: ${itemUuid}`);
  let touched = false;

  
  for (const e of _queue) {
    if (e.itemUuid === itemUuid && e.state === "used" && !e.useCancelled) {
      e.useCancelled = true;
      e.state = "declined";
      _postDeclineRecord(e.ownerActorUuid, e.ownerName, e.itemName);
      touched = true;
    }
  }

  for (const [resumeId, pending] of _pendingResumes) {
    if (!pending.awaiting.has(itemUuid)) continue;
    pending.awaiting.delete(itemUuid);
    const u = (pending.usedEntries ?? []).find((x) => x.itemUuid === itemUuid && !x.cancelled);
    if (u) {
      u.cancelled = true;
      _postDeclineRecord(u.ownerActorUuid, u.ownerName, u.itemName);
    }
    if (!pending.awaiting.size) _fireResume(resumeId);
    touched = true;
  }

  for (const [damageId, hold] of _damageHolds) {
    if (!hold.usedItems?.has(itemUuid)) continue;
    hold.usedItems.delete(itemUuid);
    hold.anyUsed = hold.usedItems.size > 0;
    const u = (hold.usedEntries ?? []).find((x) => x.itemUuid === itemUuid && !x.cancelled);
    if (u) {
      u.cancelled = true;
      _postDeclineRecord(u.ownerActorUuid, u.ownerName, u.itemName);
    }
    const grace = _pendingDamageGraces.get(damageId);
    if (grace) {
      grace.awaiting.delete(itemUuid);
      if (!grace.awaiting.size) _endDamageGrace(damageId, false);
    }
    touched = true;
  }

  for (const [resolutionId, hold] of _resolutionHolds) {
    if (!hold.usedItems?.has(itemUuid)) continue;
    hold.usedItems.delete(itemUuid);
    hold.anyUsed = hold.usedItems.size > 0;
    const u = (hold.usedEntries ?? []).find((x) => x.itemUuid === itemUuid && !x.cancelled);
    if (u) {
      u.cancelled = true;
      _postDeclineRecord(u.ownerActorUuid, u.ownerName, u.itemName);
    }
    const grace = _pendingResolutionGraces.get(resolutionId);
    if (grace) {
      grace.awaiting.delete(itemUuid);
      if (!grace.awaiting.size) _endResolutionGrace(resolutionId, false);
    }
    touched = true;
  }

  if (touched) _broadcast();
}

async function _postDeclineRecord(ownerActorUuid, ownerName, itemName) {
  const owner = await fromUuid(ownerActorUuid).catch(() => null);
  const recipients = game.users.filter((u) => u.isGM || (owner && owner.testUserPermission(u, "OWNER"))).map((u) => u.id);
  ChatMessage.create({
    content: `<div class="dst-reminder"><em>${game.i18n.format("DS_TRIGGERS.Queue.DeclineRecord", { owner: ownerName, ability: itemName })}</em></div>`,
    whisper: recipients,
    speaker: { alias: game.i18n.localize("DS_TRIGGERS.Reminder.Speaker") },
  });
}

export function getQueueMirror() {
  return _mirror;
}

export function addRollBypass(itemUuid) {
  _rollBypass.add(itemUuid);
}

export function consumeRollBypass(itemUuid) {
  if (!_rollBypass.has(itemUuid)) return false;
  _rollBypass.delete(itemUuid);
  return true;
}

export function getActiveDamageHolds() {
  return _damageHolds;
}

export function consumeDamageBypass(actorUuid) {
  if (!_damageBypass.has(actorUuid)) return false;
  _damageBypass.delete(actorUuid);
  return true;
}

export function queueSocket() {
  return socket;
}

function _broadcast() {
  socket.executeForEveryone("queueSync", foundry.utils.deepClone(_queue));
}

let _decisionTicker = null;

function _graceMs() {
  return Math.max(1, Number(getSetting("rollLockGrace")) || 15) * 1000;
}

function _ensureDecisionTicker() {
  if (_decisionTicker) return;
  _decisionTicker = setInterval(() => {
    const now = Date.now();
    for (const e of _queue) {
      if (e.state === "pending" && e.decideUntil && e.decideUntil <= now) _onQueueResolve(e.id, "declined", "timer");
    }
    if (!_queue.some((e) => e.state === "pending" && e.decideUntil)) {
      clearInterval(_decisionTicker);
      _decisionTicker = null;
    }
  }, 1000);
}

function _onQueueAdd(entries) {
  if (!game.users.activeGM?.isSelf) return;

  
  
  const fresh = entries.filter((e) => (e.damageId || e.resolutionId)
    ? true
    : !_queue.some((q) => q.itemUuid === e.itemUuid && q.state === "pending"));
  if (!fresh.length) return;
  const damageEntry = fresh.find((e) => e.damageId && e.heldDamage);
  if (damageEntry && !_damageHolds.has(damageEntry.damageId)) {
    _damageHolds.set(damageEntry.damageId, { ...damageEntry.heldDamage, anyUsed: false, createdAt: damageEntry.createdAt });
    Hooks.callAll("dst.damageHoldRegistered", damageEntry.damageId);
  }
  const resolutionEntry = fresh.find((e) => e.resolutionId && e.resolution);
  if (resolutionEntry && !_resolutionHolds.has(resolutionEntry.resolutionId)) {
    _resolutionHolds.set(resolutionEntry.resolutionId, { ...resolutionEntry.resolution, anyUsed: false, createdAt: resolutionEntry.createdAt });
    const message = game.messages.get(resolutionEntry.resolution.messageId);
    if (message) message.setFlag(MODULE_ID, "resolutionLock", true).catch(() => {});
    Hooks.callAll("dst.resolutionHoldRegistered", resolutionEntry.resolutionId);
  }
  if (getSetting("stackDecisionTimer")) {
    for (const e of fresh) {
      if (e.state === "pending") e.decideUntil = Date.now() + _graceMs();
    }
    _ensureDecisionTicker();
  }
  _queue.push(...fresh);
  dbg("queue add", fresh);
  _broadcast();
}

async function _onQueueResolve(id, outcome, userName) {
  if (!game.users.activeGM?.isSelf) return;
  const entry = _queue.find((e) => e.id === id);
  if (!entry || entry.state !== "pending") return;
  entry.state = outcome;
  if (outcome === "used") entry.usedAt = Date.now();
  if (outcome === "used" && entry.halvesOnUse && entry.resume?.itemUuid) {
    Hooks.callAll("dst.targetedHalfUsed", {
      abilityUuid: entry.resume.itemUuid,
      targetActorUuid: entry.ownerActorUuid,
      modName: entry.itemName,
    });
  }
  dbg(`queue resolve ${id} -> ${outcome}`);

  if (outcome === "declined") _postDeclineRecord(entry.ownerActorUuid, entry.ownerName, entry.itemName);

  if (entry.resumeId) {
    const stillLocked = _queue.some((e) => e.resumeId === entry.resumeId && e.state === "pending");
    if (!stillLocked) {
      const group = _queue.filter((e) => e.resumeId === entry.resumeId);
      const resume = group[0]?.resume;
      const usedItems = new Set(group.filter((e) => e.state === "used").map((e) => e.itemUuid));
      
      _queue = _queue.filter((e) => e.resumeId !== entry.resumeId || e.kind === "held");
      if (!usedItems.size) {
        _removeHeld(entry.resumeId);
        _dispatchResume(resume);
      } else {
        const usedEntries = group.filter((e) => e.state === "used")
          .map((e) => ({
            itemUuid: e.itemUuid, ownerActorUuid: e.ownerActorUuid, ownerName: e.ownerName,
            itemName: e.itemName, usedAt: e.usedAt,
            redirect: e.redirect ?? null, rollMod: e.rollMod ?? null,
            subjectTokenUuid: e.subjectTokenUuid ?? null,
          }));
        const awaiting = new Set(usedEntries.filter((u) => !_postedAfterUse(u.itemUuid, u.usedAt)).map((u) => u.itemUuid));
        if (!awaiting.size) {
          _removeHeld(entry.resumeId);
          _postRedirectReminders(usedEntries, resume);
          _dispatchResume(resume, _collectRetargets(usedEntries), _collectRollMods(usedEntries));
        } else {
          const grace = _graceMs();
          const resumeId = entry.resumeId;
          const held = _queue.find((e) => e.resumeId === resumeId && e.kind === "held");
          if (held) {
            held.state = "grace";
            held.graceUntil = Date.now() + grace;
          }
          _pendingResumes.set(resumeId, {
            resume,
            awaiting,
            usedEntries,
            timer: setTimeout(() => _fireResume(resumeId, true), grace),
          });
        }
      }
    }
  } else {
    _queue = _queue.filter((e) => e.id !== id);
  }

  
  if (outcome === "used" && getSetting("stackDecisionTimer")) {
    for (const e of _queue) {
      if (e.state !== "pending" || !e.decideUntil) continue;
      if ((entry.resumeId && e.resumeId === entry.resumeId) || (entry.damageId && e.damageId === entry.damageId)
        || (entry.resolutionId && e.resolutionId === entry.resolutionId)) {
        e.decideUntil = Date.now() + _graceMs();
      }
    }
  }

  if (entry.damageId && _damageHolds.has(entry.damageId)) {
    const hold = _damageHolds.get(entry.damageId);
    if (outcome === "used") {
      hold.anyUsed = true;
      (hold.usedItems ??= new Set()).add(entry.itemUuid);
      (hold.usedEntries ??= []).push({ itemUuid: entry.itemUuid, ownerActorUuid: entry.ownerActorUuid, ownerName: entry.ownerName, itemName: entry.itemName, usedAt: entry.usedAt, halfDamage: entry.halfDamage ?? false });
    }
    if (!_queue.some((e) => e.damageId === entry.damageId && e.state === "pending")) {
      _completeDamageGroup(entry.damageId);
    }
  }
  if (entry.resolutionId && _resolutionHolds.has(entry.resolutionId)) {
    const hold = _resolutionHolds.get(entry.resolutionId);
    if (outcome === "used") {
      hold.anyUsed = true;
      (hold.usedItems ??= new Set()).add(entry.itemUuid);
      (hold.usedEntries ??= []).push({
        itemUuid: entry.itemUuid, ownerActorUuid: entry.ownerActorUuid, ownerName: entry.ownerName,
        itemName: entry.itemName, usedAt: entry.usedAt,
        rollMod: entry.rollMod ?? null, redirect: entry.redirect ?? null,
        halfOnUse: entry.halfOnUse ?? false, postHoc: entry.postHoc ?? false,
        subjectTargetKey: entry.subjectTargetKey ?? null, subjectName: entry.subjectName ?? "",
      });
    }
    if (!_queue.some((e) => e.resolutionId === entry.resolutionId && e.state === "pending")) {
      _completeResolutionGroup(entry.resolutionId);
    }
  }
  _broadcast();
}

function _removeDamageHeldEntry(damageId) {
  _queue = _queue.filter((e) => !(e.damageId === damageId && e.kind === "damageHeld"));
}

function _completeDamageGroup(damageId) {
  const hold = _damageHolds.get(damageId);
  if (!hold) return;
  const awaiting = new Set((hold.usedEntries ?? [])
    .filter((u) => !u.cancelled && !_postedAfterUse(u.itemUuid, u.usedAt))
    .map((u) => u.itemUuid));
  if (!awaiting.size) {
    _removeDamageHeldEntry(damageId);
    _finalizeDamageHold(damageId);
    return;
  }
  
  
  const grace = _graceMs();
  const heldEntry = _queue.find((e) => e.damageId === damageId && e.kind === "damageHeld");
  if (heldEntry) {
    heldEntry.state = "grace";
    heldEntry.graceUntil = Date.now() + grace;
  }
  _pendingDamageGraces.set(damageId, {
    awaiting,
    timer: setTimeout(() => _endDamageGrace(damageId, true), grace),
  });
}

function _endDamageGrace(damageId, expired) {
  const pending = _pendingDamageGraces.get(damageId);
  if (!pending) return;
  clearTimeout(pending.timer);
  _pendingDamageGraces.delete(damageId);
  const hold = _damageHolds.get(damageId);
  if (hold && expired && pending.awaiting.size) {
    for (const u of hold.usedEntries ?? []) {
      if (!pending.awaiting.has(u.itemUuid)) continue;
      _postDeclineRecord(u.ownerActorUuid, u.ownerName, u.itemName);
      hold.usedItems?.delete(u.itemUuid);
    }
    hold.anyUsed = (hold.usedItems?.size ?? 0) > 0;
  }
  _removeDamageHeldEntry(damageId);
  _broadcast();
  _finalizeDamageHold(damageId);
}

function _removeResolutionHeldEntry(resolutionId) {
  _queue = _queue.filter((e) => !(e.resolutionId === resolutionId && e.kind === "resolutionHeld"));
}

function _completeResolutionGroup(resolutionId) {
  const hold = _resolutionHolds.get(resolutionId);
  if (!hold) return;
  const awaiting = new Set((hold.usedEntries ?? [])
    .filter((u) => !u.cancelled && !_postedAfterUse(u.itemUuid, u.usedAt))
    .map((u) => u.itemUuid));
  if (!awaiting.size) {
    _removeResolutionHeldEntry(resolutionId);
    _finalizeResolutionHold(resolutionId);
    return;
  }
  const grace = _graceMs();
  const heldEntry = _queue.find((e) => e.resolutionId === resolutionId && e.kind === "resolutionHeld");
  if (heldEntry) {
    heldEntry.state = "grace";
    heldEntry.graceUntil = Date.now() + grace;
  }
  _pendingResolutionGraces.set(resolutionId, {
    awaiting,
    timer: setTimeout(() => _endResolutionGrace(resolutionId, true), grace),
  });
}

function _endResolutionGrace(resolutionId, expired) {
  const pending = _pendingResolutionGraces.get(resolutionId);
  if (!pending) return;
  clearTimeout(pending.timer);
  _pendingResolutionGraces.delete(resolutionId);
  const hold = _resolutionHolds.get(resolutionId);
  if (hold && expired && pending.awaiting.size) {
    for (const u of hold.usedEntries ?? []) {
      if (!pending.awaiting.has(u.itemUuid)) continue;
      _postDeclineRecord(u.ownerActorUuid, u.ownerName, u.itemName);
      u.cancelled = true;
      hold.usedItems?.delete(u.itemUuid);
    }
    hold.anyUsed = (hold.usedItems?.size ?? 0) > 0;
  }
  _removeResolutionHeldEntry(resolutionId);
  _broadcast();
  _finalizeResolutionHold(resolutionId);
}

async function _finalizeResolutionHold(resolutionId) {
  const hold = _resolutionHolds.get(resolutionId);
  if (!hold) return;
  _resolutionHolds.delete(resolutionId);
  const message = game.messages.get(hold.messageId);
  const used = (hold.usedEntries ?? []).filter((u) => !u.cancelled);
  for (const u of used) {
    if (u.rollMod) await _applyRollModOverride(hold, u).catch((err) => dbg("roll mod apply failed", err));
  }
  for (const u of used) {
    if (!u.halfOnUse || !u.subjectTargetKey) continue;
    const doc = await fromUuid(u.subjectTargetKey.replace(/__/g, ".")).catch(() => null);
    const targetActorUuid = doc?.actor?.uuid ?? null;
    if (!targetActorUuid) continue;
    Hooks.callAll("dst.targetedHalfUsed", {
      abilityUuid: hold.abilityUuid,
      targetActorUuid,
      modName: u.itemName,
      messageId: hold.messageId,
    });
  }
  _postRedirectReminders(used, { userId: hold.authorUserId ?? null });
  const stillHeld = [..._resolutionHolds.values()].some((h) => h.messageId === hold.messageId);
  if (message && !stillHeld) await message.unsetFlag(MODULE_ID, "resolutionLock").catch(() => {});
  Hooks.callAll("dst.resolutionHoldResolved", { hold, used });
}

function _findPowerRoll(message, targetActorUuid) {
  const isPR = (r) => (globalThis.ds?.rolls?.PowerRoll && r instanceof ds.rolls.PowerRoll) || typeof r?.product !== "undefined";
  const parts = message.system?.parts;
  const list = parts
    ? (Array.isArray(parts) ? parts : Array.from(parts.contents ?? (typeof parts.values === "function" ? parts.values() : Object.values(parts))))
    : [];
  let fallback = null;
  for (const part of list) {
    for (const roll of Array.from(part.rolls ?? []).reverse()) {
      if (!isPR(roll)) continue;
      if (targetActorUuid && roll.options?.target === targetActorUuid) return roll;
      fallback = fallback ?? roll;
    }
  }
  return fallback;
}

async function _applyRollModOverride(hold, u) {
  const message = game.messages.get(hold.messageId);
  if (!message || !u.subjectTargetKey) return;
  const state = foundry.utils.deepClone(message.getFlag("draw-steel-target-damage", "state") ?? null);
  if (!state) return;
  const targetTokenUuid = u.subjectTargetKey.replace(/__/g, ".");
  const targetDoc = await fromUuid(targetTokenUuid).catch(() => null);
  const roll = _findPowerRoll(message, targetDoc?.actor?.uuid ?? null);
  if (!roll) return;
  const natural = Number(roll.dice?.[0]?.total ?? 0);
  const critThreshold = Number(roll.options?.criticalThreshold ?? 19);
  const existing = state.tierOverrides?.[u.subjectTargetKey] ?? null;
  const baseEdges = existing?.edges != null ? Number(existing.edges) : Number(roll.options?.edges ?? 0);
  const baseBanes = existing?.banes != null ? Number(existing.banes) : Number(roll.options?.banes ?? 0);
  const baseBonuses = existing?.bonuses != null ? Number(existing.bonuses) : Number(roll.options?.bonuses ?? 0);
  const edges = Math.min(2, baseEdges + (u.rollMod.edges ?? 0));
  const banes = Math.min(2, baseBanes + (u.rollMod.banes ?? 0));
  const bonuses = baseBonuses + (u.rollMod.bonus ?? 0);

  const net0 = Number(roll.options?.edges ?? 0) - Number(roll.options?.banes ?? 0);
  const adj0 = Math.abs(net0) === 1 ? Math.sign(net0) * 2 : 0;
  const staticModifier = existing?.staticModifier != null
    ? Number(existing.staticModifier)
    : Number(roll.total ?? 0) - natural - adj0 - Number(roll.options?.bonuses ?? 0);

  const net = edges - banes;
  const adj = Math.abs(net) === 1 ? Math.sign(net) * 2 : 0;
  const total = natural + staticModifier + adj + bonuses;
  let tier;
  if (natural >= critThreshold) tier = 3;
  else {
    tier = 1;
    if (total >= 12) tier = 2;
    if (total >= 17) tier = 3;
    const shift = net - Math.sign(net);
    tier = Math.min(3, Math.max(1, tier + shift));
  }

  state.tierOverrides = state.tierOverrides ?? {};
  state.tierOverrides[u.subjectTargetKey] = {
    tier, total, naturalTotal: natural, staticModifier, edges, banes, bonuses,
    isCritical: natural >= critThreshold,
    dstModName: u.itemName,
  };
  state.updatedAt = Date.now();
  await message.setFlag("draw-steel-target-damage", "state", state);
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.RollModApplied", { modName: u.itemName, name: u.subjectName, tier }));
}

async function _finalizeDamageHold(damageId) {
  const hold = _damageHolds.get(damageId);
  if (!hold) return;
  _damageHolds.delete(damageId);
  if (!hold.anyUsed) {
    await _applyHeldDamage(hold, hold.amount);
    Hooks.callAll("dst.damageHoldResolved", { hold, finalAmount: hold.amount });
    return;
  }

  
  
  const actor = await fromUuid(hold.actorUuid).catch(() => null);
  const F = (k, data) => game.i18n.format(`DS_TRIGGERS.Queue.${k}`, data);
  const typeLabel = hold.damageType
    ? game.i18n.localize(ds.CONFIG.damageTypes?.[hold.damageType]?.label ?? hold.damageType)
    : null;
  const amountLabel = typeLabel ? `${hold.amount} ${typeLabel}` : hold.amount;
  let mitigationNote = "";
  if (hold.damageOptions && actor?.system?.calculateImmunityAndWeakness) {
    const { immunity = 0, weakness = 0 } = actor.system.calculateImmunityAndWeakness({ ...hold.damageOptions });
    if (immunity > 0) mitigationNote += `<p class="hint">${F("HeldDamageImmunityNote", { n: immunity })}</p>`;
    if (weakness > 0) mitigationNote += `<p class="hint">${F("HeldDamageWeaknessNote", { n: weakness })}</p>`;
  }
  const seedPills = [];
  for (const u of hold.usedEntries ?? []) {
    if (u.cancelled || !u.halfDamage) continue;
    const owner = u.ownerActorUuid ? fromUuidSync(u.ownerActorUuid) : null;
    seedPills.push({
      kind: "half", label: u.itemName, src: u.ownerName ?? null,
      srcTokenId: owner?.getActiveTokens?.(true, false)[0]?.id ?? null, source: "trigger",
    });
  }

  const outcome = await openDamageModWindow({
    title: F("HeldDamageTitle", { name: actor?.name ?? "" }),
    hint: `${F("HeldDamageHint", { amount: amountLabel })}${mitigationNote}`,
    base: hold.amount,
    pills: seedPills,
  });
  const result = outcome ? outcome.final : null;

  if (result != null && Number(result) >= 0 && hold.dstd?.messageId && hold.dstd?.opId) {
    const dstdMessage = game.messages.get(hold.dstd.messageId);
    if (dstdMessage && outcome.pills.length) {
      dstdMessage.setFlag(MODULE_ID, `damagePills.${hold.dstd.opId}`, {
        base: hold.amount,
        pills: outcome.pills.map((p) => ({ kind: p.kind, value: p.value ?? null, label: p.label ?? "", src: p.src ?? null, srcTokenId: p.srcTokenId ?? null, source: p.source ?? "manual", ...(p.enabled === false ? { enabled: false } : {}) })),
        final: Number(result),
      }).catch(() => {});
    }
  }

  if (result == null || !(Number(result) > 0)) {
    ui.notifications.warn(F("HeldDamageDiscarded", { name: actor?.name ?? "" }));
    Hooks.callAll("dst.damageHoldResolved", { hold, finalAmount: 0 });
    return;
  }
  const typePill = damagePillType(outcome.pills);
  if (typePill != null && hold.damageOptions) hold.damageOptions = { ...hold.damageOptions, type: typePill };
  await _applyHeldDamage(hold, Number(result));
  Hooks.callAll("dst.damageHoldResolved", { hold, finalAmount: Number(result) });
}

async function _applyHeldDamage(hold, amount) {
  if (!(amount > 0)) return;
  const actor = await fromUuid(hold.actorUuid).catch(() => null);
  if (!actor) return;
  _damageBypass.add(hold.actorUuid);
  try {
    if (hold.damageOptions) await actor.system.takeDamage(amount, { ...hold.damageOptions, dstBypass: true });
    else await actor.modifyTokenAttribute("stamina", -amount, true, false);
  } finally {
    _damageBypass.delete(hold.actorUuid);
  }
}

function _collectRetargets(usedEntries) {
  const out = [];
  for (const u of usedEntries ?? []) {
    if (u.cancelled) continue;
    if (!u.redirect || u.redirect === "chooser" || u.redirect === "after" || !u.subjectTokenUuid) continue;
    out.push({
      mode: u.redirect,
      modName: u.itemName,
      removeTokenUuid: u.subjectTokenUuid,
      newActorUuid: u.redirect === "reflect" ? null : u.ownerActorUuid,
    });
  }
  return out;
}

function _collectRollMods(usedEntries) {
  const out = [];
  for (const u of usedEntries ?? []) {
    if (u.cancelled || !u.rollMod) continue;
    out.push({
      ownerActorUuid: u.ownerActorUuid ?? null,
      modName: u.itemName,
      edges: u.rollMod.edges ?? 0,
      banes: u.rollMod.banes ?? 0,
    });
  }
  return out;
}

async function _postRedirectReminders(usedEntries, resume) {
  for (const u of usedEntries ?? []) {
    if (u.cancelled || !u.redirect) continue;
    const after = u.redirect === "after";
    
    
    if (!after && u.postHoc !== true) continue;
    const recipients = new Set(game.users.filter((x) => x.isGM).map((x) => x.id));
    if (resume?.userId) recipients.add(resume.userId);
    const item = u.itemUuid ? await fromUuid(u.itemUuid).catch(() => null) : null;
    const link = u.itemUuid
      ? `<a class="dst-ability-link" data-item-uuid="${u.itemUuid}" data-tooltip="${game.i18n.localize("DS_TRIGGERS.Reminder.LinkTooltip")}"><strong>${u.itemName}</strong></a>`
      : `<strong>${u.itemName}</strong>`;
    const rows = await buildTriggerCardRows([{
      item,
      head: link,
      subtitle: item?.system?.trigger ? `<em>${item.system.trigger}</em>` : "",
    }]);
    ChatMessage.create({
      content: triggerCardHTML({
        header: game.i18n.localize("DS_TRIGGERS.Queue.RedirectAfterHeader"),
        intro: game.i18n.format(after ? "DS_TRIGGERS.Queue.RedirectAfterBody" : "DS_TRIGGERS.Queue.RedirectPostHocBody", { owner: u.ownerName, ability: `<strong>${u.itemName}</strong>` }),
        rows,
      }),
      whisper: [...recipients],
      speaker: { alias: game.i18n.localize("DS_TRIGGERS.Reminder.Speaker") },
      flags: { [MODULE_ID]: { reminder: { event: "REDIRECT_AFTER" } } },
    });
  }
}

function _dispatchResume(resume, retargets = [], rollMods = []) {
  if (!resume?.userId || !resume?.itemUuid) return;
  const user = game.users.get(resume.userId);
  if (user?.active) socket.executeForUsers("resumeRoll", [resume.userId], resume.itemUuid, retargets, rollMods);
  else socket.executeAsGM("resumeRoll", resume.itemUuid, retargets, rollMods);
}

function _removeHeld(resumeId) {
  _queue = _queue.filter((e) => !(e.resumeId === resumeId && e.kind === "held"));
}

function _fireResume(resumeId, expired = false) {
  const pending = _pendingResumes.get(resumeId);
  const held = _queue.find((e) => e.resumeId === resumeId && e.kind === "held");
  _removeHeld(resumeId);
  if (pending) {
    clearTimeout(pending.timer);
    _pendingResumes.delete(resumeId);
    if (expired && pending.awaiting.size) {

      for (const u of pending.usedEntries ?? []) {
        if (pending.awaiting.has(u.itemUuid)) _postDeclineRecord(u.ownerActorUuid, u.ownerName, u.itemName);
      }
    }
    const applied = (pending.usedEntries ?? []).filter((u) => !expired || !pending.awaiting.has(u.itemUuid));
    _postRedirectReminders(applied, pending.resume);
    _dispatchResume(pending.resume, _collectRetargets(applied), _collectRollMods(applied));
  } else if (held) {

    const usedInGroup = _queue.filter((e) => e.resumeId === resumeId && e.state === "used");
    for (const e of _queue) {
      if (e.resumeId === resumeId) { e.resumeId = null; e.resume = null; }
    }
    _postRedirectReminders(usedInGroup, held.resume);
    _dispatchResume(held.resume, _collectRetargets(usedInGroup), _collectRollMods(usedInGroup));
  }
  _broadcast();
}

function _onReleaseHeld(resumeId) {
  if (!game.users.activeGM?.isSelf) return;
  _fireResume(resumeId);
}

Hooks.on("createChatMessage", (message) => {
  if (!game.users.activeGM?.isSelf) return;
  const abilityUse = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  if (!abilityUse?.abilityUuid) return;
  const now = Date.now();
  _recentAbilityPosts.set(abilityUse.abilityUuid, now);
  for (const [uuid, t] of _recentAbilityPosts) {
    if (now - t > 120000) _recentAbilityPosts.delete(uuid);
  }
  for (const [resumeId, pending] of _pendingResumes) {
    if (!pending.awaiting.has(abilityUse.abilityUuid)) continue;
    pending.awaiting.delete(abilityUse.abilityUuid);
    if (!pending.awaiting.size) _fireResume(resumeId);
  }
  for (const [damageId, pending] of _pendingDamageGraces) {
    if (!pending.awaiting.has(abilityUse.abilityUuid)) continue;
    pending.awaiting.delete(abilityUse.abilityUuid);
    if (!pending.awaiting.size) _endDamageGrace(damageId, false);
  }
  for (const [resolutionId, pending] of _pendingResolutionGraces) {
    if (!pending.awaiting.has(abilityUse.abilityUuid)) continue;
    pending.awaiting.delete(abilityUse.abilityUuid);
    if (!pending.awaiting.size) _endResolutionGrace(resolutionId, false);
  }
});

const _pendingRollMods = new Map();

async function _onResumeRoll(itemUuid, retargets = [], rollMods = []) {
  const item = await fromUuid(itemUuid).catch(() => null);
  if (!item) return;
  await _applyRetargets(item, retargets);
  if (rollMods.length) {
    for (const m of rollMods) {
      const owner = m.ownerActorUuid ? await fromUuid(m.ownerActorUuid).catch(() => null) : null;
      const ownerToken = owner?.getActiveTokens?.(true, false)[0] ?? null;
      m.src = owner?.name ?? null;
      m.srcTokenId = ownerToken?.id ?? null;
    }
    const now = Date.now();
    _pendingRollMods.set(itemUuid, { mods: rollMods, at: now });
    for (const [uuid, rec] of _pendingRollMods) {
      if (now - rec.at > 60000) _pendingRollMods.delete(uuid);
    }
  }
  addRollBypass(itemUuid);
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.RollReleased", { name: item.name }));
  item.system.use();
}

function _rollModLabel(m) {
  const parts = [];
  if (m.banes === 2) parts.push(game.i18n.localize("DS_TRIGGERS.Editor.RollModDoubleBane"));
  else if (m.banes === 1) parts.push(game.i18n.localize("DS_TRIGGERS.Editor.RollModBane"));
  if (m.edges === 2) parts.push(game.i18n.localize("DS_TRIGGERS.Editor.RollModDoubleEdge"));
  else if (m.edges === 1) parts.push(game.i18n.localize("DS_TRIGGERS.Editor.RollModEdge"));
  return parts.join(" + ");
}

Hooks.on("renderAbilityConfigurationDialog", (app) => {
  const uuid = app.options?.ability?.uuid;
  if (!uuid || app._dstRollModsApplied) return;
  const pending = _pendingRollMods.get(uuid);
  if (!pending) return;
  app._dstRollModsApplied = true;
  _pendingRollMods.delete(uuid);
  
  
  setTimeout(() => _applyRollMods(app, pending.mods), 0);
});

function _applyRollMods(app, mods) {
  if (!app.rendered) return;
  const addPill = game.modules.get("draw-steel-combat-tools")?.active
    ? game.modules.get("draw-steel-combat-tools").api?.rollDialog?.addPill
    : null;
  let bumped = false;
  const modifiers = app.options?.context?.modifiers;
  for (const m of mods) {
    let asPills = false;
    if (addPill) {
      const specs = [];
      if (m.edges) specs.push({ kind: "edge", amount: m.edges });
      if (m.banes) specs.push({ kind: "bane", amount: m.banes });
      asPills = specs.length > 0 && specs.every((s) => addPill(app, {
        ...s, reason: m.modName, src: m.src ?? null, srcTokenId: m.srcTokenId ?? null,
      }));
    }
    if (!asPills && modifiers) {
      bumped = true;
      modifiers.edges = Math.min(2, (modifiers.edges ?? 0) + (m.edges ?? 0));
      modifiers.banes = Math.min(2, (modifiers.banes ?? 0) + (m.banes ?? 0));
    }
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.RollModInjected", {
      modName: m.modName, effect: _rollModLabel(m),
    }));
  }
  if (bumped) app.render();
}

async function _applyRetargets(item, retargets) {
  for (const r of retargets ?? []) {
    try {
      const removeDoc = r.removeTokenUuid ? await fromUuid(r.removeTokenUuid).catch(() => null) : null;
      const newActor = r.newActorUuid ? await fromUuid(r.newActorUuid).catch(() => null) : item.actor;
      const newToken = newActor?.getActiveTokens(true, false)[0] ?? null;
      if (removeDoc?.object && removeDoc.object !== newToken) removeDoc.object.setTarget(false, { releaseOthers: false });
      if (newToken) newToken.setTarget(true, { releaseOthers: false });
      const oldName = removeDoc?.name ?? "";
      const newName = newToken?.name ?? newActor?.name ?? "";
      ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.RedirectApplied", { modName: r.modName, newName, oldName }));
      if (r.mode === "swap") ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.RedirectSwapNote", { a: newName, b: oldName }));
    } catch (err) {
      dbg("retarget failed", err);
    }
  }
}

function _onQueueSync(entries) {
  const hadPendingForMe = _pendingForMe(_mirror).length;
  _mirror = entries;
  Hooks.callAll("dst.queueChanged", _mirror);
  if (_pendingForMe(_mirror).length > hadPendingForMe) Hooks.callAll("dst.queueOpenRequested");
}

function _pendingForMe(entries) {
  return entries.filter((e) => (e.state === "pending" || e.kind === "held") && canActOn(e));
}

export function canActOn(entry) {
  if (game.user.isGM) return true;
  const owner = fromUuidSync(entry.ownerActorUuid);
  return !!owner && owner.testUserPermission(game.user, "OWNER");
}

export function hasHeldEntry(itemUuid) {
  return _mirror.some((e) => e.kind === "held" && e.itemUuid === itemUuid);
}

export function enqueueLockEntries(matches, { event, causeLabel, resume, held }) {
  const resumeId = foundry.utils.randomID();
  const entries = matches.map((m) => ({
    id: foundry.utils.randomID(),
    itemUuid: m.item.uuid,
    itemName: m.item.name,
    ownerActorUuid: m.actor.uuid,
    ownerName: m.actor.name,
    event: m._lockEvent ?? event,
    causeLabel: m._causeLabel ?? causeLabel,
    halvesOnUse: m._halvesOnUse ?? false,
    redirect: m._redirect ?? null,
    rollMod: m._rollMod ?? null,
    subjectTokenUuid: m._subjectTokenUuid ?? null,
    playerSide: m.actor.hasPlayerOwner ?? false,
    lock: true,
    state: "pending",
    createdAt: Date.now(),
    resumeId,
    resume,
  }));
  
  entries.push({
    id: foundry.utils.randomID(),
    kind: "held",
    itemUuid: held.itemUuid,
    itemName: held.itemName,
    ownerActorUuid: held.ownerActorUuid,
    ownerName: held.ownerName,
    event,
    causeLabel,
    lock: false,
    state: "held",
    graceUntil: null,
    createdAt: Date.now(),
    resumeId,
    resume,
  });
  socket.executeAsGM("queueAdd", entries);
  return entries;
}

export function releaseHeld(resumeId) {
  socket.executeAsGM("releaseHeld", resumeId);
}

export function enqueuePromptEntries(matches, { event, causeLabel }) {
  const promptId = foundry.utils.randomID();
  const entries = matches.map((m) => ({
    id: foundry.utils.randomID(),
    itemUuid: m.item.uuid,
    itemName: m.item.name,
    ownerActorUuid: m.actor.uuid,
    ownerName: m.actor.name,
    event,
    causeLabel,
    lock: false,
    state: "pending",
    createdAt: Date.now(),
    resumeId: null,
    resume: null,
    promptId,
    playerSide: m.actor.hasPlayerOwner ?? false,
  }));
  socket.executeAsGM("queueAdd", entries);
}

export function enqueueDamageHold(matches, { causeLabel, heldDamage }) {
  const damageId = foundry.utils.randomID();
  const entries = matches.map((m) => ({
    id: foundry.utils.randomID(),
    itemUuid: m.item.uuid,
    itemName: m.item.name,
    ownerActorUuid: m.actor.uuid,
    ownerName: m.actor.name,
    event: "WOULD_TAKE_DAMAGE",
    causeLabel,
    lock: false,
    state: "pending",
    createdAt: Date.now(),
    resumeId: null,
    resume: null,
    damageId,
    heldDamage,
    halfDamage: m.clause?.halfDamage ?? false,
    playerSide: m.actor.hasPlayerOwner ?? false,
  }));
  entries.push({
    id: foundry.utils.randomID(),
    kind: "damageHeld",
    itemUuid: null,
    itemName: heldDamage.damageType
      ? game.i18n.format("DS_TRIGGERS.Queue.HeldDamageEntryTyped", {
        amount: heldDamage.amount,
        type: game.i18n.localize(ds.CONFIG.damageTypes?.[heldDamage.damageType]?.label ?? heldDamage.damageType),
      })
      : game.i18n.format("DS_TRIGGERS.Queue.HeldDamageEntry", { amount: heldDamage.amount }),
    ownerActorUuid: heldDamage.actorUuid,
    ownerName: heldDamage.actorName ?? "",
    event: "WOULD_TAKE_DAMAGE",
    causeLabel,
    lock: false,
    state: "held",
    createdAt: Date.now(),
    resumeId: null,
    resume: null,
    damageId,
    heldDamage,
  });
  socket.executeAsGM("queueAdd", entries);
}

export function enqueueResolutionHold(matches, { causeLabel, resolution }) {
  const resolutionId = foundry.utils.randomID();
  const entries = matches.map((m) => ({
    id: foundry.utils.randomID(),
    itemUuid: m.item.uuid,
    itemName: m.item.name,
    ownerActorUuid: m.actor.uuid,
    ownerName: m.actor.name,
    event: m.clause?.event ?? "TARGETED_BY_STRIKE",
    causeLabel: m._causeLabel ?? causeLabel,
    lock: false,
    state: "pending",
    createdAt: Date.now(),
    resumeId: null,
    resume: null,
    resolutionId,
    rollMod: m.clause?.rollMod ?? null,
    redirect: m.clause?.redirect ?? null,
    halfOnUse: m.clause?.halfOnUse === true
      || (m._postHoc === true && m.clause?.targetedHalf === true),
    postHoc: m._postHoc === true,
    subjectTargetKey: m._subjectTargetKey ?? null,
    subjectName: m._subjectName ?? "",
    playerSide: m.actor.hasPlayerOwner ?? false,
  }));
  entries.push({
    id: foundry.utils.randomID(),
    kind: "resolutionHeld",
    itemUuid: resolution.abilityUuid ?? null,
    itemName: game.i18n.format("DS_TRIGGERS.Queue.ResolutionEntry", { ability: resolution.abilityName }),
    ownerActorUuid: resolution.rollerActorUuid ?? null,
    ownerName: resolution.rollerName ?? "",
    event: "TARGETED_BY_STRIKE",
    causeLabel,
    lock: false,
    state: "held",
    graceUntil: null,
    createdAt: Date.now(),
    resumeId: null,
    resume: null,
    resolutionId,
    resolution,
  });
  socket.executeAsGM("queueAdd", entries);
}

export function releaseResolutionNow(resolutionId) {
  socket.executeAsGM("releaseResolutionNow", resolutionId);
}

function _onReleaseResolutionNow(resolutionId) {
  if (!game.users.activeGM?.isSelf) return;
  const pending = _pendingResolutionGraces.get(resolutionId);
  if (pending) {
    clearTimeout(pending.timer);
    _pendingResolutionGraces.delete(resolutionId);
  }
  for (const e of _queue) {
    if (e.resolutionId === resolutionId && e.state === "pending") {
      e.resolutionId = null;
      e.rollMod = null;
    }
  }
  _removeResolutionHeldEntry(resolutionId);
  _finalizeResolutionHold(resolutionId);
  _broadcast();
}

export function applyHeldDamageNow(damageId) {
  socket.executeAsGM("applyHeldDamageNow", damageId);
}

function _onApplyHeldDamageNow(damageId) {
  if (!game.users.activeGM?.isSelf) return;
  const pending = _pendingDamageGraces.get(damageId);
  if (pending) {
    clearTimeout(pending.timer);
    _pendingDamageGraces.delete(damageId);
  }
  
  for (const e of _queue) {
    if (e.damageId === damageId && e.state === "pending") {
      e.damageId = null;
      e.heldDamage = null;
    }
  }
  _removeDamageHeldEntry(damageId);
  _finalizeDamageHold(damageId);
  _broadcast();
}

export function resolveQueueEntry(id, outcome) {
  socket.executeAsGM("queueResolve", id, outcome, game.user.name);
}

Hooks.once("socketlib.ready", () => {
  socket = socketlib.registerModule(MODULE_ID);
  socket.register("queueAdd", _onQueueAdd);
  socket.register("queueResolve", _onQueueResolve);
  socket.register("queueSync", _onQueueSync);
  socket.register("resumeRoll", _onResumeRoll);
  socket.register("releaseHeld", _onReleaseHeld);
  socket.register("applyHeldDamageNow", _onApplyHeldDamageNow);
  socket.register("releaseResolutionNow", _onReleaseResolutionNow);
  socket.register("useCancelled", _onUseCancelled);
});
