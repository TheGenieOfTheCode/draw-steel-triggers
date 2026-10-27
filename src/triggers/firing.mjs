import { getSetting } from "../util.mjs";
import { changesTheStrike } from "../parser/trigger-parser.mjs";

export const EVENT_MODES = {
  TURN_START: "reminder",
  TURN_END: "reminder",
  ROUND_START: "reminder",
  REGAINS_STAMINA: "reminder",
  LOSES_STAMINA: "reminder",
  SAVING_THROW: "reminder",
  GAINS_TEMP_STAMINA: "reminder",
  GAINS_SURGE: "reminder",
  TELEPORTS: "reminder",
  SIZE_CHANGES: "reminder",
  FORM_CHANGES: "reminder",
  MALICE_SPENT: "reminder",
  TAKES_DAMAGE: "prompt",
  USES_ABILITY: "prompt",
  DEALS_DAMAGE: "prompt",
  FORCE_MOVED: "forced",
  FORCE_MOVES: "forced",
  DIES: "prompt",
  WINDED_OR_DYING: "prompt",
  WINDED: "prompt",
  DYING: "prompt",
  FALL_START: "hold",
  SPENDS_RECOVERY: "reminder",
  HERO_TOKEN_EARNED: "reminder",
  RESISTS_POTENCY: "reminder",
  STAMINA_BELOW: "prompt",
  CONDITION_GAIN: "prompt",
  EFFECT_ENDS: "prompt",
  GRAB_ENDS: "prompt",
  WOULD_TAKE_DAMAGE: "hold",
  TARGETED_BY_STRIKE: "lock",
  TARGETED_BY_ABILITY: "lock",
  MAKES_STRIKE: "lock",
  POWER_ROLL: "lock",
};
export const BASE_SCOPES = new Set(["SELF", "ALLY", "ENEMY", "ANY", "GROUP", "SELF_OR_ALLY", "MENTOR"]);
const RESOLUTION_EVENTS = new Set(["TARGETED_BY_STRIKE", "TARGETED_BY_ABILITY"]);

export function clauseMode(clause) {
  if (clause.turnLock) return "turn";
  if (clause.postRoll && (RESOLUTION_EVENTS.has(clause.event) || (clause.event === "POWER_ROLL_RESULT" && ((clause.tierFilter?.length ?? 0) > 0 || !!clause.critical)))) {
    return changesTheStrike(clause) || getSetting("holdInertTriggers") ? "resolution" : "prompt";
  }
  if (clause.event === "MOVES") return clause.arrives || clause.through || clause.entersSpace ? "reminder" : undefined;
  return EVENT_MODES[clause.event];
}

export const scopeResolves = (clause, malice = false) => BASE_SCOPES.has(clause.scope) || malice || !!clause.asSource;

export const clauseFires = (clause, malice = false) => !!clauseMode(clause) && scopeResolves(clause, malice);

export function triggerCanFire(parse, { malice = false, featureLine = false } = {}) {
  if (!parse) return false;
  if (featureLine && parse.confidence !== "high" && parse.source !== "manual") return false;
  return (parse.clauses ?? []).some((c) => clauseFires(c, malice));
}

export const partSnoozeId = (dsid, clause) => `${dsid}#${clause.event}:${clause.scope}`;
