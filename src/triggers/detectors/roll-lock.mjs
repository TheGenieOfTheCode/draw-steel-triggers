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

function _lockMatches(event, subjectActor, subjectToken, rollerActor, ability = null) {
  const dealer = { dealerActor: rollerActor, dealerToken: rollerActor?.getActiveTokens?.(false, true)?.[0] ?? null, ability };
  return collectTriggerMatches(event, subjectActor, subjectToken, null, dealer).filter((m) =>
    !m.malice
    && m.actor !== rollerActor
    && (m.parse?.confidence === "high" || m.parse?.source === "manual"));
}

Hooks.on("ds.canRenderAbilityConfigurationDialog", (app) => {
  if (!getSetting("rollLock")) return;
  if (app.rendered) return;
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
  const byUuid = new Map();

  const add = (list, event) => {
    for (const m of list) {
      if (seen.has(m.item.uuid)) {
        const prev = byUuid.get(m.item.uuid);
        if (prev && m._subjectTokenUuid && Array.isArray(prev._subjectTokenUuids)
          && !prev._subjectTokenUuids.includes(m._subjectTokenUuid)) {
          prev._subjectTokenUuids.push(m._subjectTokenUuid);
        }
        continue;
      }
      seen.add(m.item.uuid);
      byUuid.set(m.item.uuid, m);
      m._lockEvent = event;
      const targeting = event === "TARGETED_BY_STRIKE" || event === "TARGETED_BY_ABILITY";
      m._halvesOnUse = targeting && m.clause?.targetedHalf === true;
      m._redirect = targeting ? m.clause?.redirect ?? null : null;
      m._rollMod = event !== "WOULD_TAKE_DAMAGE" ? m.clause?.rollMod ?? null : null;
      m._subjectTokenUuids = m._subjectTokenUuid ? [m._subjectTokenUuid] : null;
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
  const targetPairs = targets.map((t) => ({ tokenDoc: t.tokenUuid ? fromUuidSync(t.tokenUuid) : null }));
  const targetActors = new Set(targetPairs.map((p) => p.tokenDoc?.actor).filter(Boolean));
  const notAlsoTargeted = (m) => !(m.clause?.excludeSelfTarget && targetActors.has(m.actor));
  for (const { tokenDoc } of targetPairs) {
    const subjectActor = tokenDoc?.actor;
    if (!subjectActor) continue;
    if (strike) {
      const list = _lockMatches("TARGETED_BY_STRIKE", subjectActor, tokenDoc, rollerActor, ability)
        .filter((m) => m.clause?.postRoll !== true)
        .filter(notAlsoTargeted);
      for (const m of list) m._subjectTokenUuid = tokenDoc.uuid;
      add(list, "TARGETED_BY_STRIKE");
    }
    const abilityList = _lockMatches("TARGETED_BY_ABILITY", subjectActor, tokenDoc, rollerActor, ability)
      .filter((m) => m.clause?.postRoll !== true)
      .filter(notAlsoTargeted);
    for (const m of abilityList) m._subjectTokenUuid = tokenDoc.uuid;
    add(abilityList, "TARGETED_BY_ABILITY");

    if (_hasDamage(ability) && !getSetting("damageInterrupts")) {
      add(_lockMatches("WOULD_TAKE_DAMAGE", subjectActor, tokenDoc, rollerActor).filter(notAlsoTargeted), "WOULD_TAKE_DAMAGE");
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
