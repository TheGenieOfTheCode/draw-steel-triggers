import { dispatchTriggerEvent } from "../dispatch.mjs";

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
    dispatchTriggerEvent({
      event: "TURN_START",
      subjectActor: currCombatant.actor,
      subjectToken: currCombatant.token,
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.TurnStart", { name: currCombatant.name }),
    });
  }
});
