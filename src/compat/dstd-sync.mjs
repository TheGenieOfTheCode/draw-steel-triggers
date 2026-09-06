import { MODULE_ID, dbg, getSetting } from "../util.mjs";
import { getActiveDamageHolds } from "../triggers/queue.mjs";
import { openDamageModWindow, foldDamagePills, damagePillText, damagePillEffect, damagePillDisplayList, damagePillType, damageTypeLabel, styleTypePill } from "../ui/damage-mod-window.mjs";

const DSTD_ID = "draw-steel-target-damage";

function _linkedToActiveHold(messageId, opId, exceptHold = null) {
  for (const hold of getActiveDamageHolds().values()) {
    if (hold === exceptHold) continue;
    if (hold.dstd?.messageId === messageId && hold.dstd?.opId === opId) return true;
  }
  return false;
}

function _dstdActive() {
  return game.modules.get(DSTD_ID)?.active ?? false;
}

function _snapshotsEqual(a, b) {
  if (!a || !b) return false;
  return Number(a.value) === Number(b.value) && Number(a.temporary ?? 0) === Number(b.temporary ?? 0);
}

function _targetMatches(target, actorUuid) {
  if (!target) return false;
  if (target.actorUuid === actorUuid) return true;
  if (!target.tokenUuid) return false;
  const tokenDoc = fromUuidSync(target.tokenUuid);
  return tokenDoc?.actor?.uuid === actorUuid;
}

function _findHeldRecord(hold) {
  const messages = game.messages.contents.slice(-30).reverse();
  for (const message of messages) {
    const apps = foundry.utils.getProperty(message.flags, `${DSTD_ID}.state.applications`);
    if (!apps) continue;
    for (const [opId, entry] of Object.entries(apps)) {
      if (entry?.status !== "applied" || entry.kind !== "damage") continue;
      if (Array.isArray(entry.records)) continue;
      if (_linkedToActiveHold(message.id, opId)) continue;
      if (Number(entry.appliedAt ?? 0) < (hold.createdAt ?? 0) - 10000) continue;
      if (!_snapshotsEqual(entry.before, entry.after)) continue;
      if (!_targetMatches(entry.target, hold.actorUuid)) continue;
      return { message, opId, entry };
    }
  }
  return null;
}

function _markHeldRecords(message) {
  if (!game.users.activeGM?.isSelf || !_dstdActive()) return;
  const holds = getActiveDamageHolds();
  if (!holds.size) return;
  const apps = foundry.utils.getProperty(message.flags, `${DSTD_ID}.state.applications`) ?? {};
  const updates = {};
  for (const [opId, entry] of Object.entries(apps)) {
    if (entry?.status !== "applied" || entry.kind !== "damage" || entry.dstHeld) continue;
    if (Array.isArray(entry.records)) continue;
    if (!_snapshotsEqual(entry.before, entry.after)) continue;
    for (const hold of holds.values()) {
      
      
      const linkedHere = hold.dstd?.messageId === message.id && hold.dstd?.opId === opId;
      if (hold.dstd && !linkedHere) continue;
      if (!linkedHere) {
        if (Number(entry.appliedAt ?? 0) < (hold.createdAt ?? 0) - 10000) continue;
        if (!_targetMatches(entry.target, hold.actorUuid)) continue;
        if (_linkedToActiveHold(message.id, opId, hold)) break;
        hold.dstd = { messageId: message.id, opId };
      }
      updates[`flags.${DSTD_ID}.state.applications.${opId}.dstHeld`] = true;
      break;
    }
  }
  if (Object.keys(updates).length) {
    updates[`flags.${DSTD_ID}.state.updatedAt`] = Date.now();
    dbg("dstd sync: marking held records", updates);
    message.update(updates);
  } else if (Object.keys(apps).length) {
    dbg(`dstd sync: no held mark written for ${message.id} (holds: ${holds.size}, apps: ${Object.keys(apps).length})`);
  }
}

Hooks.on("dst.damageHoldRegistered", () => {
  if (!game.users.activeGM?.isSelf || !_dstdActive()) return;
  for (const message of game.messages.contents.slice(-10)) _markHeldRecords(message);
});

