import { getSetting, dbg, isPrimaryGM } from "../../util.mjs";
import { collectTriggerMatches, triggersLive, rollModsOf, rollNeeds } from "../dispatch.mjs";
import { enqueueResolutionHold, enqueuePromptEntries, getQueueMirror } from "../queue.mjs";
import { changesTheStrike } from "../../parser/trigger-parser.mjs";

const DSTD_ID = "draw-steel-target-damage";
const _handled = new Set();
const _handledAt = new Map();
const _knownTargets = new Map();

function _pruneHandled() {
  const now = Date.now();
  for (const [id, t] of _handledAt) {
    if (now - t > 60000) {
      _handledAt.delete(id);
      _handled.delete(id);
    }
  }
}

function _targetKey(t) {
  return String(t.tokenUuid ?? t.actorUuid ?? "");
}

export function noteTargetsChange(messageId, keys) {
  _knownTargets.set(messageId, { keys: new Set(keys), at: Date.now() });
}

function _seedKnownTargets(message) {
  const state = message.getFlag(DSTD_ID, "state");
  if (!state) return;
  _knownTargets.set(message.id, {
    keys: new Set((state.targets ?? []).map(_targetKey)),
    at: Date.now(),
  });
  const now = Date.now();
  for (const [id, rec] of _knownTargets) {
    if (now - rec.at > 600000) _knownTargets.delete(id);
  }
}

const _tierWatch = new Map();

function _tierFor(message, target) {
  const state = message.getFlag(DSTD_ID, "state") ?? {};
  const key = String(target?.tokenUuid ?? target?.actorUuid ?? "").replace(/\./g, "__");
  const override = state.tierOverrides?.[key];
  if (override?.tier != null) return Number(override.tier);
  const part = message.system?.parts?.contents?.find((p) => p.type === "abilityResult");
  const roll = (part?.rolls ?? []).find((r) => r?.constructor?.name === "PowerRoll");
  return roll?.product == null ? null : Number(roll.product);
}

function _anyApplied(message) {
  const state = message.getFlag(DSTD_ID, "state") ?? {};
  return Object.values(state.applications ?? {}).some((a) => a && a.status !== "undone");
}

function _tierMatchesClause(clause, tier) {
  const filter = clause?.tierFilter;
  if (!filter?.length) return false;
  return tier != null && filter.includes(Number(tier));
}

const _rollerClause = (clause) => clause?.targetScoped === true || clause?.rollerScoped === true;

function _tierCandidates(subjectActor, tokenDoc, rollerActor) {
  return collectTriggerMatches("POWER_ROLL_RESULT", subjectActor, tokenDoc)
    .filter((m) => !m.malice && m.actor !== rollerActor && !_rollerClause(m.clause)
      && (m.parse?.confidence === "high" || m.parse?.source === "manual")
      && (m.clause?.tierFilter?.length ?? 0) > 0);
}

function _rollerTierCandidates(rollerActor, rollerToken, ability, usedTargets = []) {
  const signature = (ability?.system?.category ?? "") === "signature";
  return collectTriggerMatches("POWER_ROLL_RESULT", rollerActor, rollerToken, null, { ability, usedTargets })
    .filter((m) => !m.malice
      && (m.parse?.confidence === "high" || m.parse?.source === "manual")
      && (m.clause?.tierFilter?.length ?? 0) > 0
      && _rollerClause(m.clause)
      && (!m.clause?.signatureOnly || signature)
      && (!m.clause?.abilityDsid || ability?.system?._dsid === m.clause.abilityDsid));
}

const _targetActors = (targets) => (targets ?? []).map((t) => {
  const doc = t.tokenUuid ? fromUuidSync(t.tokenUuid) : null;
  return doc?.actor ?? (t.actorUuid ? fromUuidSync(t.actorUuid) : null);
}).filter(Boolean);

function _rollerToken(message, rollerActor) {
  const doc = message.speaker?.scene && message.speaker?.token
    ? game.scenes.get(message.speaker.scene)?.tokens?.get(message.speaker.token)
    : null;
  
  return doc ?? rollerActor?.getActiveTokens?.(false, true)?.[0] ?? null;
}

function _rollerTier(message, targets) {
  return targets?.length === 1 ? _tierFor(message, targets[0]) : _tierFor(message, null);
}

