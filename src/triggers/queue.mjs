import { setVillainUsed } from "./villain-actions.mjs";
import { resolveStackGain } from "./resource-gains.mjs";
import { MODULE_ID, getSetting, dbg, isPrimaryGM, primaryGM, batchedNotice } from "../util.mjs";
import { cardContent, facesIn, postSystemCard, withFaces } from "../ui/system-card.mjs";
import { postFeatureCard } from "../ui/feature-card.mjs";
import { noteFeatureLineUse } from "./feature-triggers.mjs";
import { startCountdown } from "./countdowns.mjs";
import { setTriggeredActionSpent } from "./spent-tracking.mjs";
import { openDamageModWindow, damagePillType } from "../ui/damage-mod-window.mjs";
import { noteTargetsChange } from "./detectors/resolution.mjs";
import { footprintGap, abilityRangeSquares, flankingAllyOf } from "./dispatch.mjs";
import { triggerEffectText } from "./registry.mjs";
import { pickHarmonizeTarget, setDamagePillEnabled, addTarget } from "./bespoke.mjs";
import { lineMandatory } from "./auto-use.mjs";
import { hasBespokeUse } from "./bespoke-registry.mjs";
import { deferDeath } from "../compat/death-tracker.mjs";
import { joinSquad, noteSquadUse } from "./squad-groups.mjs";
import { pickStabilityShare, pickSurgeSpend, shareStability, markVictim, markDealer } from "./line-effects.mjs";

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
const _automatedUses = new Map();
const _triggerDamageUses = new Map();

const _lineFields = (m) => (m.item?.featureLine
  ? { lineKey: m.item.featureLine.key, featureLine: { ...m.item.featureLine }, noAction: !!m.noAction, derived: !!m.item.featureLine.derived }
  : {});

const _sameSource = (a, b) => a.itemUuid === b.itemUuid && (a.lineKey ?? null) === (b.lineKey ?? null);

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

export function noteUseCancelled(itemUuid) {
  if (!itemUuid) return;
  _useWatches.delete(itemUuid);
  asPrimaryGM("useCancelled", itemUuid);
}

Hooks.on("closeAbilityConfigurationDialog", (app) => {
  const uuid = app.options?.ability?.uuid;
  if (!uuid || !_useWatches.has(uuid)) return;
  _useWatches.delete(uuid);
  if (app.config != null) return;
  asPrimaryGM("useCancelled", uuid);
});

Hooks.on("createChatMessage", (message) => {
  if (!_useWatches.size) return;
  const abilityUse = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  if (abilityUse?.abilityUuid) _useWatches.delete(abilityUse.abilityUuid);
});

function _onUseCancelled(itemUuid) {
  if (!isPrimaryGM()) return;
  dbg(`use cancelled: ${itemUuid}`);
  let touched = false;

  
  for (const e of _queue) {
    if (e.itemUuid === itemUuid && e.state === "used" && !e.useCancelled) {
      e.useCancelled = true;
      e.state = "declined";
      if (e.villain) _recordVillain(e, false);
      else _postDeclineRecord(e.ownerActorUuid, e.ownerName, e.itemName);
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

export async function _postDeclineRecord(ownerActorUuid, ownerName, itemName, mandatory = false) {
  const owner = await fromUuid(ownerActorUuid).catch(() => null);
  const recipients = game.users.filter((u) => u.isGM || (owner && owner.testUserPermission(u, "OWNER"))).map((u) => u.id);
  const esc = foundry.utils.escapeHTML;
  const sentence = game.i18n.format(mandatory ? "DS_TRIGGERS.Queue.DeclineRecordMandatory" : "DS_TRIGGERS.Queue.DeclineRecord", { owner: esc(ownerName), ability: `<strong>${esc(itemName)}</strong>` });
  postSystemCard({
    title: game.i18n.localize("DS_TRIGGERS.Queue.DeclineTitle"),
    flavor: null,
    kind: "Declined",
    content: cardContent({ intro: facesIn(sentence, [owner]) }),
    whisper: recipients,
    flags: { [MODULE_ID]: { notice: "decline" } },
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

export function asPrimaryGM(handler, ...args) {
  const gm = primaryGM();
  if (!gm?.active) return undefined;
  return socket?.executeAsUser(handler, gm.id, ...args);
}

export function queueSocket() {
  return socket;
}

function _broadcast() {
  if (!_queue.some((e) => e.kind === "damageHeld")) _queue = _queue.filter((e) => e.kind !== "reaper" || e.status !== "held");
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

function _mergeFamily(e) {
  if (e.kind || e.villain || e.resumeId || e.resolutionId) return null;
  if (e.damageId) return "damage";
  if (e.promptId) return "prompt";
  return null;
}

const _asChoice = (e) => ({
  key: e.id,
  subjectTokenUuid: e.subjectTokenUuid ?? null,
  causeLabel: e.causeLabel ?? "",
  damageId: e.damageId ?? null,
  heldDamage: e.heldDamage ?? null,
  promptId: e.promptId ?? null,
  triggerDamage: e.triggerDamage ?? null,
  halfDamage: e.halfDamage ?? false,
  damageReduction: e.damageReduction ?? null,
  sourceMessageId: e.sourceMessageId ?? null,
});

function _addChoice(into, e) {
  into.choices ??= [_asChoice(into)];
  into.choices.push(_asChoice(e));
  into.causeLabel = game.i18n.format("DS_TRIGGERS.Queue.ChoiceCause", { count: into.choices.length });
}

function _takeChoice(entry, choice) {
  const { key, ...fields } = choice;
  Object.assign(entry, fields);
  delete entry.choices;
}

const _choiceIds = (e, field) => [e[field], ...(e.choices ?? []).map((c) => c[field])].filter(Boolean);

function _groupPending(field, id) {
  return _queue.some((e) => e.state === "pending" && _choiceIds(e, field).includes(id));
}

function _onQueueAdd(entries) {
  if (!isPrimaryGM()) return;

  const fresh = [];
  let merged = false;
  for (const e of entries) {
    if (joinSquad(e, [..._queue, ...fresh])) {
      merged = true;
      continue;
    }
    const family = _mergeFamily(e);
    const into = family && _queue.find((q) => _sameSource(q, e) && q.state === "pending" && _mergeFamily(q) === family);
    if (into) {
      _addChoice(into, e);
      merged = true;
      continue;
    }
    if (!e.damageId && !e.resolutionId && _queue.some((q) => _sameSource(q, e) && q.state === "pending")) continue;
    fresh.push(e);
  }
  if (!fresh.length) {
    if (merged) _broadcast();
    return;
  }
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
      if (e.state === "pending" && !e.villain && !e.gain) e.decideUntil = Date.now() + _graceMs();
    }
    _ensureDecisionTicker();
  }
  _queue.push(...fresh);
  dbg("queue add", fresh);
  _broadcast();
  Hooks.callAll("dst.queueAdded", fresh);
}

async function _enableBonusPill({ messageId, targetUuid, label, extra }) {
  const message = game.messages.get(messageId);
  if (!message) return;
  if (extra) {
    await game.modules.get("draw-steel-combat-tools")?.api?.extraDamage?.setEnabled?.(message, { targetUuid, id: label, enabled: true });
    return;
  }
  await setDamagePillEnabled(message, targetUuid, label, true);
  await game.modules.get("draw-steel-combat-tools")?.api?.damagePills?.setEnabled?.(message, { targetUuid, label, enabled: true });
}

async function _addOwnerAsTarget(entry) {
  const message = game.messages.get(entry.sourceMessageId);
  const owner = await fromUuid(entry.ownerActorUuid).catch(() => null);
  const actor = owner?.actor ?? owner;
  const token = actor?.getActiveTokens?.(false, true)?.[0] ?? null;
  if (!message || !token) return;
  if (message.getFlag("draw-steel-target-damage", "state") && await addTarget(message, token)) {
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.AddedAsTarget", { name: token.name, ability: entry.causeLabel || entry.itemName }));
    return;
  }
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.TargetByHand", { name: token.name }));
}

async function _expendEffect(ownerUuid, name) {
  const owner = await fromUuid(ownerUuid).catch(() => null);
  const actor = owner?.actor ?? owner;
  const want = String(name).toLowerCase();
  const effect = actor?.effects?.find((e) => String(e.name ?? "").toLowerCase() === want);
  if (effect) await effect.delete().catch((err) => console.warn(`${MODULE_ID} | could not expend ${name} on ${actor.name}`, err));
}

async function _applyQueuedMark({ kind, ownerUuid, otherUuid, spec, sourceName, sourceUuid }) {
  const owner = await fromUuid(ownerUuid).catch(() => null);
  const other = await fromUuid(otherUuid).catch(() => null);
  if (!owner || !other) return;
  try {
    if (kind === "victim") await markVictim(owner, other, spec, sourceName);
    else await markDealer(owner, other, spec, sourceUuid ? await fromUuid(sourceUuid).catch(() => null) : null);
  } catch (err) {
    console.warn(`${MODULE_ID} | a mark from the stack could not be applied to ${other.name}`, err);
  }
}

async function _onQueueResolve(id, outcome, userName) {
  if (!isPrimaryGM()) return;
  const entry = _queue.find((e) => e.id === id);
  if (!entry || entry.state !== "pending") return;
  entry.state = outcome;
  if (outcome === "used") noteSquadUse(entry);
  if (outcome === "used" && entry.featureLine?.exclusive) {
    for (const other of _queue.filter((q) => q !== entry && q.state === "pending" && q.ownerActorUuid === entry.ownerActorUuid
      && q.featureLine?.exclusive === entry.featureLine.exclusive)) _onQueueResolve(other.id, "dismissed");
  }
  if (outcome === "used") entry.usedAt = Date.now();
  if (outcome === "used" && entry.pill) await _enableBonusPill(entry.pill);
  if (outcome === "used" && entry.mark) await _applyQueuedMark(entry.mark);
  if (outcome === "used" && entry.featureLine) _useFeatureLine(entry);
  if (outcome === "used" && entry.defersDeath) {
    const run = fromUuid(entry.heldDamage?.deathActorUuid ?? entry.heldDamage?.actorUuid ?? "")
      .then((dying) => deferDeath(dying, entry.itemName))
      .catch((err) => console.warn(`${MODULE_ID} | Death Deferred was not applied`, err));
    const hold = _damageHolds.get(entry.damageId);
    if (hold) hold.deferring = run;
    await run;
  }
  if (outcome === "used" && entry.halvesOnUse && entry.resume?.itemUuid) {
    Hooks.callAll("dst.targetedHalfUsed", {
      abilityUuid: entry.resume.itemUuid,
      targetActorUuid: entry.ownerActorUuid,
      sourceActorUuid: entry.ownerActorUuid,
      modName: entry.itemName,
    });
  }
  if (outcome === "used" && entry.reflectHalf && entry.resume?.itemUuid) {
    const striker = fromUuidSync(entry.resume.itemUuid)?.actor ?? null;
    if (striker) Hooks.callAll("dst.targetedHalfUsed", { abilityUuid: entry.resume.itemUuid, targetActorUuid: striker.uuid, sourceActorUuid: entry.ownerActorUuid, modName: entry.itemName });
  }
  if (outcome === "used" && entry.fmMode === "stability") await _shareStabilityOnUse(entry);
  if (outcome === "used" && entry.fmPerSurge) await _spendSurgesOnUse(entry);
  dbg(`queue resolve ${id} -> ${outcome}`);

  
  if (outcome === "used" && entry.itemUuid
    && (entry.fmMode || entry.rollMod || entry.redirect || entry.halvesOnUse || entry.reflectHalf
      || hasBespokeUse(fromUuidSync(entry.itemUuid)?.system?._dsid))) {
    _automatedUses.set(entry.itemUuid, Date.now());
  }

  
  if (outcome === "used" && entry.expend) await _expendEffect(entry.ownerActorUuid, entry.expend);
  if (outcome === "used" && entry.addSelfTarget) await _addOwnerAsTarget(entry);
  if (outcome === "used" && entry.itemUuid && (Number.isFinite(entry.triggerDamage) || entry.eventSubjectUuid || entry.expend)) {
    const subject = entry.eventSubjectUuid ? fromUuidSync(entry.eventSubjectUuid)?.actor ?? null : null;
    const level = Number(subject?.system?.level ?? subject?.system?.details?.level) || 0;
    _triggerDamageUses.set(entry.itemUuid, { amount: Number.isFinite(entry.triggerDamage) ? entry.triggerDamage : null,
      type: entry.triggerDamageType ?? null, level: subject ? level || 1 : null, expended: entry.expend ?? null, at: Date.now() });
  }

  
  if (outcome === "used" && entry.fmMode && entry.resumeId) {
    const running = _applyFmRunning(entry);
    if (entry.fmMode === "redirect" || running === 0) {
      _dismissPendingRedirects(entry.resumeId, `${entry.itemName} left nothing to redirect`);
    }
  }

  if (outcome === "used" && entry.villain) {
    _recordVillain(entry, true);
    _dismissVillainSiblings(entry);
  }

  if (entry.gain) resolveStackGain(entry, outcome);

  if (outcome === "declined" && !entry.villain && !entry.gain) _postDeclineRecord(entry.ownerActorUuid, entry.ownerName, entry.itemName, lineMandatory(entry.featureLine));

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
            redirect: e.redirect ?? null, redirectPool: e.redirectPool ?? null, rollMod: e.rollMod ?? null,
            fmMode: e.fmMode ?? null, fmChar: e.fmChar ?? null, fmAmount: e.fmAmount ?? null,
            fmPerSurge: e.fmPerSurge ?? null, fmSurges: e.fmSurges ?? null,
            subjectTokenUuid: e.subjectTokenUuid ?? null,
            subjectTokenUuids: e.subjectTokenUuids ?? null,
            villain: e.villain ?? null,
          }));
        const awaiting = new Set(usedEntries.filter((u) => !_postedAfterUse(u.itemUuid, u.usedAt)).map((u) => u.itemUuid));
        if (!awaiting.size) {
          _removeHeld(entry.resumeId);
          _finishResume(usedEntries, resume);
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
    if (outcome === "used" && !entry.defersDeath) {
      hold.anyUsed = true;
      (hold.usedItems ??= new Set()).add(entry.itemUuid);
      (hold.usedEntries ??= []).push({ itemUuid: entry.itemUuid, ownerActorUuid: entry.ownerActorUuid, ownerName: entry.ownerName, itemName: entry.itemName, usedAt: entry.usedAt, halfDamage: entry.halfDamage ?? false, damageReduction: entry.damageReduction ?? null,
        damageRedirect: entry.damageRedirect ?? null, redirectRange: entry.redirectRange ?? null, unreducible: !!entry.unreducible });
    }
  }
  for (const damageId of new Set(_choiceIds(entry, "damageId"))) {
    if (_damageHolds.has(damageId) && !_groupPending("damageId", damageId)) _completeDamageGroup(damageId);
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
        reflectHalf: entry.reflectHalf ?? false, redirectPool: entry.redirectPool ?? null,
        halfOnUse: entry.halfOnUse ?? false, postHoc: entry.postHoc ?? false,
        subjectTargetKey: entry.subjectTargetKey ?? null, subjectName: entry.subjectName ?? "",
        subjectTokenUuid: entry.subjectTokenUuid ?? null, subjectTokenUuids: entry.subjectTokenUuids ?? null,
      });
    }
    if (!_queue.some((e) => e.resolutionId === entry.resolutionId && e.state === "pending")) {
      _completeResolutionGroup(entry.resolutionId);
    }
  }
  _broadcast();
}