Hooks.on("dst.damageHoldResolved", async ({ hold, finalAmount }) => {
  if (!_dstdActive() || !hold?.actorUuid) return;
  let found = null;
  if (hold.dstd) {
    const message = game.messages.get(hold.dstd.messageId);
    const entry = foundry.utils.getProperty(message?.flags ?? {}, `${DSTD_ID}.state.applications.${hold.dstd.opId}`);
    if (entry) found = { message, opId: hold.dstd.opId, entry };
  }
  found ??= _findHeldRecord(hold);
  if (!found) return;
  const { message, opId, entry } = found;
  const updated = foundry.utils.deepClone(entry);
  updated.dstHeld = false;

  if (!(finalAmount > 0)) {
    
    updated.status = "undone";
    updated.undoneByUserId = game.user.id;
    updated.undoneByUserName = game.user.name;
    updated.undoneAt = Date.now();
    updated.afterUndo = updated.before;
  } else {
    updated.amount = finalAmount;
    if (finalAmount !== hold.amount) {
      if (finalAmount === Math.floor(hold.amount / 2)) updated.halfDamage = true;
      else updated.dstAdjusted = true;
    }
    const actor = await fromUuid(hold.actorUuid).catch(() => null);
    const stamina = actor?.system?.stamina;
    if (stamina) updated.after = { ...updated.after, value: stamina.value, temporary: stamina.temporary ?? 0 };
    if (Array.isArray(updated.stack) && updated.stack.length) {
      const top = updated.stack.at(-1);
      top.amount = updated.amount;
      top.halfDamage = updated.halfDamage;
      top.dstAdjusted = updated.dstAdjusted;
      top.after = updated.after;
    }
  }

  dbg(`dstd sync: record ${message.id}:${opId} -> ${finalAmount}`);
  await message.update({
    [`flags.${DSTD_ID}.state.applications.${opId}`]: updated,
    [`flags.${DSTD_ID}.state.updatedAt`]: Date.now(),
  });
});

const _pendingHalves = [];

