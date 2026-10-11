import { dispatchTriggerEvent } from "../dispatch.mjs";

const _firstTurnTaken = new Set();

Hooks.on("combatTurnChange", (combat, previous, current) => {
  const prevCombatant = combat.combatants.get(previous?.combatantId);
  if (prevCombatant?.actor && !prevCombatant.isDefeated) {
    dispatchTriggerEvent({
      event: "TURN_END",
      subjectActor: prevCombatant.actor,
      subjectToken: prevCombatant.token,
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.TurnEnd", { name: prevCombatant.name }),
    });
  }
  if (previous && current.round !== previous.round) {
    dispatchTriggerEvent({
      event: "ROUND_START",
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.RoundStart", { round: current.round }),
    });
  }
  const currCombatant = combat.combatants.get(current?.combatantId);
  if (currCombatant?.actor && !currCombatant.isDefeated) {
    const firstTurn = current.round === 1 && !previous?.combatantId && !_firstTurnTaken.has(combat.id);
    _firstTurnTaken.add(combat.id);
    dispatchTriggerEvent({
      event: "TURN_START",
      subjectActor: currCombatant.actor,
      subjectToken: currCombatant.token,
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.TurnStart", { name: currCombatant.name }),
      eventContext: { firstTurn },
    });
  }
});
