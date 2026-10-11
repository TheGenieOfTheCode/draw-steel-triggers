import { batchedNotice } from "../../util.mjs";
import { collectTriggerMatches, triggersLive } from "../dispatch.mjs";
import { enqueueLockEntries, queueSocket } from "../queue.mjs";

const OPTIONAL = /\b(?:you|they) (?:can|may)\b/i;
const _pendingFalls = new Map();

const jumpDistance = (actor) => {
  const c = actor?.system?.characteristics ?? {};
  return Math.max(1, Number(c.might?.value) || 0, Number(c.agility?.value) || 0);
};

const reductionOf = (clause, actor) => clause.fallReduction === "jump" ? jumpDistance(actor) : Number(clause.fallReduction) || 0;

function effectOf(match) {
  const actor = match.actor;
  const cancel = !!match.clause.fallCancel && (Number(actor.system?.movement?.value) || 0) > 0;
  return { cancel, reduction: cancel ? 0 : reductionOf(match.clause, actor) };
}

Hooks.on("dsct.preFall", (ctx) => {
  if (!triggersLive()) return;
  const token = ctx.token?.document ?? ctx.token;
  const actor = token?.actor;
  if (!actor) return;
  const matches = collectTriggerMatches("FALL_START", actor, token).filter((m) =>
    !m.malice && (m.parse?.confidence === "high" || m.parse?.source === "manual"));
  if (!matches.length) return;

  const optional = (m) => !!m.item.featureLine?.action || OPTIONAL.test(m.item.featureLine?.effect ?? m.item.system?.effect ?? "")
    || !m.item.featureLine;
  for (const m of matches.filter((x) => !optional(x))) {
    const { reduction } = effectOf(m);
    if (!reduction) continue;
    ctx.reduction += reduction;
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.FallReduced", { name: m.item.name, n: reduction }));
  }

  const held = matches.filter(optional);
  if (!held.length) return;
  const fallId = foundry.utils.randomID();
  const effects = new Map(held.map((m) => [m.item.uuid, effectOf(m)]));
  ctx.holds.push(new Promise((resolve) => _pendingFalls.set(fallId, { resolve, effects })));
  enqueueLockEntries(held, {
    event: "FALL_LOCK",
    causeLabel: game.i18n.format("DS_TRIGGERS.Queue.FallLockCause", { name: token.name }),
    resume: { userId: game.user.id, kind: "fall", fallId },
    held: {
      itemUuid: null,
      itemName: game.i18n.format("DS_TRIGGERS.Queue.FallHeldTitle", { name: token.name, n: ctx.height }),
      ownerActorUuid: actor.uuid,
      ownerName: token.name,
    },
  });
  batchedNotice("FallHeld", token.name);
});

function _onResumeFall(fallId, usedItemUuids = []) {
  const pending = _pendingFalls.get(fallId);
  if (!pending) return;
  _pendingFalls.delete(fallId);
  const mods = { reduction: 0, cancel: false };
  for (const uuid of usedItemUuids) {
    const effect = pending.effects.get(uuid);
    if (!effect) continue;
    mods.reduction += effect.reduction;
    if (effect.cancel) mods.cancel = true;
  }
  pending.resolve(mods);
}

Hooks.once("ready", () => {
  queueSocket()?.register("resumeFall", _onResumeFall);
});