function _useFeatureLine(entry) {
  if (entry.featureLine?.countdown?.start) {
    const holder = fromUuidSync(entry.ownerActorUuid);
    startCountdown(holder?.actor ?? holder, entry.featureLine.key, entry.featureLine.countdown).catch((err) => console.warn(`${MODULE_ID} | could not start a countdown`, err));
  }
  if (entry.derived) {
    const owner = fromUuidSync(entry.ownerActorUuid);
    if (owner) noteFeatureLineUse(owner, entry.featureLine.key);
    return;
  }
  _recentAbilityPosts.set(entry.itemUuid, Date.now());
  const owner = fromUuidSync(entry.ownerActorUuid);
  if (!owner) return;
  noteFeatureLineUse(owner, entry.featureLine.key);
  const cost = Number(entry.featureLine.resourceCost) || 0;
  const pool = entry.featureLine.resourcePath ?? "system.hero.primary.value";
  const held = Number(foundry.utils.getProperty(owner, pool));
  if (cost && Number.isFinite(held)) owner.update({ [pool]: Math.max(0, held - cost) }).catch(() => {});
  if (entry.featureLine.action === "triggered") setTriggeredActionSpent(owner, true).catch(() => {});
  const item = fromUuidSync(entry.itemUuid);
  if (!item) return;
  postFeatureCard(item, {
    lineKey: entry.featureLine.key,
    speaker: ds.documents.DrawSteelChatMessage.getSpeaker({ actor: owner }),
    flags: { [MODULE_ID]: { reminder: { event: "FEATURE_USE" }, featureUse: { itemUuid: entry.itemUuid, key: entry.featureLine.key } } },
  });
}