function _addRollerMatches({ message, matches, seen, targets, rollerActor, ability, queued = null }) {
  const rollerToken = _rollerToken(message, rollerActor);
  const candidates = _rollerTierCandidates(rollerActor, rollerToken, ability, _targetActors(targets));
  if (!candidates.length) return false;
  const tier = _rollerTier(message, targets);
  for (const m of candidates) {
    if (!_tierMatchesClause(m.clause, tier)) continue;
    if (seen.has(m.item.uuid) || queued?.has(m.item.uuid)) continue;
    seen.add(m.item.uuid);
    m._subjectTargetKey = null;
    m._subjectTokenUuid = rollerToken?.uuid ?? null;
    m._subjectTokenUuids = rollerToken?.uuid ? [rollerToken.uuid] : null;
    m._subjectName = rollerToken?.name ?? rollerActor?.name ?? "";
    m._causeLabel = game.i18n.format("DS_TRIGGERS.Queue.ResolutionRollCause", {
      roller: m._subjectName, ability: ability.name, tier: tier ?? "?",
    });
    matches.push(m);
  }
  return true;
}

function _addRollModMatches({ message, matches, seen, rollerActor, ability, dealer }) {
  const rollerToken = dealer.dealerToken;
  const found = collectTriggerMatches("POWER_ROLL", rollerActor, rollerToken, null, { ...dealer, rollMods: rollModsOf(message) })
    .filter((m) => !m.malice && rollNeeds(m.clause) && (m.actor !== rollerActor || !!m.clause?.selfRoll)
      && (m.parse?.confidence === "high" || m.parse?.source === "manual"));
  for (const m of found) {
    if (seen.has(m.item.uuid)) continue;
    seen.add(m.item.uuid);
    m._subjectTargetKey = null;
    m._subjectTokenUuid = rollerToken?.uuid ?? null;
    m._subjectTokenUuids = rollerToken?.uuid ? [rollerToken.uuid] : null;
    m._subjectName = rollerToken?.name ?? rollerActor?.name ?? "";
    m._causeLabel = game.i18n.format("DS_TRIGGERS.Queue.Cause.POWER_ROLL", { roller: m._subjectName, ability: ability.name });
    matches.push(m);
  }
}

function _pruneTierWatch() {
  const now = Date.now();
  for (const [id, w] of _tierWatch) if (now - w.at > 300000) _tierWatch.delete(id);
}

function _dispatchResolution(message, matches, ability, rollerActor) {
  
  const bare = game.i18n.format("DS_TRIGGERS.Queue.ResolutionCardCause", {
    roller: rollerActor?.name ?? "", ability: ability.name,
  });
  const stillModifiable = game.i18n.localize("DS_TRIGGERS.Queue.StillModifiable");
  const holdAll = getSetting("holdInertTriggers");
  const held = holdAll ? matches : matches.filter((m) => changesTheStrike(m.clause));
  const offered = holdAll ? [] : matches.filter((m) => !changesTheStrike(m.clause));

  if (offered.length) {
    dbg(`resolution: ${offered.length} trigger(s) offered after ${ability.name} instead of holding it`);
    enqueuePromptEntries(offered, { event: "POWER_ROLL_RESULT", causeLabel: bare, sourceMessageId: message.id });
  }
  if (!held.length) return;
  
  for (const m of held) if (m._causeLabel) m._causeLabel = `${m._causeLabel} ${stillModifiable}`;
  enqueueResolutionHold(held, {
    causeLabel: `${bare} ${stillModifiable}`,
    resolution: {
      messageId: message.id,
      abilityUuid: ability.uuid,
      abilityName: ability.name,
      rollerName: rollerActor?.name ?? "",
      rollerActorUuid: rollerActor?.uuid ?? null,
      authorUserId: message.author?.id ?? null,
    },
  });
}

