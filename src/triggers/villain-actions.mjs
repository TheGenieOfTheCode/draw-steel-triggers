import { MODULE_ID, getSetting, dbg } from "../util.mjs";
import { dismissVillainEntries } from "./queue.mjs";

const FLAG = "villainActions";

export const isVillainAction = (item) => item?.type === "ability" && item.system?.type === "villain";

const _key = (tokenId, itemId) => `${tokenId}-${itemId}`;
const _record = (combat) => combat?.getFlag(MODULE_ID, FLAG) ?? {};
const _isDown = (c) => !!(c.isDefeated || c.actor?.statuses?.has("dead"));

export function villainActionsOf(actor) {
  return (actor?.items?.contents ?? []).filter(isVillainAction).sort((a, b) => a.sort - b.sort);
}

export function villainUsed(combat, tokenId, itemId) {
  return !!_record(combat)[_key(tokenId, itemId)];
}

export function villainUsedThisRound(combat, tokenId) {
  return Object.values(_record(combat)).some((r) => r.tokenId === tokenId && r.round === combat.round);
}

export async function setVillainUsed(combat, tokenId, itemId, used) {
  if (!combat || !tokenId || !itemId) return;
  const key = _key(tokenId, itemId);
  const value = used ? { tokenId, itemId, round: combat.round } : new foundry.data.operators.ForcedDeletion();
  await combat.update({ [`flags.${MODULE_ID}.${FLAG}.${key}`]: value });
  dbg(`villain action ${used ? "used" : "unused"}: ${key} (round ${combat.round})`);
}

export function villainMatches(combat, prev) {
  if (!getSetting("offerVillainActions") || !combat?.started) return [];
  if (prev?.actor?.type !== "hero") return [];
  const matches = [];
  for (const c of combat.combatants) {
    const actor = c.actor;
    if (!actor || actor.type !== "npc" || _isDown(c)) continue;
    if (villainUsedThisRound(combat, c.tokenId)) continue;
    villainActionsOf(actor).forEach((item, i) => {
      if (villainUsed(combat, c.tokenId, item.id)) return;
      matches.push({
        actor,
        item,
        _villain: { combatId: combat.id, tokenId: c.tokenId, order: i + 1 },
        _lockEvent: "TURN_END",
        _causeLabel: game.i18n.format("DS_TRIGGERS.Villain.Cause", { n: i + 1, name: prev.name }),
      });
    });
  }
  if (matches.length) dbg(`villain actions offered after ${prev.name}'s turn: ${matches.map((m) => m.item.name).join(", ")}`);
  return matches;
}

function _combatantFor(item) {
  const actor = item?.parent;
  if (!actor || !game.combat?.started) return null;
  return game.combat.combatants.find((c) => c.actor === actor) ?? null;
}

Hooks.on("getDocumentListContextOptions", (sheet, options) => {
  if (!Array.isArray(options) || typeof sheet?._getEmbeddedDocument !== "function") return;
  const villainAt = (target) => {
    if (!game.user.isGM) return null;
    const item = sheet._getEmbeddedDocument(target);
    if (!isVillainAction(item)) return null;
    const combatant = _combatantFor(item);
    return combatant ? { item, combatant, used: villainUsed(game.combat, combatant.tokenId, item.id) } : null;
  };
  const mark = async (target, used) => {
    const hit = villainAt(target);
    if (!hit) return;
    await setVillainUsed(game.combat, hit.combatant.tokenId, hit.item.id, used);
    if (used) dismissVillainEntries(hit.combatant.tokenId);
    ui.notifications.info(game.i18n.format(used ? "DS_TRIGGERS.Villain.MarkedUsed" : "DS_TRIGGERS.Villain.MarkedUnused", { name: hit.item.name }));
  };
  options.push(
    {
      label: "DS_TRIGGERS.Villain.MenuMarkUsed",
      icon: "fa-solid fa-check",
      visible: (target) => { const hit = villainAt(target); return !!hit && !hit.used; },
      onClick: (_event, target) => mark(target, true),
    },
    {
      label: "DS_TRIGGERS.Villain.MenuMarkUnused",
      icon: "fa-solid fa-rotate-left",
      visible: (target) => { const hit = villainAt(target); return !!hit && hit.used; },
      onClick: (_event, target) => mark(target, false),
    },
  );
});

function _onFallen(actor) {
  if (!isVillainActor(actor)) return;
  const tokenIds = actor.isToken ? [actor.token.id] : actor.getActiveTokens(false, true).map((t) => t.id);
  for (const id of tokenIds) dismissVillainEntries(id);
}

function isVillainActor(actor) {
  return !!actor && villainActionsOf(actor).length > 0;
}

Hooks.on("createActiveEffect", (effect, _options, userId) => {
  if (userId !== game.user.id || !effect.statuses?.has("dead")) return;
  _onFallen(effect.parent);
});

Hooks.on("updateCombatant", (combatant, changed, _options, userId) => {
  if (userId !== game.user.id || changed.defeated !== true) return;
  _onFallen(combatant.actor);
});

Hooks.on("deleteCombatant", (combatant, _options, userId) => {
  if (userId !== game.user.id || !isVillainActor(combatant.actor)) return;
  dismissVillainEntries(combatant.tokenId);
});
