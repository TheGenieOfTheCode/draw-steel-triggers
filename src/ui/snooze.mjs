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
    { value: "turnStart", label: L("UntilTurnStart") },
    { value: "turnEnd", label: L("UntilTurnEnd") },
    { value: "roundEnd", label: L("UntilRoundEnd") },
    { value: "combatEnd", label: L("UntilCombatEnd") },
    { value: "min10", label: L("For10Minutes") },
    { value: "min30", label: L("For30Minutes") },
    { value: "manual", label: L("UntilUnsnoozed") },
  ];

  
  const content = `<div class="dst-snooze-picker"><p>`
    + game.i18n.format("DS_TRIGGERS.Snooze.PickFor", { name: abilityName })
    + `</p>`
    + options.map((o) => `<button type="button" data-choice="${o.value}">${o.label}</button>`).join("")
    + `</div>`;

  return new Promise((resolve) => {
    let settled = false;
    const dialog = new foundry.applications.api.DialogV2({
      window: { title: L("PickTitle") },
      classes: ["draw-steel", "dst-snooze-dialog"],
      content,
      buttons: [{ action: "cancel", label: L("Cancel"), default: true }],
      submit: () => { if (!settled) resolve(null); },
    });

    dialog.render({ force: true }).then((app) => {
      
      const onClose = (closed) => {
        if (closed !== app) return;
        Hooks.off("closeDialogV2", onClose);
        if (!settled) resolve(null);
      };
      Hooks.on("closeDialogV2", onClose);

      app.element.addEventListener("click", (ev) => {
        const button = ev.target.closest("[data-choice]");
        if (!button) return;
        settled = true;
        const choice = button.dataset.choice;
        const label = options.find((o) => o.value === choice)?.label ?? "";
        if (choice === "manual") resolve({ label });
        else if (choice === "min10") resolve({ until: Date.now() + 600000, label });
        else if (choice === "min30") resolve({ until: Date.now() + 1800000, label });
        else resolve({ event: choice, label });
        app.close();
      });
    });
  });
}
