import { MODULE_ID, dbg, getSetting, isPrimaryGM } from "../util.mjs";
import { getActiveDamageHolds, queueSocket, noteHeldLinked } from "../triggers/queue.mjs";
import { noteTargetsChange } from "../triggers/detectors/resolution.mjs";
import { setTip, textTip } from "../ui/tips.mjs";

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
  if (!isPrimaryGM() || !_dstdActive()) return;
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
        setTimeout(() => noteHeldLinked(hold), 0);
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
  if (!isPrimaryGM() || !_dstdActive()) return;
  for (const message of game.messages.contents.slice(-10)) _markHeldRecords(message);
});

Hooks.on("dst.damageHoldResolved", async ({ hold, finalAmount, redirect = null }) => {
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

  if (redirect) {
    updated.dstRedirected = { name: redirect.name ?? "", modName: redirect.modName ?? "", byHand: !!redirect.byHand };
    updated.after = updated.before;
  } else if (!(finalAmount > 0)) {
    
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

  const extra = redirect?.token?.tokenUuid ? _redirectedRow(message, entry, redirect) : {};
  dbg(`dstd sync: record ${message.id}:${opId} -> ${finalAmount}`);
  await message.update({
    [`flags.${DSTD_ID}.state.applications.${opId}`]: updated,
    ...extra,
    [`flags.${DSTD_ID}.state.updatedAt`]: Date.now(),
  });
});

function _redirectedRow(message, entry, redirect) {
  const state = foundry.utils.getProperty(message.flags, `${DSTD_ID}.state`) ?? {};
  const targets = [...(state.targets ?? [])];
  if (!targets.some((t) => t.tokenUuid === redirect.token.tokenUuid)) targets.push(redirect.token);
  const newOp = _dstdOperationId(redirect.token, entry.partId, entry.rollIndex);
  noteTargetsChange(message.id, targets.map((t) => String(t.tokenUuid ?? t.actorUuid ?? "")));
  const keyOf = (t) => String(t?.tokenUuid ?? t?.actorUuid ?? "").replace(/\./g, "__");
  const oldKey = keyOf(entry.target), newKey = keyOf(redirect.token);
  const oldHash = `-${_dstdHash(oldKey)}`, newHash = `-${_dstdHash(newKey)}`;
  const moved = (k) => (k.endsWith(oldHash) ? k.slice(0, -oldHash.length) + newHash : null);
  const copies = {};
  if (state.tierOverrides?.[oldKey]) copies[`flags.${DSTD_ID}.state.tierOverrides.${newKey}`] = foundry.utils.deepClone(state.tierOverrides[oldKey]);
  for (const [k, v] of Object.entries(state.damageOverrides ?? {})) {
    const nk = moved(k);
    if (nk && !(nk in state.damageOverrides)) copies[`flags.${DSTD_ID}.state.damageOverrides.${nk}`] = foundry.utils.deepClone(v);
  }
  const rollPills = message.flags?.["draw-steel-combat-tools"]?.rollPills?.targets?.[oldKey];
  if (rollPills) copies[`flags.draw-steel-combat-tools.rollPills.targets.${newKey}`] = foundry.utils.deepClone(rollPills);
  for (const [k, v] of Object.entries(message.flags?.[MODULE_ID]?.damagePills ?? {})) {
    const nk = moved(k);
    if (nk) copies[`flags.${MODULE_ID}.damagePills.${nk}`] = foundry.utils.deepClone(v);
  }
  return {
    ...copies,
    [`flags.${DSTD_ID}.state.targets`]: targets,
    [`flags.${DSTD_ID}.state.applications.${newOp}`]: {
      kind: "damage", status: "applied", target: redirect.token, partId: entry.partId, rollIndex: entry.rollIndex,
      amount: redirect.amount, originalAmount: redirect.amount, halfDamage: false, damageType: entry.damageType ?? "", typeLabel: entry.typeLabel ?? "",
      override: null, surgeSpend: null, before: redirect.before, after: redirect.after,
      appliedByUserId: game.user.id, appliedByUserName: game.user.name, appliedAt: Date.now(),
      dstRedirectedFrom: { name: entry.target?.name ?? "", modName: redirect.modName ?? "" },
    },
  };
}

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
  if (data.messageId && isPrimaryGM()) {
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
    const sourceUuid = pending.sourceActorUuid ?? pending.targetActorUuid;
    const halfOwner = sourceUuid ? fromUuidSync(sourceUuid) : null;
    const halfFields = {
      dstHalf: true,
      dstModName: pending.modName ?? "",
      dstSrcName: halfOwner?.name ?? null,
      dstSrcTokenId: halfOwner?.getActiveTokens?.(true, false)[0]?.id ?? null,
    };
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
          ...halfFields,
        };
      }
    }
    
    
    
    const ability = fromUuidSync(abilityUse.abilityUuid);
    let dmgIndex = 0;
    for (const powerEffect of ability?.system?.power?.effects ?? []) {
      if (powerEffect.type !== "damage") continue;
      const effKey = powerEffect.id ?? powerEffect._id ?? `damage-${dmgIndex}`;
      for (const tier of [1, 2, 3]) {
        const tierData = powerEffect.damage?.[`tier${tier}`];
        if (!tierData || Number(tierData.value) === 0) continue;
        let amount = NaN;
        try {
          amount = Number(ds?.utils?.simplifyRollFormula?.(String(tierData.value ?? "0"), ability.getRollData?.() ?? {}));
        } catch {  }
        if (!Number.isFinite(amount)) amount = Number(tierData.value);
        if (!Number.isFinite(amount)) continue;
        const opId = _dstdOperationId(target, `tier${tier}-synthetic`, effKey);
        if (state.damageOverrides?.[opId] || updates[`flags.${DSTD_ID}.state.damageOverrides.${opId}`]) continue;
        const type = tierData.types?.size === 1 ? tierData.types.first() : "";
        let typeLabel = "";
        try { typeLabel = type ? game.i18n.localize(ds?.CONFIG?.damageTypes?.[type]?.label ?? "") : ""; } catch {}
        updates[`flags.${DSTD_ID}.state.damageOverrides.${opId}`] = {
          amount: Math.floor(amount / 2),
          baseAmount: amount,
          damageType: type,
          typeLabel,
          ...halfFields,
        };
      }
      dmgIndex++;
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
  if (!isPrimaryGM() || !_dstdActive()) return;
  _tryWriteHalfOverrides(message);
  _markHeldRecords(message);
});