function _dstdHash(value) {
  let hash = 0;
  const text = String(value ?? "");
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function _dstdOperationId(target, partId, rollIndex) {
  const key = String(target?.tokenUuid ?? target?.actorUuid ?? "").replace(/\./g, "__");
  return `damage-${partId ?? "part"}-${rollIndex}-${_dstdHash(key)}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

Hooks.on("dst.targetedHalfUsed", (data) => {
  if (!_dstdActive()) return;
  _pendingHalves.push({ ...data, expires: Date.now() + 120000 });
  if (data.messageId && game.users.activeGM?.isSelf) {
    const message = game.messages.get(data.messageId);
    if (message) _tryWriteHalfOverrides(message);
  }
});

function _tryWriteHalfOverrides(message) {
  if (!_pendingHalves.length) return;
  const abilityUse = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  if (!abilityUse?.abilityUuid) return;
  const state = foundry.utils.getProperty(message.flags, `${DSTD_ID}.state`);
  if (!state?.targets?.length) return;
  const DamageRoll = ds?.rolls?.DamageRoll;
  const updates = {};

  for (const pending of _pendingHalves) {
    if (pending.claimed || pending.expires < Date.now()) continue;
    if (pending.abilityUuid !== abilityUse.abilityUuid) continue;
    const target = state.targets.find((t) => _targetMatches(t, pending.targetActorUuid));
    if (!target) continue;
    for (const part of message.system?.parts?.contents ?? []) {
      const partId = part.id ?? part._id;
      const rolls = part.rolls ?? [];
      for (let i = 0; i < rolls.length; i++) {
        const roll = rolls[i];
        const isDamage = DamageRoll ? roll instanceof DamageRoll : roll?.constructor?.name === "DamageRoll";
        if (!isDamage || roll?.isHeal) continue;
        const opId = _dstdOperationId(target, partId, i);
        if (state.damageOverrides?.[opId]) continue;
        const total = Number(roll.total ?? 0);
        updates[`flags.${DSTD_ID}.state.damageOverrides.${opId}`] = {
          amount: Math.floor(total / 2),
          baseAmount: total,
          damageType: roll.type ?? roll.options?.type ?? "",
          typeLabel: roll.typeLabel ?? "",
          dstHalf: true,
          dstModName: pending.modName ?? "",
        };
      }
    }
    pending.claimed = true;
  }

  for (let i = _pendingHalves.length - 1; i >= 0; i--) {
    if (_pendingHalves[i].claimed || _pendingHalves[i].expires < Date.now()) _pendingHalves.splice(i, 1);
  }
  if (Object.keys(updates).length) {
    updates[`flags.${DSTD_ID}.state.updatedAt`] = Date.now();
    dbg("dstd sync: writing half overrides", updates);
    message.update(updates);
  }
}

Hooks.on("createChatMessage", (message) => {
  if (!game.users.activeGM?.isSelf || !_dstdActive()) return;
  _tryWriteHalfOverrides(message);
  _markHeldRecords(message);
});

Hooks.on("updateChatMessage", (message, changed) => {
  if (!game.users.activeGM?.isSelf || !_dstdActive()) return;
  if (!foundry.utils.hasProperty(changed, `flags.${DSTD_ID}`)) return;
  _tryWriteHalfOverrides(message);
  _markHeldRecords(message);
  _cleanupUndonePills(message);
});

async function _cleanupUndonePills(message) {
  const stored = message.getFlag(MODULE_ID, "damagePills") ?? {};
  const apps = foundry.utils.getProperty(message.flags, `${DSTD_ID}.state.applications`) ?? {};
  const update = {};
  for (const opId of Object.keys(stored)) {
    if (apps[opId]?.status !== "undone") continue;
    if (foundry.data?.operators?.ForcedDeletion) update[`flags.${MODULE_ID}.damagePills.${opId}`] = new foundry.data.operators.ForcedDeletion();
    else update[`flags.${MODULE_ID}.damagePills.-=${opId}`] = null;
  }
  if (Object.keys(update).length) await message.update(update).catch(() => {});
}

function _suffixSpan(btn, key) {
  const span = btn.querySelector("span");
  if (!span || span.dataset.dstMark === key) return;
  span.dataset.dstMark = key;
  span.textContent += ` (${game.i18n.localize(`DS_TRIGGERS.Queue.${key}`)})`;
}

function _patchMessageLabels(message, root) {
  const apps = foundry.utils.getProperty(message.flags, `${DSTD_ID}.state.applications`) ?? {};
  const overrides = foundry.utils.getProperty(message.flags, `${DSTD_ID}.state.damageOverrides`) ?? {};

  for (const [opId, entry] of Object.entries(apps)) {
    if (entry?.status !== "applied") continue;
    if (entry.dstHeld) {
      for (const btn of root.querySelectorAll(`button[data-dstd-action="applyDamage"][data-operation-id="${opId}"]`)) {
        btn.classList.add("dst-dstd-held-btn");
        const icon = btn.querySelector("i");
        if (icon && !icon.classList.contains("fa-hourglass-half")) icon.className = "fa-solid fa-hourglass-half";
        const span = btn.querySelector("span");
        if (span && span.dataset.dstMark !== "held") {
          span.dataset.dstMark = "held";
          span.textContent = game.i18n.localize("DS_TRIGGERS.Queue.DstdHeldLabel");
        }
      }
      for (const undo of root.querySelectorAll(`button[data-dstd-action="undoDamage"][data-operation-id="${opId}"]`)) {
        undo.disabled = true;
      }
      continue;
    }
    if (entry.dstAdjusted) {
      for (const btn of root.querySelectorAll(`button[data-dstd-action="applyDamage"][data-operation-id="${opId}"]`)) _suffixSpan(btn, "Adjusted");
    } else if (entry.override?.dstHalf && !entry.halfDamage) {
      for (const btn of root.querySelectorAll(`button[data-dstd-action="applyDamage"][data-operation-id="${opId}"]`)) _suffixSpan(btn, "Half");
    }
  }

  for (const [opId, override] of Object.entries(overrides)) {
    if (!override?.dstHalf || apps[opId]?.status === "applied") continue;
    for (const btn of root.querySelectorAll(`button[data-dstd-action="applyDamage"][data-operation-id="${opId}"]`)) _suffixSpan(btn, "Half");
  }
}

function _applyResolutionLock(message, root) {
  const locked = !!message.getFlag(MODULE_ID, "resolutionLock");
  const buttons = root.querySelectorAll("button[data-dstd-action]");
  if (!buttons.length) return;

  if (locked) {
    for (const btn of buttons) {
      if (btn.dataset.dstResLock === "1") continue;
      btn.dataset.dstResLock = "1";
      btn.classList.add("dst-dstd-res-locked");
      btn.disabled = true;
    }
    if (!root.querySelector(".dst-dstd-res-banner")) {
      const banner = document.createElement("div");
      banner.className = "dst-dstd-res-banner";
      banner.innerHTML = `<i class="fa-solid fa-hourglass-half"></i> ${game.i18n.localize("DS_TRIGGERS.Queue.DstdHeldLabel")}`;
      const anchor = buttons[0].closest(".message-content") ?? root;
      anchor.prepend(banner);
    }
  } else if (root.querySelector('[data-dst-res-lock="1"], .dst-dstd-res-banner')) {
    root.querySelector(".dst-dstd-res-banner")?.remove();
    for (const btn of buttons) {
      if (btn.dataset.dstResLock !== "1") continue;
      delete btn.dataset.dstResLock;
      btn.classList.remove("dst-dstd-res-locked");
      btn.disabled = false;
    }
  }
}

function _pillRowFor(btn) {
  const host = btn.closest('[class*="action-row"]');
  if (!host?.parentElement) return null;
  const next = host.nextElementSibling;
  if (next?.classList?.contains("dst-damage-pills")) return next;
  const rowEl = document.createElement("div");
  rowEl.className = "dst-damage-pills";
  host.insertAdjacentElement("afterend", rowEl);
  return rowEl;
}

function _renderDamagePills(message, root) {
  const stored = message.getFlag(MODULE_ID, "damagePills") ?? {};
  const overrides = foundry.utils.getProperty(message.flags, `${DSTD_ID}.state.damageOverrides`) ?? {};
  const apps = foundry.utils.getProperty(message.flags, `${DSTD_ID}.state.applications`) ?? {};

  const byOp = new Map();
  const add = (opId, pill, { removable = false, idx = null, legacyHalf = false, inert = false } = {}) => {
    if (!byOp.has(opId)) byOp.set(opId, []);
    byOp.get(opId).push({ pill, removable, idx, legacyHalf, inert });
  };

  for (const [opId, ov] of Object.entries(overrides)) {
    const applied = apps[opId]?.status === "applied";
    if (Array.isArray(ov?.dstPills) && ov.dstPills.length) {
      for (const x of damagePillDisplayList(ov.dstPills)) {
        add(opId, x.pill, { removable: !applied, idx: x.idx, inert: x.inert });
      }
    } else if (ov?.dstHalf) {
      add(opId, { kind: "half", label: ov.dstModName ?? "", source: "trigger" }, { removable: !applied, legacyHalf: true });
    }
  }

  for (const [opId, rec] of Object.entries(apps)) {
    if (rec?.status !== "applied" || overrides[opId]) continue;
    for (const p of rec.override?.dstPills ?? []) add(opId, p);
  }

  for (const [opId, data] of Object.entries(stored)) {
    if (apps[opId]?.status !== "applied") continue;
    for (const p of data.pills ?? []) add(opId, p);
  }

  for (const [opId, items] of byOp) {
    for (const btn of root.querySelectorAll(`button[data-dstd-action="applyDamage"][data-operation-id="${opId}"]`)) {
      const rowEl = _pillRowFor(btn);
      if (!rowEl || rowEl.dataset.dstPills === opId) continue;
      rowEl.dataset.dstPills = opId;
      rowEl.innerHTML = "";
      for (const it of items) {
        const span = document.createElement("span");
        span.className = `dst-pill dst-pill--${it.pill.kind}${it.inert ? " dst-pill--inert" : ""}`;
        styleTypePill(span, it.pill);
        span.textContent = damagePillText(it.pill);
        let tooltip = it.inert
          ? game.i18n.localize(it.pill.kind === "type" ? "DS_TRIGGERS.Queue.PillTypeOverriddenTooltip" : "DS_TRIGGERS.Queue.PillInertTooltip")
          : damagePillEffect(it.pill);
        if (it.removable && (game.user.isGM || message.isOwner)) {
          span.classList.add("dst-pill--removable");
          span.dataset.dstPillOp = opId;
          span.dataset.dstPillMsg = message.id;
          if (!it.legacyHalf && it.idx != null) span.dataset.dstPillIdx = String(it.idx);
          tooltip += `<br>${game.i18n.localize("DS_TRIGGERS.Queue.PillRemoveTooltip")}`;
        }
        span.dataset.tooltip = tooltip;
        rowEl.appendChild(span);
      }
    }
  }
}

async function _replaceOverride(message, opId, data) {
  const hasOps = !!foundry.data?.operators?.ForcedDeletion;
  if (data == null) {
    const deletion = hasOps
      ? { [`flags.${DSTD_ID}.state.damageOverrides.${opId}`]: new foundry.data.operators.ForcedDeletion() }
      : { [`flags.${DSTD_ID}.state.damageOverrides.-=${opId}`]: null };
    await message.update({ ...deletion, [`flags.${DSTD_ID}.state.updatedAt`]: Date.now() });
    return;
  }
  if (hasOps && foundry.data.operators.ForcedReplacement) {
    await message.update({
      [`flags.${DSTD_ID}.state.damageOverrides.${opId}`]: new foundry.data.operators.ForcedReplacement(data),
      [`flags.${DSTD_ID}.state.updatedAt`]: Date.now(),
    });
  } else {
    await message.update({ [`flags.${DSTD_ID}.state.damageOverrides.-=${opId}`]: null });
    await message.update({
      [`flags.${DSTD_ID}.state.damageOverrides.${opId}`]: data,
      [`flags.${DSTD_ID}.state.updatedAt`]: Date.now(),
    });
  }
}

function _origDamageType(ov) {
  if (ov?.dstOrigType !== undefined) {
    return { damageType: ov.dstOrigType?.damageType ?? null, typeLabel: ov.dstOrigType?.typeLabel ?? null };
  }
  return { damageType: ov?.damageType || null, typeLabel: ov?.typeLabel || null };
}

async function _removeOverridePill(message, opId, idx) {
  const state = message.getFlag(DSTD_ID, "state") ?? {};
  const ov = state.damageOverrides?.[opId];
  if (!Array.isArray(ov?.dstPills)) return;
  const pills = ov.dstPills.filter((_, i) => i !== idx);
  const base = Number(ov.baseAmount ?? 0);
  const orig = _origDamageType(ov);
  if (!pills.length && !ov.additional && (ov.dstOrigType !== undefined || !ov.damageType)) {
    await _replaceOverride(message, opId, null);
    return;
  }
  const typePill = damagePillType(pills);
  const surges = pills.filter((p) => p.kind === "surge").length;
  const surgeDamage = Number(ov.surgeDamage ?? 0) || 0;
  await _replaceOverride(message, opId, {
    ...ov,
    amount: foldDamagePills(base, pills),
    damageType: typePill != null ? typePill : orig.damageType,
    typeLabel: typePill != null ? (typePill ? damageTypeLabel(typePill) : "") : orig.typeLabel,
    dstOrigType: orig,
    surges,
    surgeBonus: surges * surgeDamage,
    dstPills: pills,
  });
}

document.addEventListener("click", async (ev) => {
  const pill = ev.target?.closest?.(".dst-pill--removable[data-dst-pill-op]");
  if (!pill) return;
  ev.preventDefault();
  ev.stopPropagation();
  const msgId = pill.dataset.dstPillMsg || pill.closest("li.chat-message")?.dataset?.messageId;
  const message = msgId ? game.messages.get(msgId) : null;
  if (!message || (!game.user.isGM && !message.isOwner)) return;
  const opId = pill.dataset.dstPillOp;
  if (pill.dataset.dstPillIdx != null) {
    await _removeOverridePill(message, opId, Number(pill.dataset.dstPillIdx));
    return;
  }
  const state = message.getFlag(DSTD_ID, "state") ?? {};
  if (!state.damageOverrides?.[opId]?.dstHalf) return;
  await _replaceOverride(message, opId, null);
}, { capture: true });

function _findPartRoll(message, partId, rollIndex) {
  if (partId === "message") return message.rolls?.[rollIndex] ?? null;
  const parts = message.system?.parts;
  const list = parts
    ? (Array.isArray(parts) ? parts : Array.from(parts.contents ?? (typeof parts.values === "function" ? parts.values() : Object.values(parts))))
    : [];
  const part = list.find((p) => (p.id ?? p._id) === partId);
  return part?.rolls?.[rollIndex] ?? null;
}

async function _resolveSurgeContext(message, state) {
  let src = null;
  if (state.sourceActorUuid) src = await fromUuid(state.sourceActorUuid).catch(() => null);
  if (!src && state.abilityUuid) src = (await fromUuid(state.abilityUuid).catch(() => null))?.actor ?? null;
  if (src?.type === "retainer") src = src.system?.retainer?.mentor ?? null;
  if (src?.type === "draw-steel-companion.companion") src = src.system?.retainer?.mentor ?? null;
  if (src?.type !== "hero") return null;
  return {
    actorUuid: src.uuid,
    available: Number(src.system?.hero?.surges ?? 0) || 0,
    damage: Number(src.getRollData?.()?.chr ?? 0) || 0,
  };
}

function _seedPillsFromOverride(ov) {
  if (Array.isArray(ov?.dstPills)) return ov.dstPills.map((p) => ({ ...p }));
  const seed = [];
  if (ov?.dstHalf) seed.push({ kind: "half", label: ov.dstModName ?? "", source: "trigger" });
  const surges = Number(ov?.surges ?? 0) || 0;
  for (let i = 0; i < surges; i++) seed.push({ kind: "surge", value: Number(ov?.surgeDamage ?? 0) || 0, label: "", source: "surge" });
  const bonus = Number(ov?.bonus ?? 0) || 0;
  if (bonus) seed.push({ kind: "delta", value: bonus, label: "", source: "manual" });
  return seed;
}

async function _openPillDamageEditor(message, button) {
  let target = {};
  try { target = JSON.parse(button.dataset.target ?? "{}"); } catch {}
  const opId = button.dataset.operationId;
  if (!opId) return;
  const state = foundry.utils.getProperty(message.flags, `${DSTD_ID}.state`) ?? {};
  const ov = state.damageOverrides?.[opId] ?? null;
  const roll = _findPartRoll(message, button.dataset.partId, Number(button.dataset.rollIndex));
  const base = Number(ov?.baseAmount ?? roll?.total ?? NaN);
  if (!Number.isFinite(base)) {
    ui.notifications.warn("DS_TRIGGERS.Queue.PillEditorNoRoll", { localize: true });
    return;
  }
  const surge = await _resolveSurgeContext(message, state);
  const outcome = await openDamageModWindow({
    title: game.i18n.format("DS_TRIGGERS.Queue.PillEditorTitle", { name: target.name ?? "" }),
    base,
    pills: _seedPillsFromOverride(ov),
    surge,
  });
  if (!outcome) return;

  const pills = outcome.pills.map((p) => ({ kind: p.kind, value: p.value ?? null, label: p.label ?? "", source: p.source ?? "manual" }));
  const orig = _origDamageType(ov);
  if (!pills.length && !ov?.additional && (ov?.dstOrigType !== undefined || !ov?.damageType)) {
    if (ov) await _replaceOverride(message, opId, null);
    return;
  }
  const typePill = damagePillType(pills);
  const surges = pills.filter((p) => p.kind === "surge").length;
  const surgeDamage = surge?.damage ?? (Number(ov?.surgeDamage ?? 0) || 0);
  const data = {
    amount: outcome.final,
    baseAmount: base,
    bonus: 0,
    additional: ov?.additional ?? "",
    damageType: typePill != null ? typePill : orig.damageType,
    typeLabel: typePill != null ? (typePill ? damageTypeLabel(typePill) : "") : orig.typeLabel,
    dstOrigType: orig,
    surges,
    surgeDamage,
    surgeBonus: surges * surgeDamage,
    dstPills: pills,
  };
  await _replaceOverride(message, opId, data);
}

document.addEventListener("click", (ev) => {
  const btn = ev.target?.closest?.('button[data-dstd-action="editDamage"]');
  if (!btn || !_dstdActive() || !getSetting("pillDamageEditor")) return;
  const msgId = btn.closest("[data-message-id]")?.dataset?.messageId;
  const message = msgId ? game.messages.get(msgId) : null;
  if (!message) return;
  if (!message.isOwner && !game.user.isGM) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  _openPillDamageEditor(message, btn).catch((err) => console.error("DS Triggers | pill editor:", err));
}, { capture: true });

function _patchMessageEl(li) {
  const message = li?.dataset?.messageId ? game.messages.get(li.dataset.messageId) : null;
  if (!message) return;
  _patchMessageLabels(message, li);
  _applyResolutionLock(message, li);
  _renderDamagePills(message, li);
}

Hooks.on("renderChatMessageHTML", (message, html) => {
  if (!_dstdActive()) return;
  const patch = () => {
    _patchMessageLabels(message, html);
    _applyResolutionLock(message, html);
    _renderDamagePills(message, html);
  };
  patch();
  setTimeout(() => { if (html.isConnected) patch(); }, 100);
  setTimeout(() => { if (html.isConnected) patch(); }, 400);
});

Hooks.once("ready", () => {
  if (!_dstdActive()) return;
  const chatLog = document.querySelector("#chat-log") ?? document.querySelector("#chat") ?? document.body;
  const observer = new MutationObserver((mutations) => {
    const lis = new Set();
    for (const m of mutations) {
      if (m.target instanceof HTMLElement) {
        const li = m.target.closest?.("li.chat-message");
        if (li) lis.add(li);
      }
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const li = node.closest?.("li.chat-message");
        if (li) lis.add(li);
        else for (const sub of node.querySelectorAll?.("li.chat-message") ?? []) lis.add(sub);
      }
    }
    for (const li of lis) _patchMessageEl(li);
  });
  observer.observe(chatLog, { childList: true, subtree: true });
});
