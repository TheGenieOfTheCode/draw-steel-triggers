import { MODULE_ID, isPrimaryGM, dbg, resultMods, resultModsActive } from "../util.mjs";
import { queueSocket } from "../triggers/queue.mjs";
import { noteTargetsChange } from "../triggers/detectors/resolution.mjs";

const APPLY_BUTTONS = '[data-message-part] button[data-action="applyDamage"], [data-message-part] button[data-action="applyEffect"], [data-message-part] button[data-action="gainResource"], [data-message-part] button.dsct-fm-go';

const isLocked = (message) => !!message?.flags?.[MODULE_ID]?.resolutionLock;

Hooks.on("ctlib.preApplyTargetResult", (part) => {
  if (!isLocked(part?.message)) return;
  ui.notifications.warn(game.i18n.localize("DS_TRIGGERS.Queue.ResolutionLocked"));
  return false;
});

function _applyResolutionLock(message, root) {
  const buttons = root.querySelectorAll(APPLY_BUTTONS);
  if (!buttons.length) return;
  if (!isLocked(message)) return;
  for (const btn of buttons) {
    btn.dataset.dstResLock = "1";
    btn.classList.add("dst-dstd-res-locked");
    btn.disabled = true;
  }
  if (root.querySelector(".dst-dstd-res-banner")) return;
  const banner = document.createElement("div");
  banner.className = "dst-dstd-res-banner";
  banner.innerHTML = `<i class="fa-solid fa-hourglass-half"></i> ${game.i18n.localize("DS_TRIGGERS.Queue.DstdHeldLabel")}`;
  (root.querySelector(".message-content") ?? root).prepend(banner);
}

Hooks.on("renderChatMessageHTML", (message, html) => {
  if (!message.system?.parts) return;
  _applyResolutionLock(message, html);
});

async function _onApplyResolutionRedirect(payload) {
  if (!isPrimaryGM() || game.modules.get("draw-steel-target-damage")?.active) return;
  const message = game.messages.get(payload.messageId);
  const newTarget = payload.newTarget;
  if (!message || !newTarget?.tokenUuid) return;
  const origKey = String(payload.origTargetUuid ?? "");
  const parts = Array.from(message.system?.parts?.contents ?? []);
  const part = parts.find((p) => p.type === "targetResult" && (p.tokenUuid === origKey || p.targetUuid === origKey));
  if (!part || part.tokenUuid === newTarget.tokenUuid) return;
  const doc = fromUuidSync(newTarget.tokenUuid, { strict: false });
  const actorUuid = doc?.actor?.uuid ?? newTarget.actorUuid ?? null;
  if (!actorUuid) return;
  const oldName = fromUuidSync(part.tokenUuid ?? part.targetUuid, { strict: false })?.name ?? "";
  await part.update({ targetUuid: actorUuid, tokenUuid: newTarget.tokenUuid });
  if (payload.halfOnUse) {
    await game.modules.get("draw-steel-combat-tools")?.api?.resultModifiers?.addDamage?.(message, part.id, {
      kind: "half", label: payload.modName ?? "", src: payload.ownerName ?? null, source: "trigger",
    });
  }
  noteTargetsChange(message.id, parts.map((p) => (p === part ? newTarget.tokenUuid : p.tokenUuid ?? p.targetUuid)).filter(Boolean).map(String));
  dbg(`resolution redirect: ${payload.modName} moved ${oldName}'s result to ${newTarget.name}`);
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.RedirectApplied", {
    modName: payload.modName ?? "", newName: newTarget.name ?? "", oldName,
  }));
}

Hooks.once("ready", () => {
  if (game.modules.get("draw-steel-target-damage")?.active) return;
  queueSocket()?.register("applyResolutionRedirect", _onApplyResolutionRedirect);
});

const _pendingHalves = [];

Hooks.on("dst.targetedHalfRevoked", (data) => {
  for (let i = _pendingHalves.length - 1; i >= 0; i--) {
    const p = _pendingHalves[i];
    if (!p.claimed && p.abilityUuid === data.abilityUuid && p.targetActorUuid === data.targetActorUuid && p.modName === data.modName) _pendingHalves.splice(i, 1);
  }
});

Hooks.on("dst.targetedHalfUsed", (data) => {
  if (game.modules.get("draw-steel-target-damage")?.active || !resultModsActive()) return;
  _pendingHalves.push({ ...data, expires: Date.now() + 120000 });
  const message = data.messageId ? game.messages.get(data.messageId) : null;
  if (message && isPrimaryGM()) _writeHalves(message);
});

Hooks.on("createChatMessage", (message) => {
  if (_pendingHalves.length && isPrimaryGM() && resultModsActive()) _writeHalves(message);
});

async function _writeHalves(message) {
  const use = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  if (!use?.abilityUuid) return;
  const api = resultMods();
  for (const pending of _pendingHalves) {
    if (pending.claimed || pending.expires < Date.now() || pending.abilityUuid !== use.abilityUuid) continue;
    const part = api.partFor(message, pending.targetActorUuid);
    if (!part) continue;
    pending.claimed = true;
    const owner = pending.sourceActorUuid ? fromUuidSync(pending.sourceActorUuid) : null;
    const pill = { kind: "half", label: pending.modName ?? "", src: owner?.name ?? null,
      srcTokenId: owner?.getActiveTokens?.(true, false)?.[0]?.id ?? null, source: "trigger" };
    const indexes = Array.from(part.rolls ?? []).map((r, i) => (r instanceof ds.rolls.DamageRoll && !r.isHeal ? i : -1)).filter((i) => i >= 0);
    for (const index of indexes) await api.addDamage(message, part.id, pill, { index });
    dbg(`half damage from ${pending.modName} written onto ${part.actorTarget?.name ?? "a target"}'s result`);
  }
  for (let i = _pendingHalves.length - 1; i >= 0; i--) {
    if (_pendingHalves[i].claimed || _pendingHalves[i].expires < Date.now()) _pendingHalves.splice(i, 1);
  }
}
