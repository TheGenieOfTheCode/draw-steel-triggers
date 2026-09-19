import { MODULE_ID, primaryGM } from "../util.mjs";

export function isActorSnoozed(actor) {
  const owners = game.users.filter((u) => !u.isGM && actor.testUserPermission(u, "OWNER"));
  if (owners.length) return owners.every((u) => u.getFlag(MODULE_ID, "snooze") === true);
  return primaryGM()?.getFlag(MODULE_ID, "snooze") === true;
}

export async function toggleSnooze() {
  const next = !(game.user.getFlag(MODULE_ID, "snooze") ?? false);
  await game.user.setFlag(MODULE_ID, "snooze", next);
  ui.notifications.info(game.i18n.localize(next ? "DS_TRIGGERS.Snooze.On" : "DS_TRIGGERS.Snooze.Off"));
}

Hooks.on("getSceneControlButtons", (controls) => {
  const tokenControl = controls.tokens ?? controls.token;
  if (!tokenControl) return;

  const tool = {
    name: "dst-snooze",
    title: game.i18n.localize("DS_TRIGGERS.Snooze.Button"),
    icon: "fa-solid fa-bell-slash",
    toggle: true,
    active: (game.user.getFlag(MODULE_ID, "snooze") ?? false) === true,
    visible: true,
    onChange: () => toggleSnooze(),
  };

  if (Array.isArray(tokenControl.tools)) {
    tokenControl.tools.push(tool);
  } else {
    tool.order = Object.keys(tokenControl.tools).length;
    tokenControl.tools["dst-snooze"] = tool;
  }
});
