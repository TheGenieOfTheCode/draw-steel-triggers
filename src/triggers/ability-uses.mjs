import { MODULE_ID } from "../util.mjs";

const FLAG = "abilityUses";

const actorUuidOf = (t) => (t?.actor ?? t?.document?.actor ?? (t?.documentName === "Actor" ? t : null))?.uuid ?? null;

export async function recordAbilityUse(actor, item, targets = []) {
  const combat = game.combat;
  if (!actor || !item?.id || !combat?.started) return;
  const uuids = [...new Set(targets.map(actorUuidOf).filter(Boolean))];
  await actor.setFlag(MODULE_ID, `${FLAG}.${item.id}`, { combat: combat.id, round: combat.round, turn: combat.turn, targets: uuids.length ? uuids : null });
}

export const abilityUseOf = (item) => item?.actor?.getFlag(MODULE_ID, `${FLAG}.${item.id}`) ?? null;

function ownerTurnIndex(combat, actor) {
  return combat.turns.findIndex((c) => c.actor === actor || (c.actor && actor && c.actor.uuid === actor.uuid));
}

const before = (a, b) => a.round < b.round || (a.round === b.round && a.turn < b.turn);

function dying(actor) {
  if (actor?.type !== "hero") return false;
  return Number(actor.system?.stamina?.value ?? 1) <= 0;
}

export function useLive(item, used) {
  const rec = abilityUseOf(item);
  const combat = game.combat;
  if (!rec || !used || !combat?.started || rec.combat !== combat.id) return false;
  if (used.dying && dying(item.actor)) return false;
  const now = { round: combat.round, turn: combat.turn };
  switch (used.until) {
    case "round": return now.round === rec.round;
    case "turn": return now.round === rec.round && now.turn === rec.turn;
    case "nextTurnStart":
    case "nextTurnEnd": {
      const own = ownerTurnIndex(combat, item.actor);
      if (own < 0) return now.round === rec.round;
      const next = rec.turn < own ? { round: rec.round, turn: own } : { round: rec.round + 1, turn: own };
      return used.until === "nextTurnStart" ? before(now, next) : before(now, { round: next.round, turn: next.turn + 1 });
    }
    default: return true;
  }
}

export const useTargets = (item) => abilityUseOf(item)?.targets ?? null;

Hooks.on("deleteCombat", (combat) => {
  if (!game.users.activeGM?.isSelf) return;
  for (const c of combat.combatants) {
    const uses = c.actor?.getFlag(MODULE_ID, FLAG);
    if (!uses) continue;
    const stale = Object.entries(uses).filter(([, u]) => u?.combat === combat.id).map(([id]) => `flags.${MODULE_ID}.${FLAG}.-=${id}`);
    if (stale.length) c.actor.update(Object.fromEntries(stale.map((k) => [k, null]))).catch(() => {});
  }
});
