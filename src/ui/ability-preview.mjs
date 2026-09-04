const DIST_ICONS = { melee: "fa-sword", ranged: "fa-bow-arrow", meleeRanged: "fa-swords", self: "fa-user" };

function neutralizeStatusLinks(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  for (const el of div.querySelectorAll('.roll-link[data-type="status"], .roll-link[data-type="custom"]')) {
    el.removeAttribute("data-type");
    el.classList.add("dst-inert-link");
  }
  return div.innerHTML;
}

export async function buildAbilityPreview(item, { includeMeta = true, includeTrigger = false, includeTriggeredAction = false } = {}) {
  const sys = item?.system;
  if (!sys) return "";
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
  const enrich = async (text) => {
    if (!text) return "";
    const html = await TE.enrichHTML(text, { relativeTo: item }).catch(() => text);
    return neutralizeStatusLinks(html);
  };

  let labels = null;
  try { labels = sys.formattedLabels ?? null; } catch { labels = null; }
  const parts = [];

  if (includeMeta) {
    const actionType = sys.type;
    const excluded = includeTriggeredAction ? ["none"] : ["none", "triggered", "freeTriggered"];
    const actionLabel = actionType && !excluded.includes(actionType)
      ? game.i18n.localize(ds.CONFIG.abilities.types[actionType]?.label ?? "") : "";
    const kwPills = [...(sys.keywords ?? [])].map((k) => {
      const kwLabel = ds.CONFIG.abilities.keywords?.[k]?.label;
      const label = kwLabel ? game.i18n.localize(kwLabel) : k.charAt(0).toUpperCase() + k.slice(1);
      return `<span class="dst-preview-badge">${label}</span>`;
    }).join("");
    if (kwPills || actionLabel) {
      parts.push(`<div class="dst-preview-kw"><span class="dst-preview-kw-badges">${kwPills}</span><span class="dst-preview-action">${actionLabel}</span></div>`);
    }
    const dtParts = [];
    if (labels?.distance) dtParts.push(`<span><i class="fa-solid ${DIST_ICONS[sys.distance?.type] ?? "fa-ruler-combined"}"></i> ${labels.distance}</span>`);
    if (labels?.target) dtParts.push(`<span><i class="fa-solid fa-bullseye"></i> ${game.i18n.localize(labels.target)}</span>`);
    if (dtParts.length) parts.push(`<div class="dst-preview-dt">${dtParts.join("")}</div>`);
  }

  if (includeTrigger && sys.trigger) {
    const triggerLabel = sys.schema?.fields?.trigger?.label;
    parts.push(`<div class="dst-preview-effect"><strong>${triggerLabel ? game.i18n.localize(triggerLabel) : "Trigger"}:</strong>${await enrich(sys.trigger)}</div>`);
  }

  const before = [];
  const after = [];
  for (const eff of sys.effects?.sortedContents ?? []) {
    const text = await enrich(eff.description ?? "");
    if (!text) continue;
    (eff.before ? before : after).push(`<div class="dst-preview-effect"><strong>${eff.label ? `${eff.label}:` : ""}</strong>${text}</div>`);
  }
  parts.push(...before);

  
  
  if (typeof sys.powerRollText === "function") {
    const tierLines = await Promise.all([1, 2, 3].map(async (tier) => {
      const text = await enrich(await sys.powerRollText(tier));
      return text ? `<div class="dst-preview-tier"><span class="dst-tier-badge dst-tier-badge--${tier}">${["&le;11", "12&ndash;16", "17+"][tier - 1]}</span><span>${text}</span></div>` : "";
    }));
    if (tierLines.some(Boolean)) parts.push(`<div class="dst-preview-tiers">${tierLines.join("")}</div>`);
  }

  parts.push(...after);
  return parts.join("");
}