Hooks.on("updateChatMessage", (message, changed) => {
  if (!isPrimaryGM() || !_dstdActive()) return;
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
    update[`flags.${MODULE_ID}.damagePills.${opId}`] = new foundry.data.operators.ForcedDeletion();
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
    if (entry.dstRedirected) {
      const r = entry.dstRedirected;
      for (const btn of root.querySelectorAll(`button[data-dstd-action="applyDamage"][data-operation-id="${opId}"]`)) {
        btn.classList.add("dst-dstd-held-btn", "dst-dstd-redirected-btn");
        const icon = btn.querySelector("i");
        if (icon && !icon.classList.contains("fa-shuffle")) icon.className = "fa-solid fa-shuffle";
        const span = btn.querySelector("span");
        const label = r.byHand ? game.i18n.localize("DS_TRIGGERS.Queue.DstdRedirectedByHand") : game.i18n.format("DS_TRIGGERS.Queue.DstdRedirected", { name: r.name });
        if (span && span.textContent !== label) span.textContent = label;
        if (r.modName) setTip(btn, textTip(r.modName, { label, categoryKey: "Category" }));
      }
      for (const undo of root.querySelectorAll(`button[data-dstd-action="undoDamage"][data-operation-id="${opId}"]`)) undo.disabled = true;
      continue;
    }
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
    } else if (entry.override?.dstHalf && !entry.override?.dstHalfOff && !entry.halfDamage) {
      for (const btn of root.querySelectorAll(`button[data-dstd-action="applyDamage"][data-operation-id="${opId}"]`)) _suffixSpan(btn, "Half");
    }
  }

  for (const [opId, override] of Object.entries(overrides)) {
    if (!override?.dstHalf || override.dstHalfOff || apps[opId]?.status === "applied") continue;
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

async function _clearStaleHeldDamage() {
  if (!isPrimaryGM() || !_dstdActive() || getActiveDamageHolds().size) return;
  for (const message of game.messages.contents) {
    const apps = foundry.utils.getProperty(message.flags, `${DSTD_ID}.state.applications`) ?? {};
    const updates = {};
    for (const [opId, entry] of Object.entries(apps)) {
      if (!entry?.dstHeld) continue;
      const path = `flags.${DSTD_ID}.state.applications.${opId}`;
      updates[`${path}.dstHeld`] = false;
      if (entry.status === "applied" && _snapshotsEqual(entry.before, entry.after)) {
        Object.assign(updates, {
          [`${path}.status`]: "undone",
          [`${path}.undoneByUserId`]: game.user.id,
          [`${path}.undoneByUserName`]: game.user.name,
          [`${path}.undoneAt`]: Date.now(),
          [`${path}.afterUndo`]: entry.before,
        });
      }
    }
    if (!Object.keys(updates).length) continue;
    updates[`flags.${DSTD_ID}.state.updatedAt`] = Date.now();
    dbg(`dstd sync: cleared stale held damage on ${message.id}`, updates);
    await message.update(updates).catch(() => {});
  }
}

Hooks.once("ready", () => _clearStaleHeldDamage());

Hooks.once("ready", () => {
  const api = game.modules.get("draw-steel-combat-tools")?.api?.damagePills;
  if (!api || !_dstdActive()) return;
  api.registerProvider((message) => {
    const out = [];
    const apps = foundry.utils.getProperty(message.flags, DSTD_ID + ".state.applications") ?? {};
    const stored = message.getFlag(MODULE_ID, "damagePills") ?? {};
    for (const [opId, data] of Object.entries(stored)) {
      if (apps[opId]?.status !== "applied") continue;
      for (const p of data.pills ?? []) out.push({ opId, pill: p });
    }
    for (const [key, halves] of Object.entries(message.getFlag(MODULE_ID, "retierHalf") ?? {})) {
      for (const h of halves ?? []) out.push({ targetUuid: key.replace(/__/g, "."), pill: { kind: "half", label: h.label, src: h.src ?? null, source: "trigger" } });
    }
    return out;
  });
});

Hooks.once("setup", () => {
  game.modules.get("draw-steel-ctlib").api.registerPanelDecorator({
    id: "triggers-held-damage",
    priority: 500,
    watch: "any",
    immediate: true,
    retry: [100, 400],
    decorate: ({ message, root }) => {
      _patchMessageLabels(message, root);
      _applyResolutionLock(message, root);
    },
  });
});

async function _onApplyResolutionRedirect(payload) {
  if (!isPrimaryGM() || !_dstdActive()) return;
  const message = game.messages.get(payload.messageId);
  if (!message) return;
  const state = foundry.utils.getProperty(message.flags, `${DSTD_ID}.state`);
  if (!state?.targets?.length) return;

  const origKey = String(payload.origTargetUuid ?? "");
  const orig = state.targets.find((t) => String(t.tokenUuid ?? t.actorUuid ?? "") === origKey);
  const newTarget = payload.newTarget;
  if (!orig || !newTarget?.tokenUuid) return;
  if (orig.tokenUuid === newTarget.tokenUuid) return;

  const DamageRoll = ds?.rolls?.DamageRoll;
  const overrides = state.damageOverrides ?? {};
  const updates = {};
  let moved = 0;

  for (const part of message.system?.parts?.contents ?? []) {
    const partId = part.id ?? part._id;
    const rolls = part.rolls ?? [];
    for (let i = 0; i < rolls.length; i++) {
      const roll = rolls[i];
      const isDamage = DamageRoll ? roll instanceof DamageRoll : roll?.constructor?.name === "DamageRoll";
      if (!isDamage || roll?.isHeal) continue;
      const fromId = _dstdOperationId(orig, partId, i);
      const toId = _dstdOperationId(newTarget, partId, i);
      const carried = overrides[fromId]
        ? foundry.utils.deepClone(overrides[fromId])
        : {
          amount: Number(roll.total ?? 0), baseAmount: Number(roll.total ?? 0),
          damageType: roll.type ?? roll.options?.type ?? "", typeLabel: roll.typeLabel ?? "",
        };
      const moving = { ...carried, dstRedirect: true, dstRedirectMod: payload.modName ?? "", dstRedirectFrom: orig.name ?? "" };
      if (payload.halfOnUse && !moving.dstHalf) {
        const owner = newTarget.actorUuid ? fromUuidSync(newTarget.actorUuid) : null;
        moving.baseAmount = Number(moving.baseAmount ?? moving.amount ?? 0);
        moving.amount = Math.floor(moving.baseAmount / 2);
        moving.dstHalf = true;
        moving.dstModName = payload.modName ?? "";
        moving.dstSrcName = payload.ownerName || owner?.name || null;
        moving.dstSrcTokenId = newTarget.tokenId ?? null;
      }
      updates[`flags.${DSTD_ID}.state.damageOverrides.${toId}`] = moving;
      if (overrides[fromId]) updates[`flags.${DSTD_ID}.state.damageOverrides.${fromId}`] = new foundry.data.operators.ForcedDeletion();
      moved++;
    }
  }
  if (!moved) return;

  const targets = state.targets.filter((t) => String(t.tokenUuid ?? t.actorUuid ?? "") !== origKey);
  if (!targets.some((t) => t.tokenUuid === newTarget.tokenUuid)) targets.push(newTarget);
  updates[`flags.${DSTD_ID}.state.targets`] = targets;
  updates[`flags.${DSTD_ID}.state.updatedAt`] = Date.now();

  noteTargetsChange(payload.messageId, targets.map((t) => String(t.tokenUuid ?? t.actorUuid ?? "")));
  await message.update(updates);
  dbg(`resolution redirect: ${payload.modName} moved ${moved} damage row(s) from ${orig.name} to ${newTarget.name}`);
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.RedirectApplied", {
    modName: payload.modName ?? "", newName: newTarget.name ?? "", oldName: orig.name ?? "",
  }));
}

Hooks.once("ready", () => {
  queueSocket()?.register("applyResolutionRedirect", _onApplyResolutionRedirect);
});
