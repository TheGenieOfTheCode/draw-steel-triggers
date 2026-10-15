import { MODULE_ID, primaryGM } from "../util.mjs";

const FLAG = "snoozes";
const ANY = "*";

export const EXPIRY_EVENTS = ["combatEnd", "roundEnd", "turnStart", "turnEnd"];

const _safe = (part) => String(part).split('.').join('_');

const _key = (actorUuid, dsid) => `${actorUuid ? _safe(actorUuid) : ANY}|${dsid ?? ANY}`;

const _drop = (user, keys) => user.update({
  [`flags.${MODULE_ID}.${FLAG}`]: Object.fromEntries(
    keys.map((k) => [k, new foundry.data.operators.ForcedDeletion()]),
  ),
});

const _stored = (user) => user?.getFlag(MODULE_ID, FLAG) ?? {};

function _expired(entry) {
  if (!entry) return true;
  if (entry.until && Date.now() >= entry.until) return true;

  if (entry.event === "combatEnd") {
    if (!entry.combatId) return !game.combat;
    return !game.combats.get(entry.combatId)?.started;
  }
  if (entry.event === "roundEnd") {
    const combat = entry.combatId ? game.combats.get(entry.combatId) : null;
    if (!combat?.started) return true;
    return (combat.round ?? 0) > (entry.round ?? 0);
  }
  return false;
}

export function snoozeAudience(actor) {
  const owners = game.users.filter((u) => !u.isGM && actor?.testUserPermission(u, "OWNER"));
  return owners.length ? owners : [primaryGM()].filter(Boolean);
}

function _matchFor(user, actorUuid, dsid) {
  const stored = _stored(user);
  for (const key of [_key(actorUuid, dsid), _key(ANY, dsid), _key(actorUuid, ANY), _key(ANY, ANY)]) {
    const entry = stored[key];
    if (entry && !_expired(entry)) return { key, ...entry };
  }
  return null;
}

export function snoozeFor(actor, dsid) {
  const users = snoozeAudience(actor);
  if (!users.length) return null;
  let first = null;
  for (const user of users) {
    const hit = _matchFor(user, actor?.uuid, dsid);
    if (!hit) return null;
    first ??= hit;
  }
  return first;
}

export const isTriggerSnoozed = (actor, dsid) => !!snoozeFor(actor, dsid);

export const isSnoozedForAudience = (actor, dsid) => !!snoozeFor(actor, dsid);

export const isActorSnoozed = (actor) => !!snoozeFor(actor, null);

export function actorSnoozeFor(actor) {
  if (!actor?.uuid) return null;
  const key = _key(actor.uuid, ANY);
  for (const user of snoozeAudience(actor)) {
    const entry = _stored(user)[key];
    if (entry && !_expired(entry)) return { key, ...entry };
  }
  return null;
}

export async function setSnooze(actor, { actorUuid = null, dsid = null, until = null, event = null, label = "", ownerUuid = null } = {}) {
  const key = _key(actorUuid, dsid);
  const entry = {
    until: until ?? null,
    event: event ?? null,
    label,
    combatId: game.combat?.id ?? null,
    round: game.combat?.round ?? null,
    ownerUuid: ownerUuid ?? actorUuid ?? actor?.uuid ?? null,
    at: Date.now(),
  };

  for (const user of snoozeAudience(actor)) {
    await user.setFlag(MODULE_ID, FLAG, { ...(_stored(user)), [key]: entry })
      .catch((err) => console.warn(`${MODULE_ID} | could not snooze for ${user.name}`, err));
  }
  return key;
}

export async function clearSnooze(actor, key) {
  for (const user of snoozeAudience(actor)) {
    if (!(key in _stored(user))) continue;
    await _drop(user, [key])
      .catch((err) => console.warn(`${MODULE_ID} | could not clear a snooze for ${user.name}`, err));
  }
}

export function listSnoozes(user = game.user) {
  return Object.entries(_stored(user))
    .filter(([, entry]) => !_expired(entry))
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

export async function toggleSnooze() {
  const key = _key(ANY, ANY);
  if (_matchFor(game.user, null, null)?.key === key) {
    await _drop(game.user, [key]);
    ui.notifications.info(game.i18n.localize("DS_TRIGGERS.Snooze.Off"));
    return false;
  }
  await game.user.setFlag(MODULE_ID, FLAG, {
    ...(_stored(game.user)),
    [key]: { until: null, event: null, label: game.i18n.localize("DS_TRIGGERS.Snooze.Everything"), at: Date.now() },
  });
  ui.notifications.info(game.i18n.localize("DS_TRIGGERS.Snooze.On"));
  return true;
}

async function _clearTurnEvents(which, actorUuid) {
  if (!actorUuid) return;
  for (const user of game.users) {
    const drop = Object.entries(_stored(user))
      .filter(([, e]) => e.event === which && e.ownerUuid === actorUuid)
      .map(([key]) => key);
    if (!drop.length) continue;
    await _drop(user, drop).catch(() => {});
  }
}

export function registerSnoozeHooks() {
  Hooks.on("combatTurnChange", (_combat, prior, current) => {
    if (!game.user.isGM) return;
    const uuidOf = (side) => (side?.tokenId ? canvas.tokens?.get(side.tokenId)?.actor?.uuid : null) ?? null;
    _clearTurnEvents("turnEnd", uuidOf(prior)).catch(() => {});
    _clearTurnEvents("turnStart", uuidOf(current)).catch(() => {});
  });

  
  Hooks.on("deleteCombat", () => {
    if (!game.user.isGM) return;
    for (const user of game.users) {
      const drop = Object.entries(_stored(user)).filter(([, e]) => _expired(e)).map(([key]) => key);
      if (!drop.length) continue;
      _drop(user, drop).catch(() => {});
    }
  });
}

export async function promptSnooze(abilityName) {
  const L = (k) => game.i18n.localize(`DS_TRIGGERS.Snooze.${k}`);
  const options = [
    { action: "turnStart", label: L("UntilTurnStart"), icon: "fa-solid fa-hourglass-start" },
    { action: "turnEnd", label: L("UntilTurnEnd"), icon: "fa-solid fa-hourglass-end" },
    { action: "roundEnd", label: L("UntilRoundEnd"), icon: "fa-solid fa-rotate" },
    { action: "combatEnd", label: L("UntilCombatEnd"), icon: "fa-solid fa-flag-checkered" },
    { action: "min10", label: L("For10Minutes"), icon: "fa-solid fa-clock" },
    { action: "min30", label: L("For30Minutes"), icon: "fa-solid fa-clock" },
    { action: "manual", label: L("UntilUnsnoozed"), icon: "fa-solid fa-bell-slash" },
  ];

  const choice = await game.modules.get("draw-steel-ctlib").api.stackedPrompt({
    title: L("PickTitle"),
    heading: game.i18n.format("DS_TRIGGERS.Snooze.PickFor", { name: foundry.utils.escapeHTML(abilityName) }),
    options,
  });
  if (!choice) return null;
  const label = options.find((o) => o.action === choice)?.label ?? "";
  if (choice === "manual") return { label };
  if (choice === "min10") return { until: Date.now() + 600000, label };
  if (choice === "min30") return { until: Date.now() + 1800000, label };
  return { event: choice, label };
}
