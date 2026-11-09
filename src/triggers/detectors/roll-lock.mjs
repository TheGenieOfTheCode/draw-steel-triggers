import { getSetting, dbg } from "../../util.mjs";
import { collectTriggerMatches, triggersLive } from "../dispatch.mjs";
import { enqueueLockEntries, consumeRollBypass, hasHeldEntry, withdrawRollMods, asPrimaryGM } from "../queue.mjs";

const STRIKE_EVENTS = new Set(["TARGETED_BY_STRIKE", "MAKES_STRIKE"]);

function _isStrike(ability) {
  return ability.system.keywords?.has?.("strike") ?? false;
}

function _hasDamage(ability) {
  const effects = ability.system.power?.effects?.contents ?? [];
  return effects.some((e) => e.type === "damage" || e.type === "dsct.flatDamage");
}

function _lockMatches(event, subjectActor, subjectToken, rollerActor, ability = null, usedTargets = []) {
  const dealer = { dealerActor: rollerActor, dealerToken: rollerActor?.getActiveTokens?.(false, true)?.[0] ?? null, ability, usedTargets };
  return collectTriggerMatches(event, subjectActor, subjectToken, null, dealer).filter((m) =>
    !m.malice
    && (m.actor !== rollerActor || !!m.clause?.selfRoll || m.clause?.dealerScope === "SELF_OR_ALLY")
    && (m.parse?.confidence === "high" || m.parse?.source === "manual"));
}

Hooks.once("setup", () => Hooks.on("ds.canRenderAbilityConfigurationDialog", (app) => {
  if (!getSetting("rollLock")) return;
  if (app.rendered) return;
  const ability = app.options?.ability;
  if (ability?.type !== "ability") return;
  if (consumeRollBypass(ability.uuid)) return;
  const rollerActor = ability.actor;
  if (!rollerActor) return;
  if (!triggersLive()) return;
  
  if (hasHeldEntry(ability.uuid)) {
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.RollHeld", { name: ability.name }));
    return false;
  }

  const matches = _collectLockMatches(app, ability, rollerActor);
  _noteLockMode(ability, matches);
  if (!matches.length) return;
  _holdRoll(ability, rollerActor, matches);
  return false;
}));

function _collectLockMatches(app, ability, rollerActor) {
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
      m._lockKey = `${m.item.uuid}|${event}`;
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

  const targets = Object.values(app.options?.context?.targets ?? {});
  const targetPairs = targets.map((t) => ({ tokenDoc: t.tokenUuid ? fromUuidSync(t.tokenUuid) : null }));
  const targetDocs = targetPairs.map((p) => p.tokenDoc).filter(Boolean);

  const rollerToken = rollerActor.getActiveTokens(true, true)[0] ?? null;
  if (hasRoll) add(_lockMatches("POWER_ROLL", rollerActor, rollerToken, rollerActor, ability, targetDocs).filter((m) => m.clause?.postRoll !== true), "POWER_ROLL");
  if (strike) add(_lockMatches("MAKES_STRIKE", rollerActor, rollerToken, rollerActor, ability, targetDocs).filter((m) => m.clause?.postRoll !== true), "MAKES_STRIKE");
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
  return matches;
}

function _holdRoll(ability, rollerActor, matches) {
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
}

const _modeOf = (ability) => (ability?.system?.distance?.type === "meleeRanged" ? ability.system.damageDisplay ?? "melee" : null);


const _lockModes = new Map();

function _noteLockMode(ability, matches) {
  const mode = _modeOf(ability);
  if (!mode) return _lockModes.delete(ability.uuid);
  _lockModes.set(ability.uuid, {
    mode,
    keys: new Map(matches.map((m) => [m._lockKey, { itemName: m.item.name, ownerActorUuid: m.actor.uuid }])),
  });
}

Hooks.on("renderAbilityConfigurationDialog", (app) => setTimeout(() => _recheckMode(app), 0));

function _recheckMode(app) {
  const ability = app.options?.ability;
  const state = ability ? _lockModes.get(ability.uuid) : null;
  const mode = _modeOf(ability);
  if (!app.rendered || !state || !mode || state.mode === mode) return;
  if (!getSetting("rollLock") || !triggersLive() || !ability.actor) return;
  const matches = _collectLockMatches(app, ability, ability.actor);
  const keys = new Map(matches.map((m) => [m._lockKey, { itemName: m.item.name, ownerActorUuid: m.actor.uuid }]));
  const gone = [...state.keys].filter(([k]) => !keys.has(k));
  const fresh = matches.filter((m) => !state.keys.has(m._lockKey));
  const from = state.mode;
  state.mode = mode;
  state.keys = keys;
  if (gone.length) {
    withdrawRollMods(app, gone.map(([, g]) => g));
    asPrimaryGM("lockModeRefund", { itemUuid: ability.uuid, keys: gone.map(([k]) => k), from, to: mode, userId: game.user.id });
  }
  if (fresh.length) {
    _holdRoll(ability, ability.actor, fresh);
    app.close();
  }
}