export const deathOfferedFor = (actorUuid) =>
  _queue.some((e) => e.kind === "damageHeld" && e.heldDamage?.deathOffered && e.heldDamage.actorUuid === actorUuid);

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
      sourceActorUuid: u.ownerActorUuid ?? targetActorUuid,
      modName: u.itemName,
      messageId: hold.messageId,
    });
  }
  
  const retargets = await _resolveRetargetPicks(_collectRetargets(used), { itemUuid: hold.abilityUuid }).catch(() => []);
  for (const rt of retargets) {
    const u = used.find((x) => x.itemUuid === rt.itemUuid) ?? {};
    const token = await _resolutionRedirectToken(rt, hold);
    if (!token) {
      ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Queue.RedirectNoToken", { modName: rt.modName }));
      continue;
    }
    const actor = token.actor ?? null;
    asPrimaryGM("applyResolutionRedirect", {
      messageId: hold.messageId,
      origTargetUuid: rt.removeTokenUuid,
      modName: rt.modName,
      halfOnUse: u.halfOnUse === true || (rt.mode === "reflect" && u.reflectHalf === true),
      ownerName: u.ownerName ?? "",
      newTarget: {
        tokenUuid: token.uuid, tokenId: token.id, sceneId: token.parent?.id ?? null,
        actorUuid: actor?.uuid ?? null, actorId: actor?.id ?? null,
        name: token.name ?? actor?.name ?? "",
        tokenImg: token.texture?.src ?? null, actorImg: actor?.img ?? null,
        img: token.texture?.src ?? actor?.img ?? null,
      },
    });
    if (rt.mode === "swap") {
      const old = await fromUuid(rt.removeTokenUuid).catch(() => null);
      ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.RedirectSwapNote", { a: token.name ?? "", b: old?.name ?? "" }));
    }
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
  const banes = Math.max(0, Math.min(2, baseBanes + (u.rollMod.banes ?? 0) - (u.rollMod.negateBane && baseBanes > 0 ? 1 : 0)));
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
  const applyTier = game.modules.get("draw-steel-combat-tools")?.api?.rollDialog?.applyTierMods;
  if (applyTier && roll.options?.dsctTier) tier = applyTier(tier, roll.options.dsctTier);
  if (u.rollMod.tierShift) tier = Math.min(3, Math.max(1, tier + u.rollMod.tierShift));

  state.tierOverrides = state.tierOverrides ?? {};
  state.tierOverrides[u.subjectTargetKey] = {
    tier, total, naturalTotal: natural, staticModifier, edges, banes, bonuses,
    isCritical: natural >= critThreshold,
    dstModName: u.itemName,
    dstSrcName: u.ownerName ?? null,
    ...(u.rollMod.tierShift ? { dstTierShift: u.rollMod.tierShift } : {}),
    dstSrcTokenId: (u.ownerActorUuid ? fromUuidSync(u.ownerActorUuid) : null)?.getActiveTokens?.(true, false)?.[0]?.id ?? null,
  };
  state.updatedAt = Date.now();
  await message.setFlag("draw-steel-target-damage", "state", state);
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.RollModApplied", { modName: u.itemName, name: u.subjectName, tier }));
}

async function _finalizeDamageHold(damageId) {
  const hold = _damageHolds.get(damageId);
  if (!hold) {
    _removeDamageHeldEntry(damageId);
    _broadcast();
    return;
  }
  _damageHolds.delete(damageId);
  const heldEntry = _queue.find((e) => e.damageId === damageId && e.kind === "damageHeld");
  if (heldEntry) {
    heldEntry.state = "resolving";
    delete heldEntry.graceUntil;
    _broadcast();
  }
  try {
    await hold.deferring;
    await _settleDamageHold(hold);
  } finally {
    _removeDamageHeldEntry(damageId);
    _broadcast();
  }
}

function _uncappedSquadHit(hold, actor) {
  const message = hold.dstd?.messageId ? game.messages.get(hold.dstd.messageId) : null;
  const record = message ? foundry.utils.getProperty(message.flags, `draw-steel-target-damage.state.applications.${hold.dstd.opId}`) : null;
  const amount = Number(record?.amount);
  if (!Number.isFinite(amount)) return null;
  const damage = actor?.system?.damage ?? {};
  const type = record.damageType ?? "";
  const weakness = Math.max(Number(damage.weaknesses?.all ?? 0) || 0, Number(damage.weaknesses?.[type] ?? 0) || 0);
  const immunity = Math.max(Number(damage.immunities?.all ?? 0) || 0, Number(damage.immunities?.[type] ?? 0) || 0);
  return Math.max(0, amount + weakness - immunity);
}

export function noteHeldLinked(hold) {
  if (!hold?.squad?.areaCap) return;
  const damageId = [..._damageHolds].find(([, h]) => h === hold)?.[0];
  if (!damageId) return;
  const original = _uncappedSquadHit(hold, fromUuidSync(hold.actorUuid));
  if (!(original > hold.amount)) return;
  for (const e of _queue) {
    if (e.damageId === damageId && e.heldDamage) e.heldDamage = { ...e.heldDamage, original };
  }
  _broadcast();
}

export function reductionAmount(cut, actor) {
  if (typeof cut === "number") return cut;
  if (cut === "level") return Number(actor?.system?.level ?? 0) || 0;
  if (cut && typeof cut === "object") return (Number(cut.base) || 0) + (Number(actor?.system?.characteristics?.[cut.char]?.value) || 0);
  return 0;
}

function _damageRedirectCandidates(hold, u) {
  const victim = hold.tokenUuid ? fromUuidSync(hold.tokenUuid) : null;
  const tokens = (canvas.tokens?.placeables ?? []).filter((t) => t.actor && t.document.uuid !== victim?.uuid && t.actor.uuid !== hold.actorUuid);
  if (u.damageRedirect !== "pool") return tokens;
  const owner = u.ownerActorUuid ? fromUuidSync(u.ownerActorUuid) : null;
  const ownerToken = owner?.getActiveTokens?.(false, true)?.[0] ?? null;
  if (!ownerToken) return tokens.filter((t) => t.actor === owner);
  const reach = (Number(u.redirectRange) || 0) * (canvas.grid.distance || 1);
  return tokens.filter((t) => t.actor === owner || (t.document.disposition === ownerToken.disposition
    && (!reach || footprintGap(ownerToken, t.document) < reach)));
}

async function _onPickDamageRedirect({ modName, tokenUuids = [], allowNone = false } = {}) {
  const tokens = tokenUuids.map((u) => fromUuidSync(u)?.object).filter(Boolean);
  if (allowNone) {
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: modName },
      content: `<p>${foundry.utils.escapeHTML(game.i18n.format("DS_TRIGGERS.Queue.DamageRedirectAsk", { modName }))}</p>`,
      buttons: [
        { action: "pick", label: game.i18n.localize("DS_TRIGGERS.Queue.DamageRedirectPick"), default: true, disabled: !tokens.length },
        { action: "none", label: game.i18n.localize("DS_TRIGGERS.Queue.DamageRedirectNone") },
      ],
      rejectClose: false,
    }).catch(() => null);
    if (choice !== "pick") return "none";
  }
  if (!tokens.length) return allowNone ? "none" : null;
  const picked = await _runTriggerPicker(tokens, game.i18n.format("DS_TRIGGERS.Queue.DamageRedirectHint", { modName }));
  return picked?.document?.uuid ?? (allowNone ? "none" : null);
}

async function _redirectHeldDamage(hold, u) {
  const director = u.damageRedirect === "director";
  const pickUser = director ? primaryGM() : _pickUserFor(u.ownerActorUuid);
  const payload = { modName: u.itemName, tokenUuids: _damageRedirectCandidates(hold, u).map((t) => t.document.uuid), allowNone: director };
  const ownerToken = u.damageRedirect === "owner" ? fromUuidSync(u.ownerActorUuid)?.getActiveTokens?.(false, true)?.[0] ?? null : null;
  const picked = ownerToken ? ownerToken.document.uuid
    : pickUser && !pickUser.isSelf
      ? await socket.executeAsUser("pickDamageRedirect", pickUser.id, payload).catch(() => null)
      : await _onPickDamageRedirect(payload);
  const victim = await fromUuid(hold.actorUuid).catch(() => null);
  const typeLabel = hold.damageType ? game.i18n.localize(ds.CONFIG.damageTypes?.[hold.damageType]?.label ?? hold.damageType) : "";
  const amount = typeLabel ? `${hold.amount} ${typeLabel}` : String(hold.amount);
  if (!picked) {
    ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Queue.DamageRedirectSkipped", { modName: u.itemName }));
    return false;
  }
  Hooks.callAll("dst.damageHoldResolved", { hold, finalAmount: 0 });
  if (picked === "none") {
    postSystemCard({
      title: game.i18n.localize("DS_TRIGGERS.Queue.RedirectAfterHeader"),
      flavor: null,
      kind: "Redirect",
      content: cardContent({ intro: foundry.utils.escapeHTML(game.i18n.format("DS_TRIGGERS.Queue.DamageRedirectByHand", { modName: u.itemName, name: victim?.name ?? "", amount })) }),
      whisper: game.users.filter((x) => x.isGM).map((x) => x.id),
      flags: { [MODULE_ID]: { reminder: { event: "REDIRECT_AFTER" } } },
    });
    return true;
  }
  const target = (await fromUuid(picked).catch(() => null))?.actor ?? null;
  if (!target) return true;
  const options = { ...(hold.damageOptions ?? {}), ...(u.unreducible ? { ignoredImmunities: ["all"], dstBypass: true } : {}) };
  if (u.unreducible) _damageBypass.add(target.uuid);
  try {
    await target.system.takeDamage(hold.amount, options);
  } finally {
    _damageBypass.delete(target.uuid);
  }
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.RedirectApplied", { modName: u.itemName, newName: target.name, oldName: victim?.name ?? "" }));
  return true;
}

