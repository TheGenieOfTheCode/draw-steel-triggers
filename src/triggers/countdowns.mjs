import { MODULE_ID, isPrimaryGM } from "../util.mjs";

const FLAG = "countdowns";

export const COUNTDOWN_RESOURCES = {
  victories: { path: "system.hero.victories", label: "DS_TRIGGERS.Countdown.Resource.victories" },
  heroic: { path: "system.hero.primary.value", label: "DS_TRIGGERS.Countdown.Resource.heroic" },
  epic: { path: "system.hero.epic.value", label: "DS_TRIGGERS.Countdown.Resource.epic" },
  surges: { path: "system.hero.surges", label: "DS_TRIGGERS.Countdown.Resource.surges" },
  renown: { path: "system.hero.renown", label: "DS_TRIGGERS.Countdown.Resource.renown" },
  wealth: { path: "system.hero.wealth", label: "DS_TRIGGERS.Countdown.Resource.wealth" },
  xp: { path: "system.hero.xp", label: "DS_TRIGGERS.Countdown.Resource.xp" },
};

const flagKey = (key) => String(key).replace(/\./g, "_");

export function countdownLeft(actor, key) {
  const n = Number(actor?.getFlag?.(MODULE_ID, FLAG)?.[flagKey(key)]?.left);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function startCountdown(actor, key, countdown) {
  const start = Math.max(0, Math.floor(Number(countdown?.start) || 0));
  if (!actor || !start || !COUNTDOWN_RESOURCES[countdown.resource]) return;
  await actor.update({ [`flags.${MODULE_ID}.${FLAG}.${flagKey(key)}`]: {
    left: start, start, resource: countdown.resource, by: countdown.by === "amount" ? "amount" : "fixed", step: Math.max(1, Math.floor(Number(countdown.step) || 1)),
  } });
}

export async function clearCountdown(actor, key) {
  if (!actor?.getFlag?.(MODULE_ID, FLAG)?.[flagKey(key)]) return;
  await actor.update({ [`flags.${MODULE_ID}.${FLAG}.-=${flagKey(key)}`]: null });
}

Hooks.on("preUpdateActor", (actor, changes, options) => {
  const running = actor.getFlag(MODULE_ID, FLAG);
  if (!running) return;
  const prev = {};
  for (const { path } of Object.values(COUNTDOWN_RESOURCES)) {
    if (foundry.utils.hasProperty(changes, path)) prev[path] = Number(foundry.utils.getProperty(actor, path)) || 0;
  }
  if (Object.keys(prev).length) options.dstCountdownPrev = prev;
});

Hooks.on("updateActor", (actor, changes, options) => {
  if (!isPrimaryGM() || !options?.dstCountdownPrev) return;
  const running = actor.getFlag(MODULE_ID, FLAG) ?? {};
  const update = {};
  for (const [key, c] of Object.entries(running)) {
    if (!(c?.left > 0)) continue;
    const path = COUNTDOWN_RESOURCES[c.resource]?.path;
    if (!path || !(path in options.dstCountdownPrev)) continue;
    const gained = (Number(foundry.utils.getProperty(actor, path)) || 0) - options.dstCountdownPrev[path];
    if (!(gained > 0)) continue;
    const left = Math.max(0, c.left - (c.by === "amount" ? gained : c.step ?? 1));
    update[`flags.${MODULE_ID}.${FLAG}.${key}.left`] = left;
  }
  if (Object.keys(update).length) actor.update(update).catch((err) => console.warn(`${MODULE_ID} | could not count down on ${actor.name}`, err));
});

function _countdownLabel(actor, key) {
  const c = actor?.getFlag?.(MODULE_ID, FLAG)?.[flagKey(key)];
  if (!(c?.left > 0)) return game.i18n.localize("DS_TRIGGERS.Countdown.Ready");
  const resource = game.i18n.localize(COUNTDOWN_RESOURCES[c.resource]?.label ?? c.resource);
  return game.i18n.format("DS_TRIGGERS.Countdown.Left", { n: c.left, resource });
}

Hooks.once("init", () => {
  CONFIG.TextEditor.enrichers.push({
    pattern: /@TriggerCountdown\[([^\]]+)\]/g,
    enricher: async (match, options) => {
      const doc = options?.relativeTo ?? null;
      const actor = doc?.actor ?? doc?.parent?.actor ?? (doc?.documentName === "Actor" ? doc : null);
      const span = document.createElement("span");
      span.className = "dst-countdown";
      const left = actor ? countdownLeft(actor, match[1]) : 0;
      span.classList.toggle("is-ready", !left);
      span.innerHTML = `<i class="fa-solid fa-hourglass-half" inert></i> `;
      span.append(actor ? _countdownLabel(actor, match[1]) : game.i18n.localize("DS_TRIGGERS.Countdown.Unknown"));
      return span;
    },
  });
});
