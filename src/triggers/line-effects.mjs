import { MODULE_ID, dbg } from "../util.mjs";

const VICTIM_MARKS = {
  insubstantial: { key: "Insubstantial", img: "icons/creatures/magical/spirit-undead-ghost-blue.webp", expiry: "turnEnd" },
};

export async function markVictim(owner, victim, label, sourceName) {
  const mark = VICTIM_MARKS[label];
  if (!mark || !owner || !victim || victim === owner) return;
  const existing = victim.effects.find((e) => {
    const flag = e.getFlag(MODULE_ID, "victimMark");
    return flag?.label === label && flag.ownerUuid === owner.uuid;
  });
  if (existing) await existing.delete().catch(() => {});
  await victim.createEmbeddedDocuments("ActiveEffect", [{
    name: game.i18n.format(`DS_TRIGGERS.LineEffect.${mark.key}`, { owner: owner.name }),
    img: mark.img,
    origin: owner.uuid,
    description: `<p>${foundry.utils.escapeHTML(game.i18n.format(`DS_TRIGGERS.LineEffect.${mark.key}Desc`, { owner: owner.name, source: sourceName ?? "" }))}</p>`,
    duration: { expiry: mark.expiry },
    flags: { [MODULE_ID]: { victimMark: { label, ownerUuid: owner.uuid } } },
  }]);
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.LineEffect.Applied", { name: victim.name, effect: game.i18n.format(`DS_TRIGGERS.LineEffect.${mark.key}`, { owner: owner.name }), source: sourceName ?? "" }));
  dbg(`${sourceName}: ${victim.name} is now ${label} to ${owner.name}`);
}

const stabilityEffect = (name, img, amount, origin) => ({
  name, img, origin,
  changes: [{ key: "system.combat.stability", mode: 2, value: String(amount), priority: null }],
  duration: { expiry: "roundEnd" },
  flags: { [MODULE_ID]: { stabilityShare: true } },
});

export async function shareStability(owner, ally, amount, sourceName, img) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  if (!n || !owner || !ally) return 0;
  const name = game.i18n.format("DS_TRIGGERS.LineEffect.Stability", { source: sourceName });
  await owner.createEmbeddedDocuments("ActiveEffect", [stabilityEffect(name, img, -n, owner.uuid)]);
  await ally.createEmbeddedDocuments("ActiveEffect", [stabilityEffect(name, img, n, owner.uuid)]);
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.LineEffect.StabilityShared", { owner: owner.name, ally: ally.name, n }));
  return n;
}

export async function pickStabilityShare(ownerName, max, sourceName) {
  const options = Array.from({ length: max + 1 }, (_, i) => `<option value="${i}"${i === max ? " selected" : ""}>${i}</option>`).join("");
  const picked = await foundry.applications.api.DialogV2.prompt({
    window: { title: sourceName },
    content: `<p>${foundry.utils.escapeHTML(game.i18n.format("DS_TRIGGERS.LineEffect.StabilityPrompt", { owner: ownerName }))}</p>
      <div class="form-group"><label>${game.i18n.localize("DS_TRIGGERS.LineEffect.StabilityAmount")}</label>
      <div class="form-fields"><select name="amount">${options}</select></div></div>`,
    ok: { label: game.i18n.localize("DS_TRIGGERS.LineEffect.StabilityConfirm"), callback: (event, button) => Number(button.form.elements.amount.value) },
    rejectClose: false,
  }).catch(() => null);
  return Number.isFinite(picked) ? picked : null;
}
