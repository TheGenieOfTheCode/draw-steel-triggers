import { MODULE_ID, getSetting, dbg, isPrimaryGM } from "../util.mjs";
import { isMaliceAbility } from "./registry.mjs";
import { asPrimaryGM } from "./queue.mjs";

const CT_ID = "draw-steel-combat-tools";
const TRACKER_ICON = "icons/magic/symbols/question-stone-yellow.webp";

const isTracker = (scope) => (e) => e.getFlag(scope, "effectType") === "triggered-action";

function combatantFor(actor) {
  const inCombat = (c) => c?.combatants.find((x) => x.actor === actor) ?? null;
  return inCombat(game.combat) ?? game.combats.map(inCombat).find(Boolean) ?? null;
}

const ctTrackerOn = () => !!game.modules.get(CT_ID)?.active && game.settings.get(CT_ID, "autoTriggeredActionsEnabled") !== false;

function trackerEffect(actor) {
  if (game.modules.get(CT_ID)?.active) {
    const ct = actor?.effects.find(isTracker(CT_ID));
    if (ct) return ct;
  }
  return actor?.effects.find(isTracker(MODULE_ID)) ?? null;
}

export function isTriggeredActionSpent(actor) {
  if (!getSetting("spentTracking")) return false;
  const effect = trackerEffect(actor);
  if (effect) return effect.disabled;
  return !!combatantFor(actor)?.getFlag(MODULE_ID, "spent");
}

export async function setTriggeredActionSpent(actor, spent = true) {
  const effect = trackerEffect(actor);
  if (effect) {
    if (effect.disabled === spent) return;
    if (!effect.isOwner) return asPrimaryGM("spentWrite", actor.uuid, spent);
    await effect.update({ disabled: spent });
    return;
  }
  const combatant = combatantFor(actor);
  if (!combatant) return;
  if (!combatant.isOwner) return asPrimaryGM("spentWrite", actor.uuid, spent);
  if (spent) await combatant.setFlag(MODULE_ID, "spent", true);
  else await combatant.unsetFlag(MODULE_ID, "spent");
}

export async function onSpentWrite(actorUuid, spent) {
  const actor = game.user.isGM ? await fromUuid(actorUuid).catch(() => null) : null;
  if (actor) await setTriggeredActionSpent(actor, spent);
}

const hasTriggeredAction = (actor) => actor?.items.some((i) => i.system?.type === "triggered" && !isMaliceAbility(i));

const ownTrackerOn = () => isPrimaryGM() && getSetting("spentTracking") && !ctTrackerOn();

const _ensuring = new Map();

function ensureTracker(actor) {
  const key = actor?.uuid;
  if (!key) return;
  const prior = _ensuring.get(key) ?? Promise.resolve();
  const next = prior.then(() => _ensureTracker(actor));
  _ensuring.set(key, next);
  next.finally(() => { if (_ensuring.get(key) === next) _ensuring.delete(key); });
  return next;
}

async function _ensureTracker(actor) {
  if (!hasTriggeredAction(actor)) return;
  if (game.modules.get(CT_ID)?.active && actor.effects.some(isTracker(CT_ID))) return removeTracker(actor);
  const own = actor.effects.filter(isTracker(MODULE_ID));
  if (own.length) {
    for (const e of own) if (e.disabled) await e.update({ disabled: false }).catch(() => {});
    return;
  }
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: game.i18n.localize("DS_TRIGGERS.Spent.EffectName"),
    img: TRACKER_ICON,
    type: "base",
    disabled: false,
    transfer: false,
    description: game.i18n.localize("DS_TRIGGERS.Spent.EffectHint"),
    duration: { expiry: "combatEnd" },
    flags: { [MODULE_ID]: { effectType: "triggered-action" }, "draw-steel-ctlib": { noLog: true } },
  }]).catch((err) => dbg("could not add the triggered action tracker", err));
}

async function removeTracker(actor) {
  const own = actor?.effects.filter(isTracker(MODULE_ID)) ?? [];
  if (own.length) await actor.deleteEmbeddedDocuments("ActiveEffect", own.map((e) => e.id)).catch(() => {});
}

const fighting = (combat) => combat.combatants.contents.filter((c) => !c.isDefeated && c.actor).map((c) => c.actor);

Hooks.on("createChatMessage", async (message) => {
  if (!isPrimaryGM()) return;
  if (!getSetting("spentTracking")) return;
  const abilityUse = message.system?.parts?.contents?.find(p => p.type === "abilityUse");
  if (!abilityUse?.abilityUuid) return;
  const item = await fromUuid(abilityUse.abilityUuid).catch(() => null);
  if (item?.system?.type !== "triggered") return;
  if (isMaliceAbility(item)) return;
  const actor = ChatMessage.getSpeakerActor(message.speaker);
  if (!actor) return;
  dbg(`triggered action spent: ${actor.name} used ${item.name}`);
  await setTriggeredActionSpent(actor, true);
});

Hooks.on("combatStart", async (combat) => {
  if (!ownTrackerOn()) return;
  for (const actor of fighting(combat)) await ensureTracker(actor);
});

Hooks.on("createCombatant", async (combatant) => {
  if (!ownTrackerOn() || !combatant.parent?.started || !combatant.actor) return;
  await ensureTracker(combatant.actor);
});

Hooks.on("updateCombatant", async (combatant, changes) => {
  if (!("defeated" in changes) || !isPrimaryGM() || !combatant.actor) return;
  if (changes.defeated) await removeTracker(combatant.actor);
  else if (ownTrackerOn() && combatant.parent?.started) await ensureTracker(combatant.actor);
});

Hooks.on("combatTurnChange", async (combat, previous, current) => {
  if (!isPrimaryGM()) return;
  if (!previous || current.round === previous.round) return;
  for (const combatant of combat.combatants) {
    if (combatant.getFlag(MODULE_ID, "spent")) await combatant.unsetFlag(MODULE_ID, "spent");
  }
  if (!ownTrackerOn()) return;
  for (const actor of fighting(combat)) await ensureTracker(actor);
});

Hooks.on("deleteCombat", async (combat) => {
  if (!isPrimaryGM()) return;
  const stillFighting = new Set(game.combats.filter((c) => c !== combat && c.started).flatMap((c) => c.combatants.contents.map((x) => x.actor)));
  for (const c of combat.combatants) if (c.actor && !stillFighting.has(c.actor)) await removeTracker(c.actor);
});
