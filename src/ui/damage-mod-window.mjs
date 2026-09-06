import { getSetting } from "../util.mjs";

const L = (k, data) => data ? game.i18n.format(`DS_TRIGGERS.Queue.${k}`, data) : game.i18n.localize(`DS_TRIGGERS.Queue.${k}`);

const _isMult = (p) => p.kind === "half" || p.kind === "double";

export function damagePillDisplayList(pills) {
  const pairs = (pills ?? []).map((pill, idx) => ({ pill, idx, inert: false }));
  let list = pairs;
  try {
    if (getSetting("multiplierOverride")) {
      list = [...pairs.filter((x) => !_isMult(x.pill)), ...pairs.filter((x) => _isMult(x.pill))];
    }
    if (getSetting("noMultiplierStacking")) {
      const seen = {};
      for (const x of list) {
        if (!_isMult(x.pill)) continue;
        if (seen[x.pill.kind]) x.inert = true;
        else seen[x.pill.kind] = true;
      }
    }
  } catch {}
  return list;
}

export function foldDamagePills(base, pills) {
  let v = Number(base) || 0;
  for (const x of damagePillDisplayList(pills)) {
    if (x.inert) continue;
    const p = x.pill;
    if (p.kind === "half") v = Math.floor(v / 2);
    else if (p.kind === "double") v = v * 2;
    else if (p.kind === "delta" || p.kind === "surge") v = Math.max(0, v + (Number(p.value) || 0));
  }
  return Math.max(0, v);
}

export function damagePillEffect(p) {
  if (p.kind === "half") return L("PillEffectHalf");
  if (p.kind === "double") return L("PillEffectDouble");
  if (p.kind === "surge") return L("PillEffectSurge", { n: Math.abs(Number(p.value) || 0) });
  const v = Number(p.value) || 0;
  return v >= 0 ? L("PillEffectPlus", { n: v }) : L("PillEffectMinus", { n: Math.abs(v) });
}

export function damagePillText(p) {
  const label = (p.label ?? "").trim();
  if (p.kind === "half") return label ? `½ ${label}` : L("PillEffectHalf");
  if (p.kind === "double") return label ? `×2 ${label}` : L("PillEffectDouble");
  if (p.kind === "surge") return label || L("PillSurge");
  if (label) return label;
  return damagePillEffect(p);
}

export async function openDamageModWindow({ title, hint = "", base, pills = [], surge = null }) {
  const stack = pills.map((p) => ({ ...p }));
  const surgeCap = surge ? Math.min(3, Number(surge.available) || 0) : 0;
  const stagedSurges = () => stack.filter((p) => p.kind === "surge").length;

  const surgeButton = surge
    ? `<button type="button" data-pill="surge" data-tooltip="${L("PillSurgeTooltip", { damage: surge.damage, available: surge.available })}"><i class="fa-solid fa-bolt"></i> ${L("PillSurge")}</button>`
    : "";

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title },
    position: { width: 320 },
    content: `${hint ? `<div class="hint dst-modwin-hint">${hint}</div>` : ""}
      <div class="dst-held-form">
        <div class="dst-held-total">
          <span class="dst-held-base">${base}</span>
          <i class="fa-solid fa-arrow-right"></i>
          <span class="dst-held-final" data-final>${base}</span>
        </div>
        <div class="dst-damage-pills" data-pill-row></div>
        <input type="text" data-pill-name placeholder="${L("PillNamePh")}">
        <div class="dst-held-adjust">
          <button type="button" data-pill="half">${L("HeldDamageHalf")}</button>
          <button type="button" data-pill="double">${L("HeldDamageDouble")}</button>
          <button type="button" data-pill="plus">${L("PillBonus")}</button>
          <input type="number" data-pill-size value="1" min="1" step="1">
          <button type="button" data-pill="minus">${L("PillPenalty")}</button>
          ${surgeButton}
        </div>
      </div>`,
    buttons: [
      {
        action: "apply",
        label: "DS_TRIGGERS.Queue.HeldDamageApply",
        icon: "fa-solid fa-heart-crack",
        default: true,
        callback: () => ({ final: foldDamagePills(base, stack), pills: stack }),
      },
      { action: "discard", label: "DS_TRIGGERS.Queue.HeldDamageDiscard", callback: () => null },
    ],
    render: (_event, dialog) => {
      const root = dialog.element ?? dialog;
      const row = root.querySelector("[data-pill-row]");
      const finalEl = root.querySelector("[data-final]");
      const nameEl = root.querySelector("[data-pill-name]");
      const sizeEl = root.querySelector("[data-pill-size]");
      const surgeBtn = root.querySelector('[data-pill="surge"]');

      const refresh = () => {
        if (finalEl) finalEl.textContent = String(foldDamagePills(base, stack));
        if (surgeBtn) surgeBtn.disabled = stagedSurges() >= surgeCap;
        if (!row) return;
        row.innerHTML = "";
        for (const x of damagePillDisplayList(stack)) {
          const p = x.pill;
          const span = document.createElement("span");
          span.className = `dst-pill dst-pill--removable dst-pill--${p.kind}${x.inert ? " dst-pill--inert" : ""}`;
          span.textContent = damagePillText(p);
          const effect = x.inert ? L("PillInertTooltip") : damagePillEffect(p);
          span.dataset.tooltip = `${effect}<br>${L("PillRemoveTooltip")}`;
          span.addEventListener("click", () => {
            const idx = stack.indexOf(p);
            if (idx !== -1) stack.splice(idx, 1);
            refresh();
          });
          row.appendChild(span);
        }
      };

      const takeName = () => {
        const name = (nameEl?.value ?? "").trim();
        if (nameEl) nameEl.value = "";
        return name;
      };

      for (const btn of root.querySelectorAll("[data-pill]")) {
        btn.addEventListener("click", () => {
          const kind = btn.dataset.pill;
          const size = Math.max(1, Number(sizeEl?.value) || 1);
          if (kind === "half") stack.push({ kind: "half", label: takeName(), source: "manual" });
          else if (kind === "double") stack.push({ kind: "double", label: takeName(), source: "manual" });
          else if (kind === "plus") stack.push({ kind: "delta", value: size, label: takeName(), source: "manual" });
          else if (kind === "minus") stack.push({ kind: "delta", value: -size, label: takeName(), source: "manual" });
          else if (kind === "surge") {
            if (stagedSurges() >= surgeCap) return;
            stack.push({ kind: "surge", value: Number(surge.damage) || 0, label: takeName(), source: "surge" });
          }
          refresh();
        });
      }
      refresh();
    },
    rejectClose: false,
  }).catch(() => null);

  return result ?? null;
}