async function _tryDispatch(message) {
  if (!isPrimaryGM()) return;
  if (!getSetting("resolutionHolds")) return;
  if (!triggersLive()) return;
  if (_handled.has(message.id)) return;
  if (Date.now() - (message.timestamp ?? 0) > 30000) return;

  const abilityUse = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  if (!abilityUse?.abilityUuid) return;
  const state = message.getFlag(DSTD_ID, "state");
  const targets = state?.targets ?? [];
  if (!targets.length) return;
  if (!message.rolls?.length) return;

  const ability = await fromUuid(abilityUse.abilityUuid).catch(() => null);
  if (!ability || ability.type !== "ability") return;
  const strike = ability.system.keywords?.has?.("strike") ?? false;
  const rollerActor = ability.actor;
  const dealer = { dealerActor: rollerActor, dealerToken: _rollerToken(message, rollerActor), ability };

  _handled.add(message.id);
  _handledAt.set(message.id, Date.now());
  _pruneHandled();

  const targetPairs = [];
  for (const t of targets) {
    const tokenDoc = t.tokenUuid ? await fromUuid(t.tokenUuid).catch(() => null) : null;
    const subjectActor = tokenDoc?.actor
      ?? (t.actorUuid ? await fromUuid(t.actorUuid).catch(() => null) : null);
    targetPairs.push({ t, tokenDoc, subjectActor });
  }
  const targetActors = new Set(targetPairs.map((p) => p.subjectActor).filter(Boolean));

  const matches = [];
  const seen = new Set();
  let watching = false;
  for (const { t, tokenDoc, subjectActor } of targetPairs) {
    if (!subjectActor) continue;
    const events = strike ? ["TARGETED_BY_STRIKE", "TARGETED_BY_ABILITY"] : ["TARGETED_BY_ABILITY"];
    const tier = _tierFor(message, t);
    const candidates = _tierCandidates(subjectActor, tokenDoc, rollerActor);
    if (candidates.length) watching = true;
    const list = events.flatMap((event) => collectTriggerMatches(event, subjectActor, tokenDoc, null, dealer))
      .filter((m) => !m.malice && m.clause?.postRoll === true && m.actor !== rollerActor
        && (m.parse?.confidence === "high" || m.parse?.source === "manual")
        && !(m.clause?.excludeSelfTarget && targetActors.has(m.actor)))
      .concat(candidates.filter((m) => _tierMatchesClause(m.clause, tier)));
    for (const m of list) {
      if (seen.has(m.item.uuid)) continue;
      seen.add(m.item.uuid);
      m._subjectTargetKey = String(t.tokenUuid ?? t.actorUuid ?? "").replace(/\./g, "__");
      m._subjectTokenUuid = tokenDoc?.uuid ?? null;
      m._subjectTokenUuids = tokenDoc?.uuid ? [tokenDoc.uuid] : null;
      m._subjectName = tokenDoc?.name ?? subjectActor.name;
      m._causeLabel = game.i18n.format("DS_TRIGGERS.Queue.ResolutionCause", {
        roller: rollerActor?.name ?? "", ability: ability.name, owner: m._subjectName,
      });
      matches.push(m);
    }
  }
  _addRollModMatches({ message, matches, seen, rollerActor, ability, dealer });
  if (_addRollerMatches({ message, matches, seen, targets, rollerActor, ability })) watching = true;

  if (watching && !_anyApplied(message)) { _tierWatch.set(message.id, { at: Date.now() }); _pruneTierWatch(); }

  if (!matches.length) return;

  dbg(`resolution: ${ability.name} matched by ${matches.length} post-roll triggers`);
  _dispatchResolution(message, matches, ability, rollerActor);
}

async function _tryTierRecheck(message) {
  if (!isPrimaryGM()) return;
  if (!getSetting("resolutionHolds")) return;
  if (!_tierWatch.has(message.id)) return;
  if (_anyApplied(message)) { _tierWatch.delete(message.id); return; }
  if (!triggersLive()) return;

  const abilityUse = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  if (!abilityUse?.abilityUuid) return;
  const ability = await fromUuid(abilityUse.abilityUuid).catch(() => null);
  if (!ability || ability.type !== "ability") return;
  const rollerActor = ability.actor;
  const dealer = { dealerActor: rollerActor, dealerToken: _rollerToken(message, rollerActor), ability };
  const targets = message.getFlag(DSTD_ID, "state")?.targets ?? [];

  const queued = new Set((getQueueMirror() ?? [])
    .filter((e) => e.state === "pending" || e.state === "used").map((e) => e.itemUuid));

  const matches = [];
  const seen = new Set();
  for (const t of targets) {
    const tokenDoc = t.tokenUuid ? await fromUuid(t.tokenUuid).catch(() => null) : null;
    const subjectActor = tokenDoc?.actor ?? (t.actorUuid ? await fromUuid(t.actorUuid).catch(() => null) : null);
    if (!subjectActor) continue;
    const tier = _tierFor(message, t);
    for (const m of _tierCandidates(subjectActor, tokenDoc, rollerActor)) {
      if (!_tierMatchesClause(m.clause, tier)) continue;
      if (seen.has(m.item.uuid) || queued.has(m.item.uuid)) continue;
      seen.add(m.item.uuid);
      m._subjectTargetKey = String(t.tokenUuid ?? t.actorUuid ?? "").replace(/\./g, "__");
      m._subjectTokenUuid = tokenDoc?.uuid ?? null;
      m._subjectTokenUuids = tokenDoc?.uuid ? [tokenDoc.uuid] : null;
      m._subjectName = tokenDoc?.name ?? subjectActor.name;
      m._causeLabel = game.i18n.format("DS_TRIGGERS.Queue.ResolutionCause", {
        roller: rollerActor?.name ?? "", ability: ability.name, owner: m._subjectName,
      });
      matches.push(m);
    }
  }
  _addRollerMatches({ message, matches, seen, targets, rollerActor, ability, queued });

  if (!matches.length) return;

  dbg(`tier recheck: ${ability.name} now matches ${matches.length} trigger(s)`);
  _dispatchResolution(message, matches, ability, rollerActor);
}

