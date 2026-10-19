import { IMPACTS } from "./editor-impacts.mjs";
import { getParsedTrigger } from "../triggers/registry.mjs";

const L = (k, data) => (data ? game.i18n.format(`DS_TRIGGERS.Queue.Chip.${k}`, data) : game.i18n.localize(`DS_TRIGGERS.Queue.Chip.${k}`));
const FREE_STRIKE = /\bfree strikes?\b/i;
const HELD_IMPACTS = new Set(["hold", "halfHeld", "reduceHeld", "redirectHeld", "damageType"]);
const OWNER_IMPACTS = new Set(["turn"]);
const SHORT_KEYS = { hold: "Hold" };
const MINOR = new Set(["a", "an", "the", "of", "to", "with", "by", "on", "in", "and", "or", "for", "at"]);
const titleCase = (s) => String(s ?? "").split(/(\s+)/).map((w, i) => (i && MINOR.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1))).join("");

function evaluate(formula, item, entry) {
  if (formula == null || formula === "") return null;
  try {
    const data = { ...(item.getRollData?.() ?? item.actor?.getRollData?.() ?? {}), triggerDamage: entry.triggerDamage ?? entry.heldDamage?.amount ?? 0 };
    const value = Roll.safeEval(Roll.replaceFormulaData(String(formula), data, { missing: "0" }));
    return Number.isFinite(value) ? Math.floor(value) : null;
  } catch {
    return null;
  }
}

function enhancementText(fx, item, entry) {
  const data = fx[fx.type.slice(5)] ?? {};
  const typeLabel = (types) => Object.entries(types ?? {}).filter(([, on]) => on).map(([t]) => game.i18n.localize(ds.CONFIG.damageTypes?.[t]?.label ?? t)).join("/");
  if (fx.type === "dsct.flatDamage") {
    const n = evaluate(data.value, item, entry);
    const type = typeLabel(data.types);
    if (n != null) return L("Damage", { n, type: type ? `${type} ` : "" });
  }
  if (fx.type === "dsct.flatForced") {
    const n = evaluate(data.distance, item, entry);
    const verb = data.display || fx.name;
    if (n != null) return `${verb} ${n}`;
  }
  return data.display || fx.name || data.displayText || fx.type;
}

function clauseFor(entry, item) {
  const parse = entry.featureLine?.parse ?? (item ? getParsedTrigger(item) : null);
  const clauses = parse?.clauses ?? [];
  return clauses.find((c) => c.event === entry.event) ?? clauses[0] ?? null;
}

export function impactChips(entry, faces) {
  const item = entry.itemUuid ? fromUuidSync(entry.itemUuid) : null;
  if (!item && !entry.featureLine) return [];
  const aim = entry.choices?.length
    ? entry.choices.map((c) => (c.subjectTokenUuid ? fromUuidSync(c.subjectTokenUuid) : null))
    : [entry.subjectTokenUuid ? fromUuidSync(entry.subjectTokenUuid) : null];
  const held = [entry.heldDamage?.tokenUuid ? fromUuidSync(entry.heldDamage.tokenUuid) : null].filter(Boolean);
  const owner = [entry.ownerActorUuid ? fromUuidSync(entry.ownerActorUuid) : null].map((a) => a?.token ?? a?.getActiveTokens?.(false, true)?.[0] ?? null);
  const chip = (kind, icon, text, tooltip, who) => ({ kind, icon, text: titleCase(text), tooltip: tooltip ?? text, facesHTML: faces((who ?? []).filter(Boolean)) });
  const chips = [];
  const clause = clauseFor(entry, item);
  if (clause) {
    for (const impact of IMPACTS) {
      if (!impact.has(clause)) continue;
      const who = HELD_IMPACTS.has(impact.id) ? (held.length ? held : aim) : OWNER_IMPACTS.has(impact.id) ? owner : aim;
      const text = SHORT_KEYS[impact.id] ? L(SHORT_KEYS[impact.id]) : impact.summary(clause);
      chips.push(chip("auto", impact.icon, text, impact.summary(clause), who));
    }
  }
  for (const fx of item?.system?.effects?.contents ?? []) {
    if (!String(fx.type ?? "").startsWith("dsct.")) continue;
    const data = fx[fx.type.slice(5)] ?? {};
    chips.push(chip("enhanced", "fa-solid fa-wand-sparkles", enhancementText(fx, item, entry), data.displayText || L("EnhancedTip"), aim));
  }
  const effect = entry.featureLine?.effect ?? (item ? [...(item.system?.effects?.contents ?? [])].map((e) => e.description ?? "").join(" ").replace(/<[^>]+>/g, " ") : "");
  if (FREE_STRIKE.test(effect) && !chips.some((c) => c.kind === "enhanced")) {
    const each = Number(fromUuidSync(entry.ownerActorUuid ?? "")?.system?.monster?.freeStrike);
    const count = 1 + (entry.squad?.length ?? 0);
    chips.push(Number.isFinite(each) && each > 0
      ? chip("auto", "fa-solid fa-hand-back-fist", L("FreeStrikeDamage", { n: each * count }), count > 1 ? L("FreeStrikeEach", { n: each, count }) : null, aim)
      : chip("auto", "fa-solid fa-hand-back-fist", L("FreeStrike"), null, aim));
  }
  if (entry.defersDeath) chips.push(chip("auto", "fa-solid fa-skull", L("DefersDeath"), null, owner));
  if (!chips.length && item?.system?.power?.roll?.enabled) chips.push(chip("roll", "fa-solid fa-dice-d10", L("PowerRoll"), null, aim));
  if (!chips.length) chips.push({ kind: "manual", icon: "fa-solid fa-book-open", text: L("Manual"), tooltip: effect.replace(/\s+/g, " ").trim() || L("Manual"), facesHTML: "" });
  return chips;
}
