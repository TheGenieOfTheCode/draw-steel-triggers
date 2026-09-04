import { getSetting, dbg } from "../../util.mjs";
import { collectTriggerMatches } from "../dispatch.mjs";
import { enqueueLockEntries, consumeRollBypass, hasHeldEntry } from "../queue.mjs";

const STRIKE_EVENTS = new Set(["TARGETED_BY_STRIKE", "MAKES_STRIKE"]);

function _isStrike(ability) {
  return ability.system.keywords?.has?.("strike") ?? false;
}

function _hasDamage(ability) {
  const effects = ability.system.power?.effects?.contents ?? [];
  return effects.some((e) => e.type === "damage" || e.type === "dsct.flatDamage");
}

function _lockMatches(event, subjectActor, subjectToken, rollerActor) {
  return collectTriggerMatches(event, subjectActor, subjectToken).filter((m) =>
    !m.malice
    && m.actor !== rollerActor
    && (m.parse?.confidence === "high" || m.parse?.source === "manual"));
}

Hooks.on("ds.canRenderAbilityConfigurationDialog", (app) => {
  if (!getSetting("rollLock")) return;
  const ability = app.options?.ability;
  if (ability?.type !== "ability") return;
  if (consumeRollBypass(ability.uuid)) return;
  const rollerActor = ability.actor;
  if (!rollerActor) return;
  if (!game.combat?.started) return;
  
  if (hasHeldEntry(ability.uuid)) {
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.RollHeld", { name: ability.name }));
    return false;
  }

  const strike = _isStrike(ability);
  const hasRoll = !!ability.system.power?.roll?.enabled;
  const matches = [];
  const seen = new Set();
  
  const add = (list, event) => {
    for (const m of list) {
      if (seen.has(m.item.uuid)) continue;
      seen.add(m.item.uuid);
      m._lockEvent = event;
      m._causeLabel = game.i18n.format(`DS_TRIGGERS.Queue.Cause.${event}`, {
        roller: rollerActor.name, ability: ability.name, owner: m.actor.name,
      });
      matches.push(m);
    }
  };

  const rollerToken = rollerActor.getActiveTokens(true, true)[0] ?? null;
  if (hasRoll) add(_lockMatches("POWER_ROLL", rollerActor, rollerToken, rollerActor), "POWER_ROLL");
  if (strike) add(_lockMatches("MAKES_STRIKE", rollerActor, rollerToken, rollerActor), "MAKES_STRIKE");

  const targets = Object.values(app.options?.context?.targets ?? {});
  for (const target of targets) {
    const tokenDoc = target.tokenUuid ? fromUuidSync(target.tokenUuid) : null;
    const subjectActor = tokenDoc?.actor;
    if (!subjectActor) continue;
    if (strike) add(_lockMatches("TARGETED_BY_STRIKE", subjectActor, tokenDoc, rollerActor), "TARGETED_BY_STRIKE");
    
    
    if (_hasDamage(ability) && !getSetting("damageInterrupts")) {
      add(_lockMatches("WOULD_TAKE_DAMAGE", subjectActor, tokenDoc, rollerActor), "WOULD_TAKE_DAMAGE");
    }
  }

  if (!matches.length) return;

  const causeLabel = game.i18n.format("DS_TRIGGERS.Queue.LockCause", {
    roller: rollerActor.name, ability: ability.name,
  });
  dbg(`roll lock: ${ability.name} held by ${matches.length} triggers`);
  enqueueLockEntries(matches, {
    event: "ROLL_LOCK",
    causeLabel,
    resume: { userId: game.user.id, itemUuid: ability.uuid },
    held: {
      itemUuid: ability.uuid,
      itemName: ability.name,
      ownerActorUuid: rollerActor.uuid,
      ownerName: rollerActor.name,
    },
  });
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.RollHeld", { name: ability.name }));
  return false;
});