async function _tryPostHocDispatch(message, addedTargets) {
  if (!isPrimaryGM()) return;
  if (!getSetting("resolutionHolds")) return;
  if (!triggersLive()) return;

  const abilityUse = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  if (!abilityUse?.abilityUuid) return;
  if (!message.rolls?.length) return;
  const ability = await fromUuid(abilityUse.abilityUuid).catch(() => null);
  if (!ability || ability.type !== "ability") return;
  const strike = ability.system.keywords?.has?.("strike") ?? false;
  const rollerActor = ability.actor;
  const dealer = { dealerActor: rollerActor, dealerToken: _rollerToken(message, rollerActor), ability };

  const allTargets = message.getFlag(DSTD_ID, "state")?.targets ?? [];
  const targetActors = new Set();
  for (const t of allTargets) {
    const doc = t.tokenUuid ? await fromUuid(t.tokenUuid).catch(() => null) : null;
    const actor = doc?.actor ?? (t.actorUuid ? await fromUuid(t.actorUuid).catch(() => null) : null);
    if (actor) targetActors.add(actor);
  }

  const pendingUuids = new Set((getQueueMirror() ?? [])
    .filter((e) => e.state === "pending").map((e) => e.itemUuid));

  const matches = [];
  const seen = new Set();
  for (const t of addedTargets) {
    const tokenDoc = t.tokenUuid ? await fromUuid(t.tokenUuid).catch(() => null) : null;
    const subjectActor = tokenDoc?.actor
      ?? (t.actorUuid ? await fromUuid(t.actorUuid).catch(() => null) : null);
    if (!subjectActor) continue;
    const events = strike ? ["TARGETED_BY_STRIKE", "TARGETED_BY_ABILITY"] : ["TARGETED_BY_ABILITY"];
    const list = events.flatMap((event) => collectTriggerMatches(event, subjectActor, tokenDoc, null, dealer))
      .filter((m) => !m.malice && m.actor !== rollerActor
        && (m.parse?.confidence === "high" || m.parse?.source === "manual")
        && !(m.clause?.excludeSelfTarget && targetActors.has(m.actor)));
    for (const m of list) {
      if (seen.has(m.item.uuid) || pendingUuids.has(m.item.uuid)) continue;
      seen.add(m.item.uuid);
      m._postHoc = true;
      m._subjectTargetKey = _targetKey(t).replace(/\./g, "__");
      m._subjectTokenUuid = tokenDoc?.uuid ?? null;
      m._subjectTokenUuids = tokenDoc?.uuid ? [tokenDoc.uuid] : null;
      m._subjectName = tokenDoc?.name ?? subjectActor.name;
      m._causeLabel = game.i18n.format("DS_TRIGGERS.Queue.PostHocCause", {
        roller: rollerActor?.name ?? "", ability: ability.name, owner: m._subjectName,
      });
      matches.push(m);
    }
  }
  if (!matches.length) return;

  dbg(`post-hoc resolution: ${ability.name} matched by ${matches.length} triggers for late targets`);
  _dispatchResolution(message, matches, ability, rollerActor);
}

Hooks.on("createChatMessage", async (message) => {
  if (!isPrimaryGM()) return;
  await _tryDispatch(message);
  _seedKnownTargets(message);
});

Hooks.on("updateChatMessage", async (message, changes) => {
  if (!isPrimaryGM()) return;
  if (!foundry.utils.hasProperty(changes, `flags.${DSTD_ID}`)) return;
  const known = _knownTargets.get(message.id);
  if (!known) {
    
    
    
    
    await _tryDispatch(message);
    _seedKnownTargets(message);
    await _tryTierRecheck(message);
    return;
  }
  const targets = message.getFlag(DSTD_ID, "state")?.targets ?? [];
  const added = targets.filter((t) => !known.keys.has(_targetKey(t)));
  known.keys = new Set(targets.map(_targetKey));
  known.at = Date.now();
  if (added.length) _tryPostHocDispatch(message, added);
  
  await _tryTierRecheck(message);
});

Hooks.on("deleteChatMessage", (message) => {
  _tierWatch.delete(message.id);
  _knownTargets.delete(message.id);
  _handled.delete(message.id);
  _handledAt.delete(message.id);
});