async function _settleDamageHold(hold) {
  if (!hold.anyUsed) {
    await _applyHeldDamage(hold, hold.amount);
    Hooks.callAll("dst.damageHoldResolved", { hold, finalAmount: hold.amount });
    return;
  }
  const redirect = (hold.usedEntries ?? []).find((u) => !u.cancelled && u.damageRedirect);
  if (redirect && await _redirectHeldDamage(hold, redirect)) return;

  
  
  const actor = await fromUuid(hold.actorUuid).catch(() => null);
  const F = (k, data) => game.i18n.format(`DS_TRIGGERS.Queue.${k}`, data);
  const typeLabel = hold.damageType
    ? game.i18n.localize(ds.CONFIG.damageTypes?.[hold.damageType]?.label ?? hold.damageType)
    : null;
  
  const cap = hold.squad?.areaCap ?? null;
  const base = cap && hold.amount >= cap ? Math.max(hold.amount, _uncappedSquadHit(hold, actor) ?? 0) : hold.amount;
  const amountLabel = typeLabel ? `${base} ${typeLabel}` : base;
  let mitigationNote = "";
  if (cap) mitigationNote += `<p class="hint">${F("HeldDamageAreaCap", { n: cap })}</p>`;
  if (hold.damageOptions && actor?.system?.calculateImmunityAndWeakness) {
    const { immunity = 0, weakness = 0 } = actor.system.calculateImmunityAndWeakness({ ...hold.damageOptions });
    if (immunity > 0) mitigationNote += `<p class="hint">${F("HeldDamageImmunityNote", { n: immunity })}</p>`;
    if (weakness > 0) mitigationNote += `<p class="hint">${F("HeldDamageWeaknessNote", { n: weakness })}</p>`;
  }
  const seedPills = [];
  for (const u of hold.usedEntries ?? []) {
    if (u.cancelled || (!u.halfDamage && !u.damageReduction)) continue;
    const owner = u.ownerActorUuid ? fromUuidSync(u.ownerActorUuid) : null;
    const cut = u.damageReduction ? reductionAmount(u.damageReduction, owner) : 0;
    seedPills.push({
      ...(u.halfDamage ? { kind: "half" } : { kind: "delta", value: -cut }), label: u.itemName, src: u.ownerName ?? null,
      srcTokenId: owner?.getActiveTokens?.(true, false)[0]?.id ?? null, source: "trigger",
    });
  }

  const outcome = await openDamageModWindow({
    title: F("HeldDamageTitle", { name: actor?.name ?? "" }),
    hint: `${F("HeldDamageHint", { amount: amountLabel })}${mitigationNote}`,
    base,
    pills: seedPills,
  });
  const result = outcome ? (cap ? Math.min(Number(outcome.final), cap) : outcome.final) : null;

  if (result != null && Number(result) >= 0 && hold.dstd?.messageId && hold.dstd?.opId) {
    const dstdMessage = game.messages.get(hold.dstd.messageId);
    if (dstdMessage && outcome.pills.length) {
      dstdMessage.setFlag(MODULE_ID, `damagePills.${hold.dstd.opId}`, {
        base,
        pills: outcome.pills.map((p) => ({ kind: p.kind, value: p.value ?? null, label: p.label ?? "", src: p.src ?? null, srcTokenId: p.srcTokenId ?? null, source: p.source ?? "manual", ...(p.enabled === false ? { enabled: false } : {}) })),
        final: Number(result),
      }).catch(() => {});
    }
  }

  if (result == null || !(Number(result) > 0)) {
    batchedNotice("HeldDamageDiscarded", actor?.name ?? "", { level: "warn" });
    Hooks.callAll("dst.damageHoldResolved", { hold, finalAmount: 0 });
    return;
  }
  const typePill = damagePillType(outcome.pills);
  if (typePill != null && hold.damageOptions) hold.damageOptions = { ...hold.damageOptions, type: typePill };
  await _applyHeldDamage(hold, Number(result));
  Hooks.callAll("dst.damageHoldResolved", { hold, finalAmount: Number(result) });
}

const _squadWrites = new Map();

async function _applyHeldDamage(hold, amount) {
  if (!(amount > 0)) return;
  if (hold.squad) {
    const key = hold.squad.groupUuid;
    const run = (_squadWrites.get(key) ?? Promise.resolve()).then(async () => {
      const group = await fromUuid(key).catch(() => null);
      if (!group) return;
      await group.update({ "system.staminaValue": Number(group.system?.staminaValue ?? 0) - amount },
        { ds: hold.squad.ds, dstd: hold.squad.dstd, dstBypass: true });
    });
    _squadWrites.set(key, run.catch(() => {}));
    return run;
  }
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

async function _resolutionRedirectToken(rt, hold) {
  if (rt.mode === "choice" && rt.newTokenUuid) return (await fromUuid(rt.newTokenUuid).catch(() => null)) ?? null;
  const actorUuid = rt.mode === "reflect" ? hold.rollerActorUuid : rt.ownerActorUuid;
  const actor = actorUuid ? fromUuidSync(actorUuid) : null;
  if (rt.mode === "reflect") {
    const message = game.messages.get(hold.messageId);
    const speaker = message?.speaker?.scene && message.speaker.token ? game.scenes.get(message.speaker.scene)?.tokens?.get(message.speaker.token) : null;
    if (speaker) return speaker;
  }
  return actor?.getActiveTokens?.(true, true)?.[0] ?? null;
}

function _collectRetargets(usedEntries) {
  const out = [];
  for (const u of usedEntries ?? []) {
    if (u.cancelled) continue;
    if (!u.redirect || u.redirect === "after") continue;
    const subjects = (u.subjectTokenUuids?.length ? u.subjectTokenUuids : [u.subjectTokenUuid]).filter(Boolean);
    if (!subjects.length) continue;
    out.push({
      mode: u.redirect,
      modName: u.itemName,
      itemUuid: u.itemUuid ?? null,
      ownerActorUuid: u.ownerActorUuid ?? null,
      removeTokenUuid: subjects[0],
      subjectTokenUuids: subjects,
      newActorUuid: (u.redirect === "reflect" || u.redirect === "chooser" || u.redirect === "flanker") ? null : u.ownerActorUuid,
      pool: u.redirectPool ?? null,
    });
  }
  return out;
}

function _pickUserFor(ownerActorUuid) {
  const owner = ownerActorUuid ? fromUuidSync(ownerActorUuid) : null;
  return (owner
    ? game.users.find((x) => x.active && !x.isGM && owner.testUserPermission(x, "OWNER"))
    : null) ?? primaryGM() ?? null;
}

async function _resolveRetargetPicks(retargets, resume) {
  const out = [];
  for (const r of retargets ?? []) {
    const pickUser = _pickUserFor(r.ownerActorUuid);
    if (getSetting("debugMode")) console.log(`DS_TRIGGERS | resolveRetargetPicks: mode=${r.mode} mod=${r.modName} pickUser=${pickUser?.name ?? null} subjects=${r.subjectTokenUuids.length}`);
    if (r.subjectTokenUuids.length > 1 && pickUser) {
      const picked = await socket.executeAsUser("pickRedirectSubject", pickUser.id, r.modName, r.subjectTokenUuids).catch(() => null);
      if (picked) r.removeTokenUuid = picked;
    }
    if (r.mode === "flanker") {
      const striker = resume?.itemUuid ? fromUuidSync(resume.itemUuid)?.actor : null;
      const flanker = flankingAllyOf(striker?.getActiveTokens?.(false, true)?.[0] ?? null, r.removeTokenUuid);
      if (!flanker) {
        ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Queue.RedirectNoFlanker", { modName: r.modName }));
        continue;
      }
      r.mode = "choice";
      r.newTokenUuid = flanker.document.uuid;
      r.ignoreRange = true;
    }
    if (r.mode === "chooser") {
      if (!pickUser) continue;
      const ctx = { triggerItemUuid: r.itemUuid ?? null, triggeringUuid: resume?.itemUuid ?? null, pool: r.pool ?? null, ownerActorUuid: r.ownerActorUuid ?? null };
      const picked = await socket.executeAsUser("pickRedirectTarget", pickUser.id, r.modName, r.removeTokenUuid, ctx).catch(() => null);
      if (!picked) continue;
      r.mode = "choice";
      r.newTokenUuid = picked;
    }
    out.push(r);
  }
  return out;
}

function _resumeFall(resume, usedItemUuids) {
  if (game.users.get(resume.userId)?.active) socket?.executeForUsers("resumeFall", [resume.userId], resume.fallId, usedItemUuids);
}

function _finishResume(usedEntries, resume) {
  if (getSetting("debugMode")) console.log(`DS_TRIGGERS | finishResume: used=${(usedEntries ?? []).map((u) => `${u.itemName}:${u.redirect ?? "-"}`).join(",")} resume=${resume?.itemUuid ?? resume?.fmId ?? resume?.kind ?? null}`);
  if (resume?.kind === "fall") {
    _resumeFall(resume, (usedEntries ?? []).map((u) => u.itemUuid));
    return;
  }
  if (resume?.kind === "turn") {
    asPrimaryGM("resumeTurn", resume, (usedEntries ?? []).filter((u) => !u.villain).map((u) => ({
      itemUuid: u.itemUuid, ownerActorUuid: u.ownerActorUuid, ownerName: u.ownerName, itemName: u.itemName,
    })));
    return;
  }
  _postRedirectReminders(usedEntries, resume);
  _resolveRetargetPicks(_collectRetargets(usedEntries), resume)
    .then((retargets) => _dispatchResume(resume, retargets, _collectRollMods(usedEntries), _collectFmMods(usedEntries)))
    .catch((err) => {
      dbg("retarget pick resolution failed", err);
      _dispatchResume(resume, [], _collectRollMods(usedEntries), _collectFmMods(usedEntries));
    });
}

function _fmSpendUsed(itemUuid) {
  const item = itemUuid ? fromUuidSync(itemUuid) : null;
  const spendIds = new Set((item?.system?.effects?.documentsByType?.spend ?? []).map((e) => e.id));
  if (!spendIds.size) return false;
  const msgs = game.messages.contents;
  const now = Date.now();
  for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 30); i--) {
    const m = msgs[i];
    if (now - m.timestamp > 300000) break;
    const part = m.system?.parts?.contents?.find((p) => p.type === "abilityUse" && p.abilityUuid === itemUuid);
    if (!part) continue;
    return (part.effects ?? []).some((id) => spendIds.has(id));
  }
  return false;
}

