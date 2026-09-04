import { MODULE_ID, getSetting, dbg } from "../util.mjs";

let socket = null;

let _queue = [];
let _mirror = [];
const _rollBypass = new Set();
const _damageBypass = new Set();

const _pendingResumes = new Map();
const _damageHolds = new Map();
const _pendingDamageGraces = new Map();

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

  
  
  const fresh = entries.filter((e) => e.damageId
    ? true
    : !_queue.some((q) => q.itemUuid === e.itemUuid && q.state === "pending"));
  if (!fresh.length) return;
  const damageEntry = fresh.find((e) => e.damageId && e.heldDamage);
  if (damageEntry && !_damageHolds.has(damageEntry.damageId)) {
    _damageHolds.set(damageEntry.damageId, { ...damageEntry.heldDamage, anyUsed: false, createdAt: damageEntry.createdAt });
    Hooks.callAll("dst.damageHoldRegistered", damageEntry.damageId);
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
          .map((e) => ({ itemUuid: e.itemUuid, ownerActorUuid: e.ownerActorUuid, ownerName: e.ownerName, itemName: e.itemName, usedAt: e.usedAt }));
        const awaiting = new Set(usedEntries.filter((u) => !_postedAfterUse(u.itemUuid, u.usedAt)).map((u) => u.itemUuid));
        if (!awaiting.size) {
          _removeHeld(entry.resumeId);
          _dispatchResume(resume);
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
      if ((entry.resumeId && e.resumeId === entry.resumeId) || (entry.damageId && e.damageId === entry.damageId)) {
        e.decideUntil = Date.now() + _graceMs();
      }
    }
  }

  if (entry.damageId && _damageHolds.has(entry.damageId)) {
    const hold = _damageHolds.get(entry.damageId);
    if (outcome === "used") {
      hold.anyUsed = true;
      (hold.usedItems ??= new Set()).add(entry.itemUuid);
      (hold.usedEntries ??= []).push({ itemUuid: entry.itemUuid, ownerActorUuid: entry.ownerActorUuid, ownerName: entry.ownerName, itemName: entry.itemName, usedAt: entry.usedAt });
    }
    if (!_queue.some((e) => e.damageId === entry.damageId && e.state === "pending")) {
      _completeDamageGroup(entry.damageId);
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

async function _finalizeDamageHold(damageId) {
  const hold = _damageHolds.get(damageId);
  if (!hold) return;
  _damageHolds.delete(damageId);
  if (!hold.anyUsed) {
    await _applyHeldDamage(hold.actorUuid, hold.amount);
    Hooks.callAll("dst.damageHoldResolved", { hold, finalAmount: hold.amount });
    return;
  }

  
  
  const actor = await fromUuid(hold.actorUuid).catch(() => null);
  const F = (k, data) => game.i18n.format(`DS_TRIGGERS.Queue.${k}`, data);
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: F("HeldDamageTitle", { name: actor?.name ?? "" }) },
    position: { width: 280 },
    content: `<p class="hint">${F("HeldDamageHint", { amount: hold.amount })}</p>
      <div class="dst-held-form">
        <input type="number" name="dst-held-amount" value="${hold.amount}" min="0" step="1" autofocus>
        <div class="dst-held-adjust">
          <button type="button" data-adjust="half">${game.i18n.localize("DS_TRIGGERS.Queue.HeldDamageHalf")}</button>
          <button type="button" data-adjust="double">${game.i18n.localize("DS_TRIGGERS.Queue.HeldDamageDouble")}</button>
          <button type="button" data-adjust="plus">+1</button>
          <button type="button" data-adjust="minus">-1</button>
        </div>
      </div>`,
    buttons: [
      {
        action: "apply",
        label: "DS_TRIGGERS.Queue.HeldDamageApply",
        icon: "fa-solid fa-heart-crack",
        default: true,
        callback: (_event, button) => Number(button.form.elements["dst-held-amount"]?.value ?? hold.amount),
      },
      { action: "discard", label: "DS_TRIGGERS.Queue.HeldDamageDiscard", callback: () => null },
    ],
    render: (_event, dialog) => {
      const root = dialog.element ?? dialog;
      const input = root.querySelector('input[name="dst-held-amount"]');
      for (const btn of root.querySelectorAll("[data-adjust]")) {
        btn.addEventListener("click", () => {
          if (!input) return;
          const v = Number(input.value || 0);
          switch (btn.dataset.adjust) {
            case "half": input.value = Math.floor(v / 2); break;
            case "double": input.value = v * 2; break;
            case "plus": input.value = v + 1; break;
            case "minus": input.value = Math.max(0, v - 1); break;
          }
        });
      }
    },
    rejectClose: false,
  }).catch(() => null);

  if (result == null || !(Number(result) > 0)) {
    ui.notifications.warn(F("HeldDamageDiscarded", { name: actor?.name ?? "" }));
    Hooks.callAll("dst.damageHoldResolved", { hold, finalAmount: 0 });
    return;
  }
  await _applyHeldDamage(hold.actorUuid, Number(result));
  Hooks.callAll("dst.damageHoldResolved", { hold, finalAmount: Number(result) });
}

async function _applyHeldDamage(actorUuid, amount) {
  if (!(amount > 0)) return;
  const actor = await fromUuid(actorUuid).catch(() => null);
  if (!actor) return;
  _damageBypass.add(actorUuid);
  try {
    await actor.modifyTokenAttribute("stamina", -amount, true, false);
  } finally {
    _damageBypass.delete(actorUuid);
  }
}

function _dispatchResume(resume) {
  if (!resume?.userId || !resume?.itemUuid) return;
  const user = game.users.get(resume.userId);
  if (user?.active) socket.executeForUsers("resumeRoll", [resume.userId], resume.itemUuid);
  else socket.executeAsGM("resumeRoll", resume.itemUuid);
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
    _dispatchResume(pending.resume);
  } else if (held) {
    
    
    for (const e of _queue) {
      if (e.resumeId === resumeId) { e.resumeId = null; e.resume = null; }
    }
    _dispatchResume(held.resume);
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
});

async function _onResumeRoll(itemUuid) {
  const item = await fromUuid(itemUuid).catch(() => null);
  if (!item) return;
  addRollBypass(itemUuid);
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.RollReleased", { name: item.name }));
  item.system.use();
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
  }));
  entries.push({
    id: foundry.utils.randomID(),
    kind: "damageHeld",
    itemUuid: null,
    itemName: game.i18n.format("DS_TRIGGERS.Queue.HeldDamageEntry", { amount: heldDamage.amount }),
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
  socket.register("useCancelled", _onUseCancelled);
});
