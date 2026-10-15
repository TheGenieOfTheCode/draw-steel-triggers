import { MODULE_ID } from "../util.mjs";
import { isMaliceAbility } from "./registry.mjs";

const FLAG = "abilityUse";

const actorUuidOf = (t) => (t?.actor ?? t?.document?.actor ?? (t?.documentName === "Actor" ? t : null))?.uuid ?? null;

const CORE_DURATION = {
  round: { value: 1, units: "rounds", expiry: "roundEnd" },
  turn: { value: null, units: "seconds", expiry: "turnEnd" },
  nextTurnStart: { value: 1, units: "rounds", expiry: "turnStart" },
  nextTurnEnd: { value: 1, units: "rounds", expiry: "turnEnd" },
  encounter: { value: null, units: "seconds", expiry: "combatEnd" },
};

const UNTIL_KEY = { encounter: "Encounter", round: "Round", turn: "Turn", nextTurnStart: "NextTurnStart", nextTurnEnd: "NextTurnEnd" };

const useEffects = (actor) => (actor?.effects ?? []).filter((e) => e.getFlag(MODULE_ID, FLAG));

export async function recordAbilityUse(actor, item, targets = [], used = { until: "encounter" }) {
  const combat = game.combat;
  if (!actor || !item?.id || !combat?.started) return;
  const uuids = [...new Set(targets.map(actorUuidOf).filter(Boolean))];
  const old = useEffects(actor).filter((e) => e.getFlag(MODULE_ID, FLAG)?.itemId === item.id).map((e) => e.id);
  if (old.length) await actor.deleteEmbeddedDocuments("ActiveEffect", old);
  const until = game.i18n.localize(`DS_TRIGGERS.AbilityUse.Until${UNTIL_KEY[used?.until] ?? "Encounter"}`);
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: item.name, img: item.img, transfer: false, disabled: false,
    description: `<p>${game.i18n.format(used?.dying ? "DS_TRIGGERS.AbilityUse.DescriptionDying" : "DS_TRIGGERS.AbilityUse.Description", { until })}</p>`,
    duration: { ...(CORE_DURATION[used?.until] ?? CORE_DURATION.encounter) },
    flags: { [MODULE_ID]: { [FLAG]: { itemId: item.id, dsid: item.system?._dsid ?? "", name: item.name, combat: combat.id,
      round: combat.round, turn: combat.turn, targets: uuids.length ? uuids : null, until: used?.until ?? "encounter", dying: !!used?.dying } } },
  }]);
}

function ownerTurnIndex(combat, actor) {
  return combat.turns.findIndex((c) => c.actor === actor || (c.actor && actor && c.actor.uuid === actor.uuid));
}

const before = (a, b) => a.round < b.round || (a.round === b.round && a.turn < b.turn);

const dying = (actor) => actor?.type === "hero" && Number(actor.system?.stamina?.value ?? 1) <= 0;

function recordLive(actor, rec, effect) {
  const combat = game.combat;
  if (!rec || effect?.disabled || effect?.duration?.expired || !combat?.started || rec.combat !== combat.id) return false;
  if (rec.dying && dying(actor)) return false;
  const now = { round: combat.round, turn: combat.turn };
  switch (rec.until) {
    case "round": return now.round === rec.round;
    case "turn": return now.round === rec.round && now.turn === rec.turn;
    case "nextTurnStart":
    case "nextTurnEnd": {
      const own = ownerTurnIndex(combat, actor);
      if (own < 0) return now.round === rec.round;
      const next = (rec.turn ?? 0) < own ? { round: rec.round, turn: own } : { round: rec.round + 1, turn: own };
      return rec.until === "nextTurnStart" ? before(now, next) : before(now, { round: next.round, turn: next.turn + 1 });
    }
    default: return true;
  }
}

const sameAbility = (rec, item) => (rec.dsid && item.system?._dsid ? rec.dsid === item.system._dsid : rec.name === item.name);

function liveUse(item) {
  const owners = isMaliceAbility(item) ? [...new Set((game.combat?.combatants ?? []).map((c) => c.actor).filter(Boolean))] : [item.actor];
  for (const actor of owners) {
    for (const effect of useEffects(actor)) {
      const rec = effect.getFlag(MODULE_ID, FLAG);
      const match = actor === item.actor ? rec.itemId === item.id : sameAbility(rec, item);
      if (match && recordLive(actor, rec, effect)) return rec;
    }
  }
  return null;
}

export const useLive = (item) => !!liveUse(item);

export const useTargets = (item) => liveUse(item)?.targets ?? null;

Hooks.on("deleteCombat", (combat) => {
  if (!game.users.activeGM?.isSelf) return;
  for (const c of combat.combatants) {
    const stale = useEffects(c.actor).filter((e) => e.getFlag(MODULE_ID, FLAG)?.combat === combat.id).map((e) => e.id);
    if (stale.length) c.actor.deleteEmbeddedDocuments("ActiveEffect", stale).catch(() => {});
  }
});