const _onPickStabilityShare = (ownerName, max, sourceName) => pickStabilityShare(ownerName, max, sourceName);
const _onPickSurgeSpend = (ownerName, max, sourceName) => pickSurgeSpend(ownerName, max, sourceName);

async function _spendSurgesOnUse(entry) {
  const owner = fromUuidSync(entry.ownerActorUuid);
  const have = Math.max(0, Math.floor(Number(owner?.system?.hero?.surges) || 0));
  const max = Math.min(Number(entry.fmPerSurge) || 0, have);
  entry.fmSurges = 0;
  if (!owner) return;
  if (!max) {
    ui.notifications.warn(game.i18n.format("DS_TRIGGERS.LineEffect.SurgeNone", { owner: owner.name }));
    return;
  }
  const pickUser = _pickUserFor(entry.ownerActorUuid);
  const n = pickUser && !pickUser.isSelf
    ? await socket.executeAsUser("pickSurgeSpend", pickUser.id, owner.name, max, entry.itemName).catch(() => null)
    : await pickSurgeSpend(owner.name, max, entry.itemName);
  if (!n) return;
  await owner.update({ "system.hero.surges": have - n });
  entry.fmSurges = n;
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.LineEffect.SurgeSpent", { owner: owner.name, n, source: entry.itemName }));
}

async function _shareStabilityOnUse(entry) {
  const owner = fromUuidSync(entry.ownerActorUuid);
  const held = _queue.find((e) => e.resumeId === entry.resumeId && e.kind === "held");
  const ally = held?.ownerActorUuid ? fromUuidSync(held.ownerActorUuid) : null;
  const max = Math.max(0, Math.floor(Number(owner?.system?.combat?.stability) || 0));
  if (!owner || !ally) return;
  if (!max) {
    ui.notifications.warn(game.i18n.format("DS_TRIGGERS.LineEffect.StabilityNone", { owner: owner.name }));
    return;
  }
  const pickUser = _pickUserFor(entry.ownerActorUuid);
  const n = pickUser && !pickUser.isSelf
    ? await socket.executeAsUser("pickStabilityShare", pickUser.id, owner.name, max, entry.itemName).catch(() => null)
    : await pickStabilityShare(owner.name, max, entry.itemName);
  if (n) await shareStability(owner, ally, n, entry.itemName, fromUuidSync(entry.itemUuid)?.img ?? null);
}

function _applyFmRunning(entry) {
  const held = _queue.find((e) => e.resumeId === entry.resumeId && e.kind === "held");
  if (!held || held.fmDistance == null) return null;
  const amount = _fmAmount(entry);
  held.fmTrail = [...(held.fmTrail ?? []), {
    itemUuid: entry.itemUuid, ownerActorUuid: entry.ownerActorUuid ?? null, fmChar: entry.fmChar ?? null, fmAmount: entry.fmAmount ?? null,
    fmPerSurge: entry.fmPerSurge ?? null, fmSurges: entry.fmSurges ?? null,
    modName: entry.itemName, ownerName: entry.ownerName ?? "", mode: entry.fmMode,
    amount: entry.fmMode === "reduce" ? -amount : entry.fmMode === "boost" ? amount : 0,
  }];
  return _replayFmTrail(held);
}

function _replayFmTrail(held) {
  let running = Number(held.fmDistance) || 0;
  for (const t of held.fmTrail ?? []) running = Math.max(0, running + (Number(t.amount) || 0));
  held.fmRunning = running;
  return running;
}

function _refreshFmRunning(abilityUuid) {
  let touched = false;
  for (const held of _queue) {
    if (held.kind !== "held" || held.fmDistance == null) continue;
    let changed = false;
    held.fmTrail = (held.fmTrail ?? []).map((t) => {
      if (t.itemUuid !== abilityUuid) return t;
      const signed = t.mode === "reduce" ? -_fmAmount(t) : t.mode === "boost" ? _fmAmount(t) : 0;
      if (signed === t.amount) return t;
      changed = true;
      return { ...t, amount: signed };
    });
    if (!changed) continue;
    touched = true;
    dbg(`fm trail corrected on ${held.resumeId}: now ${_replayFmTrail(held)}`);
    if (held.fmRunning === 0) _dismissPendingRedirects(held.resumeId, "the correction emptied it");
  }
  return touched;
}

function _recordVillain(entry, used) {
  const combat = game.combats.get(entry.villain?.combatId);
  setVillainUsed(combat, entry.villain?.tokenId, fromUuidSync(entry.itemUuid)?.id, used).catch((err) => dbg("villain record failed", err));
}

function _dismissVillainSiblings(entry) {
  for (const other of _queue) {
    if (other === entry || other.state !== "pending" || other.villain?.tokenId !== entry.villain.tokenId) continue;
    other.state = "dismissed";
    dbg(`queue dismiss ${other.id} (${other.itemName}): the villain has acted this round`);
  }
}

async function _onVillainMarkUsed(id) {
  if (!isPrimaryGM()) return;
  const entry = _queue.find((e) => e.id === id);
  if (!entry?.villain || entry.state !== "pending") return;
  _recordVillain(entry, true);
  _dismissVillainSiblings(entry);
  await _onQueueResolve(id, "dismissed");
}

async function _onVillainDismiss(tokenId) {
  if (!isPrimaryGM()) return;
  const ids = _queue.filter((e) => e.state === "pending" && e.villain?.tokenId === tokenId).map((e) => e.id);
  for (const id of ids) await _onQueueResolve(id, "dismissed");
}

export function markVillainUsed(id) {
  return asPrimaryGM("villainMarkUsed", id);
}

export function dismissVillainEntries(tokenId) {
  return asPrimaryGM("villainDismiss", tokenId);
}

function _dismissPendingRedirects(resumeId, why) {
  for (const other of _queue) {
    if (other.resumeId !== resumeId || other.state !== "pending" || other.fmMode !== "redirect") continue;
    other.state = "dismissed";
    dbg(`queue dismiss ${other.id} (${other.itemName}): ${why}`);
  }
}

function _fmAmount(entry) {
  if (entry?.fmAmount != null) return Number(entry.fmAmount) || 0;
  const owner = entry?.ownerActorUuid ? fromUuidSync(entry.ownerActorUuid) : null;
  const amount = Math.max(0, Number(owner?.system?.characteristics?.[entry?.fmChar]?.value ?? 0));
  if (entry?.fmPerSurge) return amount * (Number(entry.fmSurges) || 0);
  return (amount && _fmSpendUsed(entry.itemUuid)) ? amount * 2 : amount;
}

function _collectFmMods(usedEntries) {
  const out = { deltas: [], redirect: null, after: [] };
  const ordered = [...(usedEntries ?? [])].sort((a, b) => (a.usedAt ?? 0) - (b.usedAt ?? 0));
  for (const u of ordered) {
    if (u.cancelled || !u.fmMode) continue;
    const amount = _fmAmount(u);
    const base = { modName: u.itemName, ownerName: u.ownerName, ownerActorUuid: u.ownerActorUuid ?? null };
    if (u.fmMode === "reduce" || u.fmMode === "boost") {
      const signed = { ...base, amount: u.fmMode === "reduce" ? -amount : amount };
      (out.redirect ? out.after : out.deltas).push(signed);
    } else if (u.fmMode === "slide" || u.fmMode === "pull") {
      out.movement ??= { ...base, to: u.fmMode };
    } else if (u.fmMode === "vertical") {
      out.vertical ??= base;
    } else if (u.fmMode === "objectDamage") {
      out.objectDamage = (out.objectDamage ?? 0) + amount;
    } else if (u.fmMode === "redirect" && !out.redirect) {
      const owner = u.ownerActorUuid ? fromUuidSync(u.ownerActorUuid) : null;
      const driveUser = (owner
        ? game.users.find((x) => x.active && !x.isGM && owner.testUserPermission(x, "OWNER"))
        : null) ?? primaryGM();
      out.redirect = { ...base, amount, driveUserId: driveUser?.id ?? null };
    }
  }
  return (out.deltas.length || out.after.length || out.redirect || out.movement || out.vertical || out.objectDamage) ? out : null;
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
      bonus: u.rollMod.bonus ?? 0,
      tierShift: u.rollMod.tierShift ?? 0,
      negateBane: !!u.rollMod.negateBane,
      scopeTokenUuid: u.rollMod.perTarget ? (u.subjectTokenUuid ?? u.subjectTokenUuids?.[0] ?? null) : null,
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
    await postRedirectCard(u, { after, recipients: [...recipients] });
  }
}

