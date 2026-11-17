import { MODULE_ID, isPrimaryGM, dbg } from "../util.mjs";
import { cardContent, postSystemCard, withFaces } from "../ui/system-card.mjs";
import { forgetFeatureLineUse, noteFeatureLineUse, itemEffectiveLines } from "./feature-triggers.mjs";
import { setTriggeredActionSpent, isTriggeredActionSpent } from "./spent-tracking.mjs";
import { isMaliceAbility, abilityOnce, abilityOnceKey } from "./registry.mjs";

const CT_ID = "draw-steel-combat-tools";
const lib = () => game.modules.get("draw-steel-ctlib")?.api;
const L = (key, data) => (data ? game.i18n.format(`DS_TRIGGERS.UseUndo.${key}`, data) : game.i18n.localize(`DS_TRIGGERS.UseUndo.${key}`));

const _armed = new Set();

const useOf = (message) => message?.flags?.[MODULE_ID]?.use ?? null;

const liveApplies = (message) => (lib()?.journal?.(message) ?? []).filter((e) => !e.undone).length
  + (lib()?.services?.get?.("liveApplies")?.(message) ?? 0);

const parentOf = (message) => {
  const id = message?.flags?.[CT_ID]?.isFmUndo ? message.flags[CT_ID].contextMessageId : null;
  return id ? game.messages.get(id) ?? null : null;
};

function describeUse(message) {
  const part = message.system?.parts?.contents?.find?.((p) => p.type === "abilityUse");
  const actor = ChatMessage.getSpeakerActor(message.speaker);
  if (!actor) return null;
  if (part?.abilityUuid) {
    const item = fromUuidSync(part.abilityUuid, { strict: false });
    if (item?.system?.type !== "triggered" || isMaliceAbility(item)) return null;
    const period = abilityOnce(item);
    return { actor: actor.uuid, name: item.name, action: true, once: period ? abilityOnceKey(item) : null, period };
  }
  const feature = message.flags?.[MODULE_ID]?.featureUse;
  if (!feature?.key) return null;
  const item = fromUuidSync(feature.itemUuid, { strict: false });
  const line = item ? itemEffectiveLines(item).find((l) => l.key === feature.key) : null;
  if (!line) return null;
  const use = { actor: actor.uuid, name: item.name, action: line.action === "triggered", once: line.once ? feature.key : null, period: line.once ?? null };
  return use.action || use.once ? use : null;
}

async function stamp(message) {
  if (useOf(message)) return;
  const use = describeUse(message);
  if (!use) return;
  const actor = fromUuidSync(use.actor);
  const has = (c) => c?.started && c.combatants.some((x) => x.actor === actor);
  const combat = (has(game.combat) ? game.combat : game.combats.find(has)) ?? null;
  Object.assign(use, { combat: combat?.id ?? null, round: combat?.round ?? null, turn: combat?.turn ?? null, undone: false });
  await message.setFlag(MODULE_ID, "use", use).catch((err) => dbg("could not stamp a trigger use", err));
}

const sameUse = (a, b) => a.actor === b.actor && a.combat === b.combat;

function stillUsed(use, exceptId, test) {
  return game.messages.some((m) => {
    if (m.id === exceptId) return false;
    const other = useOf(m);
    return other && !other.undone && sameUse(other, use) && test(other);
  });
}

function periodOpen(use, combat) {
  if (!combat || !use.period) return false;
  if (use.period === "encounter") return true;
  if (use.period === "round") return combat.round === use.round;
  if (use.period === "turn") return combat.round === use.round && combat.turn === use.turn;
  return false;
}

async function refund(message, use, why) {
  const actor = fromUuidSync(use.actor);
  const combat = use.combat ? game.combats.get(use.combat) : null;
  if (!actor || !combat) return;
  const back = [];
  if (use.action && combat.round === use.round && isTriggeredActionSpent(actor)
    && !stillUsed(use, message.id, (o) => o.action && o.round === use.round)) {
    await setTriggeredActionSpent(actor, false);
    back.push(L("Action"));
  }
  if (use.once && periodOpen(use, combat) && !stillUsed(use, message.id, (o) => o.once === use.once)) {
    forgetFeatureLineUse(actor, use.once);
    back.push(L(`Once.${use.period}`, { name: use.name }));
  }
  if (game.messages.has(message.id)) await message.setFlag(MODULE_ID, "use.undone", true).catch(() => {});
  dbg(`trigger use ${why}: ${actor.name} ${use.name}, gave back ${back.join(", ") || "nothing"}`);
  if (!back.length) return;
  const esc = foundry.utils.escapeHTML;
  const intro = withFaces(L(why === "deleted" ? "BodyDeleted" : "BodyUndone", { owner: actor.name, reaction: use.name }), [actor])
    .replace(esc(use.name), `<strong>${esc(use.name)}</strong>`);
  const recipients = game.users.filter((u) => u.isGM || actor.testUserPermission(u, "OWNER")).map((u) => u.id);
  await postSystemCard({
    title: L("Title"),
    flavor: null,
    kind: "Reminder",
    content: cardContent({ intro, body: `<p>${esc(L("Back", { list: back.join(", ") }))}</p>` }),
    whisper: recipients,
  });
}

async function respend(message, use) {
  const actor = fromUuidSync(use.actor);
  if (!actor) return;
  await message.setFlag(MODULE_ID, "use.undone", false).catch(() => {});
  const combat = use.combat ? game.combats.get(use.combat) : null;
  if (use.action && combat?.round === use.round) await setTriggeredActionSpent(actor, true);
  if (use.once && periodOpen(use, combat)) noteFeatureLineUse(actor, use.once);
  dbg(`trigger use reapplied: ${actor.name} ${use.name}`);
}

async function evaluate(message) {
  const use = useOf(message);
  if (!use) return;
  const live = liveApplies(message);
  if (live > 0) {
    _armed.add(message.id);
    if (use.undone) await respend(message, use);
    return;
  }
  if (!_armed.has(message.id) || use.undone) return;
  _armed.delete(message.id);
  await refund(message, use, "undone");
}

export function registerUseUndo() {
  Hooks.on("createChatMessage", async (message) => {
    if (!isPrimaryGM()) return;
    const parent = parentOf(message);
    if (parent) return evaluate(parent);
    await stamp(message);
  });
  Hooks.on("updateChatMessage", (message) => {
    if (!isPrimaryGM()) return;
    const target = parentOf(message) ?? message;
    if (useOf(target)) evaluate(target);
  });
  Hooks.on("deleteChatMessage", (message) => {
    if (!isPrimaryGM()) return;
    _armed.delete(message.id);
    const use = useOf(message);
    if (use && !use.undone) refund(message, use, "deleted");
  });
  Hooks.once("ready", () => {
    if (!isPrimaryGM()) return;
    for (const m of game.messages) {
      const use = useOf(m);
      if (use && !use.undone && liveApplies(m) > 0) _armed.add(m.id);
    }
  });
}
