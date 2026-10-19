const L = (k, data) => data ? game.i18n.format(`DS_TRIGGERS.Queue.${k}`, data) : game.i18n.localize(`DS_TRIGGERS.Queue.${k}`);

function _dsctDamageApi() {
  const mod = game.modules.get("draw-steel-combat-tools");
  return mod?.active ? mod.api?.damagePills ?? null : null;
}

export function damagePillType(pills) {
  const api = _dsctDamageApi();
  if (api) return api.pillType(pills);
  let found = null;
  for (const p of pills ?? []) {
    if (p.enabled === false) continue;
    if (p.kind === "type") found = p.value ?? "";
  }
  return found;
}

export function foldDamagePills(base, pills = []) {
  const api = _dsctDamageApi();
  if (api?.fold) return api.fold(base, pills);
  let v = Number(base) || 0;
  for (const p of pills) {
    if (p.enabled === false) continue;
    if (p.kind === "half") v = Math.floor(v / 2);
    else if (p.kind === "double") v *= 2;
    else if (p.kind === "delta") v = Math.max(0, v + (Number(p.value) || 0));
  }
  return Math.max(0, v);
}

export async function openDamageModWindow({ title, hint = "", base, pills = [], surge = null }) {
  const api = _dsctDamageApi();
  if (api) return api.open({ title, hint, base, pills, surge });
  return _fallbackDialog({ title, hint, base, pills });
}

async function _fallbackDialog({ title, hint, base, pills }) {
  const startAmount = pills?.some((p) => p.kind === "half" && p.enabled !== false)
    ? Math.floor((Number(base) || 0) / 2)
    : Number(base) || 0;
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title },
    position: { width: 300 },
    content: `${hint ? `<div class="hint dst-modwin-hint">${hint}</div>` : ""}
      <div class="dst-held-form">
        <input type="number" name="dst-held-amount" value="${startAmount}" min="0" step="1">
        <div class="dst-held-adjust">
          <button type="button" data-adjust="half">${L("HeldDamageHalf")}</button>
          <button type="button" data-adjust="double">${L("HeldDamageDouble")}</button>
          <button type="button" data-adjust="plus">+1</button>
          <button type="button" data-adjust="minus">-1</button>
        </div>
      </div>`,
    buttons: [
      {
        action: "apply",
        label: "DS_TRIGGERS.Queue.HeldDamageApply",
        icon: "fa-solid fa-heart-crack",
        default: true,
        callback: (_event, _button, dialog) => {
          const el = (dialog.element ?? dialog).querySelector('input[name="dst-held-amount"]');
          return { final: Math.max(0, Number(el?.value) || 0), pills: [] };
        },
      },
      { action: "discard", label: "DS_TRIGGERS.Queue.HeldDamageDiscard", callback: () => null },
    ],
    render: (_event, dialog) => {
      const root = dialog.element ?? dialog;
      const input = root.querySelector('input[name="dst-held-amount"]');
      for (const btn of root.querySelectorAll("[data-adjust]")) {
        btn.addEventListener("click", () => {
          const cur = Math.max(0, Number(input?.value) || 0);
          const mode = btn.dataset.adjust;
          const next = mode === "half" ? Math.floor(cur / 2)
            : mode === "double" ? cur * 2
            : mode === "plus" ? cur + 1
            : Math.max(0, cur - 1);
          if (input) input.value = String(next);
        });
      }
    },
    rejectClose: false,
  }).catch(() => null);
  return result ?? null;
}