export async function postRedirectCard(u, { after = true, recipients = [] } = {}) {
  const esc = foundry.utils.escapeHTML;
  const owner = u.ownerActorUuid ? await fromUuid(u.ownerActorUuid).catch(() => null) : null;
  const sentence = game.i18n.format(after ? "DS_TRIGGERS.Queue.RedirectAfterBody" : "DS_TRIGGERS.Queue.RedirectPostHocBody", { owner: u.ownerName, ability: u.itemName });
  const intro = withFaces(sentence, [owner]).replace(esc(u.itemName), `<strong>${esc(u.itemName)}</strong>`);
  const pickBtn = after && game.modules.get("draw-steel-target-damage")?.active
    ? `<button type="button" class="dst-after-pick-btn" data-owner-actor-uuid="${u.ownerActorUuid ?? ""}" data-mod-name="${esc(u.itemName)}"><i class="fa-solid fa-bullseye" inert></i> ${game.i18n.localize("DS_TRIGGERS.Queue.AfterPickButton")}</button>`
    : "";
  return postSystemCard({
    title: game.i18n.localize("DS_TRIGGERS.Queue.RedirectAfterHeader"),
    flavor: null,
    kind: "Redirect",
    content: cardContent({ intro, buttons: pickBtn }),
    whisper: recipients,
    flags: { [MODULE_ID]: { reminder: { event: "REDIRECT_AFTER" } } },
  });
}

function _dispatchResume(resume, retargets = [], rollMods = [], fmMods = null) {
  if (resume?.kind === "fall") {
    _resumeFall(resume, []);
    return;
  }
  if (resume?.kind === "turn") {
    asPrimaryGM("resumeTurn", resume, []);
    return;
  }
  if (resume?.fmId) {
    const user = game.users.get(resume.userId);
    if (user?.active) socket.executeForUsers("resumeForcedMove", [resume.userId], resume.fmId, fmMods);
    else asPrimaryGM("resumeForcedMove", resume.fmId, fmMods);
    return;
  }
  if (!resume?.userId || !resume?.itemUuid) return;
  const user = game.users.get(resume.userId);
  if (user?.active) socket.executeForUsers("resumeRoll", [resume.userId], resume.itemUuid, retargets, rollMods);
  else asPrimaryGM("resumeRoll", resume.itemUuid, retargets, rollMods);
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
    const applied = (pending.usedEntries ?? []).filter((u) => !u.cancelled && (!expired || !pending.awaiting.has(u.itemUuid)));
    if (getSetting("debugMode")) console.log(`DS_TRIGGERS | fireResume: expired=${expired} awaiting=${[...(pending.awaiting ?? [])].join(",")} applied=${applied.map((u) => u.itemName).join(",")}`);
    _finishResume(applied, pending.resume);
  } else if (held) {

    const usedInGroup = _queue.filter((e) => e.resumeId === resumeId && e.state === "used");
    for (const e of _queue) {
      if (e.resumeId === resumeId) { e.resumeId = null; e.resume = null; }
    }
    _finishResume(usedInGroup, held.resume);
  }
  _broadcast();
}

function _onReleaseHeld(resumeId) {
  if (!isPrimaryGM()) return;
  _fireResume(resumeId);
}

Hooks.on("createChatMessage", (message) => {
  if (!isPrimaryGM()) return;
  const abilityUse = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  if (!abilityUse?.abilityUuid) return;
  const now = Date.now();
  _recentAbilityPosts.set(abilityUse.abilityUuid, now);
  for (const [uuid, t] of _recentAbilityPosts) {
    if (now - t > 120000) _recentAbilityPosts.delete(uuid);
  }
  if (_automatedUses.has(abilityUse.abilityUuid)) {
    _automatedUses.delete(abilityUse.abilityUuid);
    message.setFlag(MODULE_ID, "automated", true).catch(() => {});
  }
  const triggerDamage = _triggerDamageUses.get(abilityUse.abilityUuid);
  if (triggerDamage) {
    _triggerDamageUses.delete(abilityUse.abilityUuid);
    const ct = "flags.draw-steel-combat-tools";
    message.update({ ...(triggerDamage.amount != null ? { [`${ct}.triggerDamage`]: triggerDamage.amount } : {}),
      ...(triggerDamage.type ? { [`${ct}.triggerDamageType`]: triggerDamage.type } : {}),
      ...(triggerDamage.level != null ? { [`${ct}.triggerLevel`]: triggerDamage.level } : {}),
      ...(triggerDamage.expended ? { [`${ct}.triggerExpended`]: triggerDamage.expended } : {}) }).catch(() => {});
    dbg(`stamped the trigger context onto ${message.id}`, triggerDamage);
  }
  for (const [uuid, rec] of _triggerDamageUses) {
    if (now - rec.at > 120000) _triggerDamageUses.delete(uuid);
  }
  for (const [uuid, t] of _automatedUses) {
    if (now - t > 120000) _automatedUses.delete(uuid);
  }

  
  const corrected = _refreshFmRunning(abilityUse.abilityUuid);
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
  if (corrected) _broadcast();
});

const _pendingRollMods = new Map();

async function _onResumeRoll(itemUuid, retargets = [], rollMods = []) {
  const item = await fromUuid(itemUuid).catch(() => null);
  if (!item) return;
  if (retargets.some((r) => r.ignoreRange)) game.modules.get("draw-steel-combat-tools")?.api?.allowOutOfRange?.(itemUuid);
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
  if (m.bonus) parts.push(game.i18n.format("DS_TRIGGERS.Editor.RollModBonus", { n: `${m.bonus > 0 ? "+" : ""}${m.bonus}` }));
  if (m.tierShift) parts.push(game.i18n.localize(m.tierShift > 0 ? "DS_TRIGGERS.Editor.RollModTierUp" : "DS_TRIGGERS.Editor.RollModTierDown"));
  if (m.negateBane && !m.edges) parts.push(game.i18n.localize("DS_TRIGGERS.Editor.RollModNegateBane"));
  return parts.join(" + ");
}

function _pillScope(app, tokenUuid) {
  if (!tokenUuid) return "global";
  const entry = Object.entries(app.options?.context?.targets ?? {}).find(([, t]) => (t?.tokenUuid ?? t?.token?.uuid) === tokenUuid);
  return entry?.[0] ?? "global";
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
    const scope = _pillScope(app, m.scopeTokenUuid);
    if (m.negateBane) {
      const pillBanes = (app._dsctSources ?? []).filter((p) => p.kind === "bane" && p.enabled !== false && (p.scope === "global" || p.scope === scope))
        .reduce((n, p) => n + (Number(p.amount) || 0), 0);
      if (!(pillBanes || modifiers?.banes)) {
        ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.NoBaneToNegate", { modName: m.modName }));
        continue;
      }
      m.edges = 1;
    }
    if (addPill) {
      const specs = [];
      if (m.edges) specs.push({ kind: "edge", amount: m.edges });
      if (m.banes) specs.push({ kind: "bane", amount: m.banes });
      if (m.bonus) specs.push({ kind: "bonus", amount: m.bonus });
      if (m.tierShift) specs.push({ kind: "tier", amount: m.tierShift });
      asPills = specs.length > 0 && specs.every((s) => addPill(app, {
        ...s, reason: m.modName, src: m.src ?? null, srcTokenId: m.srcTokenId ?? null, scope,
      }));
    }
    if (!asPills && modifiers) {
      bumped = true;
      modifiers.edges = Math.min(2, (modifiers.edges ?? 0) + (m.edges ?? 0));
      modifiers.banes = Math.min(2, (modifiers.banes ?? 0) + (m.banes ?? 0));
      modifiers.bonuses = (modifiers.bonuses ?? 0) + (m.bonus ?? 0);
      if (m.tierShift) ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Queue.TierByHand", { modName: m.modName }));
    }
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.RollModInjected", {
      modName: m.modName, effect: _rollModLabel(m),
    }));
  }
  if (bumped) app.render();
}

async function _runTriggerPicker(tokens, hint) {
  const picker = game.modules.get("draw-steel-ctlib")?.api?.runColoredTokenPicker;
  if (!picker) {
    ui.notifications.warn(game.i18n.localize("DS_TRIGGERS.Queue.PickerUnavailable"));
    return null;
  }
  return picker({
    tokens,
    colorMap: new Map(tokens.map((t) => [t.id, "#d9a63f"])),
    hint,
  }).catch(() => null);
}

async function _onPickRedirectSubject(modName, subjectTokenUuids) {
  const tokens = (subjectTokenUuids ?? []).map((u) => fromUuidSync(u)?.object).filter(Boolean);
  if (!tokens.length) return null;
  if (tokens.length === 1) return tokens[0].document.uuid;
  const picked = await _runTriggerPicker(tokens, game.i18n.format("DS_TRIGGERS.Queue.PickSubject", { modName }));
  return picked?.document?.uuid ?? null;
}

function _chooserRangeConstraint(removeDoc, { triggerItemUuid, triggeringUuid } = {}) {
  if (!triggerItemUuid || !triggeringUuid) return null;
  const trigItem = fromUuidSync(triggerItemUuid);
  if (!trigItem) return null;
  if (!/within distance of the (?:triggering|ability)/i.test(triggerEffectText(trigItem))) return null;
  const triggering = fromUuidSync(triggeringUuid);
  const range = abilityRangeSquares(triggering);
  if (!range) return null;
  
  let originDoc = null;
  const pending = game.modules.get("draw-steel-combat-tools")?.api?.pendingSquadMap?.();
  const entry = pending && removeDoc ? pending.get?.(removeDoc.id) : null;
  if (entry?.primaryMinionId) originDoc = canvas.tokens.get(entry.primaryMinionId)?.document ?? null;
  if (!originDoc) originDoc = triggering?.actor?.getActiveTokens?.(true, true)?.[0] ?? null;
  if (!originDoc) return null;
  return { originDoc, range };
}

function _rangeEnforced() {
  if (!game.modules.get("draw-steel-combat-tools")?.active) return false;
  try { return !!game.modules.get("draw-steel-ctlib")?.api?.rangeEnforced?.(); } catch { return false; }
}

function _legalRedirectTargets({ triggerItemUuid } = {}) {
  if (!triggerItemUuid || !_rangeEnforced()) return null;
  const getValidTargets = game.modules.get("draw-steel-ctlib")?.api?.getValidTargets;
  if (typeof getValidTargets !== "function") return null;
  const trigItem = fromUuidSync(triggerItemUuid);
  const ownerToken = trigItem?.actor?.getActiveTokens?.(false, false)?.[0] ?? null;
  if (!ownerToken) return null;
  const targetType = trigItem.system?.target?.type ?? "creature";
  const range = abilityRangeSquares(trigItem) ?? 0;
  try {
    return new Set(getValidTargets(ownerToken, targetType, range).map((t) => t.document.uuid));
  } catch (err) {
    console.error("DS_TRIGGERS | valid redirect target lookup failed:", err);
    return null;
  }
}

async function _onPickRedirectTarget(modName, removeTokenUuid, ctx = {}) {
  const removeDoc = removeTokenUuid ? fromUuidSync(removeTokenUuid) : null;
  let tokens = canvas.tokens.placeables.filter((t) => t.actor && t.document.uuid !== removeDoc?.uuid);
  
  if (ctx.pool === "selfOrAlly") {
    const owner = ctx.ownerActorUuid ? fromUuidSync(ctx.ownerActorUuid) : null;
    const side = owner?.getActiveTokens?.(false, true)?.[0]?.disposition ?? null;
    tokens = tokens.filter((t) => t.actor === owner || (side != null && t.document.disposition === side));
  }
  const constraints = [];
  try {
    const fromText = _chooserRangeConstraint(removeDoc, ctx);
    if (fromText) constraints.push(fromText);
  } catch (err) { console.error("DS_TRIGGERS | chooser range constraint failed:", err); }
  const legal = _legalRedirectTargets(ctx);
  if (getSetting("debugMode")) console.log(`DS_TRIGGERS | pickRedirectTarget: mod=${modName} candidates=${tokens.length} textConstraint=`, constraints.map((c) => ({ range: c.range, origin: c.originDoc?.name })), `legalTargets=${legal ? legal.size : "not enforced"}`);
  const gridDist = canvas.grid.distance || 1;
  for (const c of constraints) {
    tokens = tokens.filter((t) => footprintGap(c.originDoc, t.document) < c.range * gridDist);
  }
  if (legal) tokens = tokens.filter((t) => legal.has(t.document.uuid));
  if (getSetting("debugMode")) console.log(`DS_TRIGGERS | pickRedirectTarget: eligible candidates=${tokens.length}`);
  
  if (!tokens.length && (constraints.length || legal)) {
    ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Queue.RedirectNoneEligible", { modName }));
    return null;
  }
  if (!tokens.length) return null;
  const picked = await _runTriggerPicker(tokens, game.i18n.format("DS_TRIGGERS.Queue.PickTarget", { modName }));
  return picked?.document?.uuid ?? null;
}

let _retargetEpoch = 0;
export const retargetEpoch = () => _retargetEpoch;

async function _applyRetargets(item, retargets) {
  if (retargets?.length) _retargetEpoch++;
  for (const r of retargets ?? []) {
    try {
      const removeDoc = r.removeTokenUuid ? await fromUuid(r.removeTokenUuid).catch(() => null) : null;
      const newActor = r.newActorUuid ? await fromUuid(r.newActorUuid).catch(() => null) : item.actor;
      let newToken = newActor?.getActiveTokens(true, false)[0] ?? null;
      if (r.mode === "choice" && r.newTokenUuid) {
        const newDoc = await fromUuid(r.newTokenUuid).catch(() => null);
        newToken = newDoc?.object ?? newToken;
      }
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
  if (entry.featureLine?.director) return false;
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
    ..._lineFields(m),
    ownerActorUuid: m.actor.uuid,
    ownerName: m.actor.name,
    event: m._lockEvent ?? event,
    causeLabel: m._causeLabel ?? causeLabel,
    halvesOnUse: m._halvesOnUse ?? false,
    reflectHalf: m._redirect === "reflect" && !!m.clause?.reflectHalf,
    redirect: m._redirect ?? null,
    redirectPool: m.clause?.redirectPool ?? null,
    rollMod: m._rollMod ?? null,
    fmMode: m._fmMode ?? null,
    fmChar: m._fmChar ?? null,
    fmAmount: m._fmAmount ?? null,
    fmPerSurge: m._fmPerSurge ?? null,
    subjectTokenUuid: m._subjectTokenUuid ?? null,
    subjectTokenUuids: m._subjectTokenUuids ?? null,
    villain: m._villain ?? null,
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
    heldDetail: held.heldDetail ?? null,
    
    fmDistance: held.fmDistance ?? null,
    fmRunning: held.fmDistance ?? null,
    fmTrail: [],
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
  asPrimaryGM("queueAdd", entries);
  return entries;
}

export function releaseHeld(resumeId) {
  asPrimaryGM("releaseHeld", resumeId);
}

export function enqueuePromptEntries(matches, { event, causeLabel, triggerDamage = null, subjectTokenUuid = null, sourceMessageId = null, damageType = null }) {
  const promptId = foundry.utils.randomID();
  const entries = matches.map((m) => ({
    id: foundry.utils.randomID(),
    itemUuid: m.item.uuid,
    itemName: m._itemName ?? m.item.name,
    ..._lineFields(m),
    ownerActorUuid: m.actor.uuid,
    ownerName: m.actor.name,
    event,
    causeLabel: m._causeLabel ?? causeLabel,
    lock: false,
    state: "pending",
    createdAt: Date.now(),
    resumeId: null,
    resume: null,
    promptId,
    triggerDamage,
    triggerDamageType: damageType,
    expend: m.clause?.expendEffect ?? null,
    addSelfTarget: !!m.clause?.addSelfTarget,
    eventSubjectUuid: subjectTokenUuid,
    subjectTokenUuid: m._subjectTokenUuid ?? subjectTokenUuid,
    sourceMessageId,
    playerSide: (m.actor.hasPlayerOwner ?? false) && !m.item?.featureLine?.director,
    gain: m._gain ?? null,
    pill: m._pill ?? null,
    mark: m._mark ?? null,
  }));
  asPrimaryGM("queueAdd", entries);
}

export function enqueueDamageHold(matches, { causeLabel, heldDamage }) {
  const damageId = foundry.utils.randomID();
  const entries = matches.map((m) => ({
    id: foundry.utils.randomID(),
    itemUuid: m.item.uuid,
    itemName: m.item.name,
    ..._lineFields(m),
    ownerActorUuid: m.actor.uuid,
    ownerName: m.actor.name,
    event: m.defersDeath ? "DIES" : "WOULD_TAKE_DAMAGE",
    causeLabel,
    lock: false,
    state: "pending",
    createdAt: Date.now(),
    resumeId: null,
    resume: null,
    damageId,
    heldDamage,
    subjectTokenUuid: heldDamage.tokenUuid ?? null,
    defersDeath: !!m.defersDeath,
    halfDamage: m.clause?.halfDamage ?? false,
    expend: m.clause?.expendEffect ?? null,
    damageReduction: m.clause?.damageReduction ?? null,
    damageRedirect: m.clause?.damageRedirect ?? null,
    redirectRange: m.clause?.redirectRange ?? null,
    unreducible: !!m.clause?.unreducible,
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
    heldDetail: heldDamage.damageOptions?.ignoredImmunities?.length
      ? game.i18n.format("DS_TRIGGERS.Queue.HeldDamageIgnoresImmunity", {
        types: heldDamage.damageOptions.ignoredImmunities
          .map((t) => game.i18n.localize(ds.CONFIG.damageTypes?.[t]?.label ?? t)).join(", "),
      })
      : null,
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
  asPrimaryGM("queueAdd", entries);
}

export function enqueueResolutionHold(matches, { causeLabel, resolution }) {
  const resolutionId = foundry.utils.randomID();
  const entries = matches.map((m) => ({
    id: foundry.utils.randomID(),
    itemUuid: m.item.uuid,
    itemName: m.item.name,
    ..._lineFields(m),
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
    reflectHalf: m.clause?.redirect === "reflect" && !!m.clause?.reflectHalf,
    redirectPool: m.clause?.redirectPool ?? null,
    halfOnUse: m.clause?.halfOnUse === true
      || (m._postHoc === true && m.clause?.targetedHalf === true),
    postHoc: m._postHoc === true,
    subjectTargetKey: m._subjectTargetKey ?? null,
    subjectTokenUuid: m._subjectTokenUuid ?? null,
    subjectTokenUuids: m._subjectTokenUuids ?? null,
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
  asPrimaryGM("queueAdd", entries);
}

export function releaseResolutionNow(resolutionId) {
  asPrimaryGM("releaseResolutionNow", resolutionId);
}

function _onReleaseResolutionNow(resolutionId) {
  if (!isPrimaryGM()) return;
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
  asPrimaryGM("applyHeldDamageNow", damageId);
}

function _onApplyHeldDamageNow(damageId) {
  if (!isPrimaryGM()) return;
  const pending = _pendingDamageGraces.get(damageId);
  if (pending) {
    clearTimeout(pending.timer);
    _pendingDamageGraces.delete(damageId);
  }
  
  
  const spent = new Set();
  for (const e of _queue) {
    if (e.state !== "pending") continue;
    if (e.choices) {
      e.choices = e.choices.filter((c) => c.damageId !== damageId);
      if (e.choices.length === 1) _takeChoice(e, e.choices[0]);
      else if (e.choices.length) {
        if (e.damageId === damageId) Object.assign(e, { damageId: e.choices[0].damageId, heldDamage: e.choices[0].heldDamage });
        continue;
      }
    }
    if (e.damageId === damageId) spent.add(e.id);
  }
  _queue = _queue.filter((e) => !spent.has(e.id));
  _finalizeDamageHold(damageId);
  _broadcast();
}

export function resolveQueueEntry(id, outcome) {
  asPrimaryGM("queueResolve", id, outcome, game.user.name);
}

export function setReaper(data) {
  asPrimaryGM("reaperSet", data ?? null);
}

function _onReaperSet(data) {
  if (!isPrimaryGM()) return;
  const since = _queue.find((e) => e.kind === "reaper")?.createdAt ?? Date.now();
  _queue = _queue.filter((e) => e.kind !== "reaper");
  const certain = data?.certain ?? [], maybe = data?.maybe ?? [];
  const status = data?.status ?? "held";
  const shown = status === "held" ? (certain.length || maybe.length) && _queue.some((e) => e.kind === "damageHeld") : !!data;
  if (shown) {
    _queue.push({
      id: "reaper", kind: "reaper", itemUuid: null, ownerName: "", ownerActorUuid: null,
      itemName: game.i18n.localize("DS_TRIGGERS.Queue.ReaperTitle"),
      certain, maybe, status, picker: data.picker ?? null, state: "held", createdAt: since,
    });
  }
  _broadcast();
}

export function chooseQueueSubject(id, key) {
  return asPrimaryGM("queueChoose", id, key);
}

function _onQueueChoose(id, key) {
  if (!isPrimaryGM()) return;
  const entry = _queue.find((e) => e.id === id);
  if (!entry?.choices || entry.state !== "pending") return;
  const chosen = entry.choices.find((c) => c.key === key);
  if (!chosen) return;
  const dropped = entry.choices.filter((c) => c !== chosen);
  _takeChoice(entry, chosen);
  dbg(`queue choose ${id}: ${entry.itemName} answers ${chosen.subjectTokenUuid}`);
  for (const damageId of new Set(dropped.map((c) => c.damageId).filter(Boolean))) {
    if (damageId !== entry.damageId && _damageHolds.has(damageId) && !_groupPending("damageId", damageId)) _completeDamageGroup(damageId);
  }
  _broadcast();
}

export function pickTriggerSubject(tokens, hint) {
  return _runTriggerPicker(tokens, hint);
}

Hooks.once("socketlib.ready", () => {
  socket = socketlib.registerModule(MODULE_ID);
  socket.register("queueAdd", _onQueueAdd);
  socket.register("queueResolve", _onQueueResolve);
  socket.register("queueChoose", _onQueueChoose);
  socket.register("reaperSet", _onReaperSet);
  socket.register("queueSync", _onQueueSync);
  socket.register("resumeRoll", _onResumeRoll);
  socket.register("releaseHeld", _onReleaseHeld);
  socket.register("applyHeldDamageNow", _onApplyHeldDamageNow);
  socket.register("releaseResolutionNow", _onReleaseResolutionNow);
  socket.register("useCancelled", _onUseCancelled);
  socket.register("pickRedirectSubject", _onPickRedirectSubject);
  socket.register("pickRedirectTarget", _onPickRedirectTarget);
  socket.register("pickDamageRedirect", _onPickDamageRedirect);
  socket.register("pickStabilityShare", _onPickStabilityShare);
  socket.register("pickSurgeSpend", _onPickSurgeSpend);
  socket.register("applyAfterRedirect", _onApplyAfterRedirect);
  socket.register("pickHarmonizeTarget", (name, exclude) => pickHarmonizeTarget(name, exclude));
  socket.register("queueSyncRequest", _onQueueSyncRequest);
  socket.register("villainMarkUsed", _onVillainMarkUsed);
  socket.register("villainDismiss", _onVillainDismiss);
});

function _onQueueSyncRequest() {
  if (!isPrimaryGM()) return;
  _broadcast();
}

Hooks.once("ready", () => {
  if (!isPrimaryGM()) { asPrimaryGM("queueSyncRequest"); return; }
  _clearStaleResolutionLocks();
});

async function _clearStaleResolutionLocks() {
  for (const message of game.messages.contents) {
    if (!message.getFlag(MODULE_ID, "resolutionLock")) continue;
    await message.unsetFlag(MODULE_ID, "resolutionLock").catch(() => {});
    dbg(`cleared a stale resolution lock left on ${message.id}`);
  }
}

Hooks.on("deleteChatMessage", (message) => {
  if (!isPrimaryGM()) return;
  let dropped = false;
  for (const [resolutionId, hold] of _resolutionHolds) {
    if (hold.messageId !== message.id) continue;
    _queue = _queue.filter((e) => e.resolutionId !== resolutionId);
    _resolutionHolds.delete(resolutionId);
    const grace = _pendingResolutionGraces.get(resolutionId);
    if (grace) { clearTimeout(grace.timer); _pendingResolutionGraces.delete(resolutionId); }
    dbg(`resolution hold ${resolutionId} dropped, its card was deleted`);
    dropped = true;
  }
  
  const orphaned = _queue.filter((e) => e.promptId && e.state === "pending" && e.sourceMessageId === message.id);
  if (orphaned.length) {
    _queue = _queue.filter((e) => !orphaned.includes(e));
    dbg(`${orphaned.length} prompt(s) dropped, their card was deleted`);
    dropped = true;
  }
  if (dropped) _broadcast();
});

const DSTD_ID = "draw-steel-target-damage";

async function _onApplyAfterRedirect(payload) {
  const message = game.messages.get(payload.messageId);
  if (!message) return;
  const state = foundry.utils.getProperty(message.flags, `${DSTD_ID}.state`) ?? {};
  const targets = [...(state.targets ?? [])].filter((t) => String(t.tokenUuid ?? "") !== payload.removeTokenUuid);
  if (!targets.some((t) => String(t.tokenUuid ?? "") === payload.newTarget.tokenUuid)) targets.push(payload.newTarget);
  noteTargetsChange(payload.messageId, targets.map((t) => String(t.tokenUuid ?? t.actorUuid ?? "")));
  await message.update({
    [`flags.${DSTD_ID}.state.targets`]: targets,
    [`flags.${DSTD_ID}.state.updatedAt`]: Date.now(),
  });
}

document.addEventListener("click", async (event) => {
  const btn = event.target.closest(".dst-after-pick-btn");
  if (!btn || btn.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  const modName = btn.dataset.modName ?? "";
  const owner = btn.dataset.ownerActorUuid ? await fromUuid(btn.dataset.ownerActorUuid).catch(() => null) : null;
  if (!game.user.isGM && !(owner && owner.testUserPermission(game.user, "OWNER"))) {
    ui.notifications.warn(game.i18n.localize("DS_TRIGGERS.Queue.AfterPickOnlyOwner"));
    return;
  }
  const ownerTokenDoc = owner?.getActiveTokens?.(true, true)?.[0] ?? null;
  if (!ownerTokenDoc) {
    ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Queue.AfterPickNoMessage", { owner: owner?.name ?? "?" }));
    return;
  }
  const msgs = game.messages.contents;
  let strikeMsg = null;
  for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 30); i--) {
    const m = msgs[i];
    if (Date.now() - m.timestamp > 600000) break;
    const tgts = foundry.utils.getProperty(m.flags, `${DSTD_ID}.state.targets`);
    if (Array.isArray(tgts) && tgts.some((t) => String(t.tokenUuid ?? "") === ownerTokenDoc.uuid)) { strikeMsg = m; break; }
  }
  if (!strikeMsg) {
    ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Queue.AfterPickNoMessage", { owner: owner?.name ?? "?" }));
    return;
  }
  const candidates = canvas.tokens.placeables.filter((t) => t.actor && t.document.uuid !== ownerTokenDoc.uuid);
  if (!candidates.length) return;
  const picked = await _runTriggerPicker(candidates, game.i18n.format("DS_TRIGGERS.Queue.PickTarget", { modName }));
  if (!picked) return;
  const doc = picked.document;
  asPrimaryGM("applyAfterRedirect", {
    messageId: strikeMsg.id,
    removeTokenUuid: ownerTokenDoc.uuid,
    newTarget: {
      tokenUuid: doc.uuid, tokenId: doc.id ?? null, sceneId: doc.parent?.id ?? null,
      actorUuid: picked.actor?.uuid ?? null, actorId: picked.actor?.id ?? null,
      name: picked.name ?? doc.name, tokenImg: doc.texture?.src ?? null, actorImg: picked.actor?.img ?? null,
    },
  });
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.AfterPickApplied", {
    modName, name: picked.name ?? doc.name, owner: owner?.name ?? "?",
  }));
  btn.disabled = true;
});
