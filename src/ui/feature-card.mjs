import { MODULE_ID, getSetting } from "../util.mjs";
import { enricherText } from "../parser/feature-triggers.mjs";
import { itemEffectiveLines } from "../triggers/feature-triggers.mjs";

export const SHARE_TYPES = new Set(["feature", "perk", "ancestryTrait", "complication"]);
const STYLE_FLAG = "cardStyle";
const TRIGGER_EFFECT = "triggerEffect";
const ENRICHER = /\[\[([^\]]*)\]\](?:\{([^}]*)\})?/g;

const GAINS = {
  epic: { label: "DRAW_STEEL.Actor.hero.FIELDS.hero.epic.value.label", path: "hero.epic.value" },
  heroic: { label: "DRAW_STEEL.Actor.hero.FIELDS.hero.primary.value.label", path: "hero.primary.value" },
  renown: { label: "DRAW_STEEL.Actor.hero.FIELDS.hero.renown.label", path: "hero.renown" },
  surge: { label: "DRAW_STEEL.Actor.hero.FIELDS.hero.surges.label", path: "hero.surges", one: "surge", many: "surges" },
  victory: { label: "DRAW_STEEL.Actor.hero.FIELDS.hero.victories.label", path: "hero.victories", one: "victory", many: "victories" },
  wealth: { label: "DRAW_STEEL.Actor.hero.FIELDS.hero.wealth.label", path: "hero.wealth" },
};
const GAIN_ALIASES = { hr: "heroic", victories: "victory", surges: "surge" };
const gainKey = (w) => {
  const k = String(w ?? "").toLowerCase();
  return k in GAINS ? k : GAIN_ALIASES[k] ?? null;
};

const L = (k, data) => (data ? game.i18n.format(`DS_TRIGGERS.Card.${k}`, data) : game.i18n.localize(`DS_TRIGGERS.Card.${k}`));
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
const titleCase = (s) => String(s).replace(/\b([a-z])/g, (m) => m.toUpperCase());

export const showsTriggerEffect = (item) => item?.getFlag(MODULE_ID, STYLE_FLAG) === TRIGGER_EFFECT;
export const setTriggerEffect = (item, on) => (on ? item.setFlag(MODULE_ID, STYLE_FLAG, TRIGGER_EFFECT) : item.unsetFlag(MODULE_ID, STYLE_FLAG));

function amountOf(formula, rollData) {
  const f = ds.rolls.DSRoll.replaceFormulaData(String(formula ?? ""), rollData ?? {}).trim();
  if (!f) return "";
  try {
    const roll = new Roll(f);
    if (roll.isDeterministic) return String(roll.evaluateSync().total);
  } catch {}
  return f;
}

async function readEnricher(raw, inner, label, { item, actor, rollData }) {
  const [cmd0, ...words] = inner.replace(/^[/]/, "").trim().split(/\s+/);
  const cmd = cmd0.toLowerCase();
  const args = words.filter((w) => !w.includes("="));
  const opts = Object.fromEntries(words.filter((w) => w.includes("=")).map((w) => w.split("=")));

  let gain = gainKey(cmd);
  if (cmd === "gain") gain = args.map(gainKey).find(Boolean) ?? null;
  if (gain) {
    const n = amountOf(args.filter((a) => !gainKey(a)).join(" ") || "1", rollData);
    const g = GAINS[gain];
    const noun = gain === "heroic" ? (actor?.system?.coreResource?.name ?? game.i18n.localize(g.label))
      : g.one ? (n === "1" ? g.one : g.many) : game.i18n.localize(g.label).toLowerCase();
    const prose = label ?? `gain ${n} ${gain === "heroic" ? noun : noun.toLowerCase()}`;
    return { prose, button: { kind: "gain", gain, formula: n, label: titleCase(`gain ${n} ${noun}`), icon: "fa-bolt" } };
  }

  if (cmd === "damage" || cmd === "heal" || cmd === "healing") {
    const healing = cmd !== "damage";
    const types = args.filter((a) => /^[a-z|]+$/i.test(a) && !/^\d/.test(a));
    const formula = args.filter((a) => !types.includes(a)).join(" ");
    const n = amountOf(formula, rollData);
    const temp = healing && (types.some((t) => /^temp/i.test(t)) || /^temp/i.test(opts.type ?? ""));
    const kinds = types.filter((t) => !/^temp/i.test(t)).map((t) => t.toLowerCase().replace(/\|/g, " or "));
    const prose = label ?? (healing ? `${n} ${temp ? "temporary " : ""}Stamina` : `${n}${kinds.length ? ` ${kinds.join(" ")}` : ""} damage`);
    return { prose, button: { kind: "enricher", raw, label: titleCase(label ?? prose), icon: healing ? "fa-heart-pulse" : "fa-burst" } };
  }

  const TE = foundry.applications.ux.TextEditor.implementation;
  const div = document.createElement("div");
  div.innerHTML = await TE.enrichHTML(raw, { relativeTo: item, rollData }).catch(() => "");
  const text = (div.querySelector("a")?.textContent ?? div.textContent ?? "").replace(/\s+/g, " ").trim();
  if (cmd === "apply") {
    return { prose: label ?? text.toLowerCase(), button: { kind: "enricher", raw, label: label ?? L("Apply", { status: text }), icon: "fa-person-rays" } };
  }
  if (cmd === "test") return { prose: label ?? text, button: { kind: "enricher", raw, label: label ?? titleCase(text), icon: "fa-dice-d10" } };
  if (cmd === "r" || cmd === "roll") {
    const f = args.join(" ");
    return { prose: label ?? f, button: { kind: "enricher", raw, label: label ?? L("Roll", { formula: f }), icon: "fa-dice-d20" } };
  }
  return { prose: label ?? (text || enricherText(inner, label)), button: null };
}

async function readAll(html, ctx) {
  const out = [];
  for (const m of String(html ?? "").matchAll(ENRICHER)) out.push({ ...(await readEnricher(m[0], m[1], m[2], ctx)), raw: m[0], parsed: enricherText(m[1], m[2]) });
  return out;
}

function buttonHTML(b) {
  const data = b.kind === "gain" ? `data-gain="${b.gain}" data-formula="${esc(b.formula)}"` : `data-enricher="${encodeURIComponent(b.raw)}"`;
  return `<button type="button" data-dst-card-button="${b.kind}" ${data}><i class="fa-solid ${b.icon}" inert></i> ${esc(b.label)}</button>`;
}

const footer = (buttons) => (buttons.length ? `<footer class="message-part-buttons dst-card-buttons">${buttons.map(buttonHTML).join("")}</footer>` : "");

function typePill(item) {
  const key = CONFIG.Item.typeLabels?.[item.type];
  return esc(key ? game.i18n.localize(key) : item.type);
}

function descriptionEmbed(item, html, reads) {
  let i = 0;
  const body = String(html ?? "").replace(ENRICHER, () => esc(reads[i++]?.prose ?? ""));
  const buttons = reads.map((r) => r.button).filter(Boolean);
  return `<document-embed class="draw-steel ability dst-feature-card">
<h5>${esc(item.name)}</h5>
<section class="metadata"><dl><dt class="keywords">${L("Keywords")}</dt><dd class="keywords">${typePill(item)}</dd></dl></section>
<section class="description">${body}</section>
${footer(buttons)}</document-embed>`;
}

function lineEmbed(item, line, reads, { buttons: withButtons = true } = {}) {
  let effect = cap(line.effect ?? "");
  const buttons = [];
  for (const r of reads) {
    if (!r.parsed || !effect.toLowerCase().includes(r.parsed.toLowerCase())) continue;
    const at = effect.toLowerCase().indexOf(r.parsed.toLowerCase());
    effect = effect.slice(0, at) + r.prose + effect.slice(at + r.parsed.length);
    if (r.button) buttons.push(r.button);
  }
  effect = cap(effect.replace(/\bdamage damage\b/g, "damage"));
  const action = game.i18n.localize(ds.CONFIG.abilities.types[line.action ?? "none"]?.label ?? "");
  const once = { round: "OnceRound", turn: "OnceTurn", encounter: "OnceEncounter" }[line.once];
  const type = once ? L("TypeOnce", { action, once: L(once) }) : action;
  const prereqs = prerequisites(item, line.tier);
  const row = (label, html, cls = "") => `<dl${cls ? ` class="${cls}"` : ""}><dt class="effect">${label}</dt><dd class="effect"><p>${html}</p></dd></dl>`;
  const triggerLabel = game.i18n.localize("DS_TRIGGERS.Feature.Trigger");
  const effectRow = row(game.i18n.localize("DS_TRIGGERS.Feature.Effect"), esc(effect));
  const rows = prereqs.length
    ? row(L(prereqs.length > 1 ? "Prerequisites" : "Prerequisite"), prereqs.map((c, i) =>
      `<span class="dst-prereq">${esc(i ? `${L("And")} ${c}` : cap(c))}${i < prereqs.length - 1 ? "," : ""}</span>`).join(" "))
      + row(triggerLabel, esc(line.trigger), "dst-trigger-row") + effectRow
    : effectRow;
  return `<document-embed class="draw-steel ability dst-feature-card">
<h5>${esc(line.name ?? item.name)}</h5>
<section class="metadata">
  ${line.flavor ? `<p class="flavor"><em>${esc(line.flavor)}</em></p>` : ""}
  <dl>
    <dt class="keywords">${L("Keywords")}</dt><dd class="keywords">${typePill(item)}</dd>
    <dt class="type">${L("Type")}</dt><dd class="type">${esc(type)}</dd>
    ${prereqs.length ? "" : `<dt class="trigger">${triggerLabel}</dt><dd class="trigger">${esc(line.trigger)}</dd>`}
  </dl>
</section>
<section class="effect after">${rows}</section>
${withButtons ? footer(buttons) : ""}</document-embed>`;
}

export async function featureLineEmbed(item, lineKey) {
  const actor = item.actor;
  const ctx = { item, actor, rollData: actor?.getRollData?.() ?? item.getRollData?.() ?? {} };
  const line = itemEffectiveLines(item).find((l) => l.key === lineKey);
  if (!line) return "";
  return lineEmbed(item, line, await readAll(item.system?.description?.value ?? "", ctx), { buttons: false });
}

function ordinal(n) {
  const rule = new Intl.PluralRules(game.i18n.lang, { type: "ordinal" }).select(n);
  return L(`Ordinal.${rule}`, { n });
}

export function prerequisites(item, tier) {
  if (!tier) return [];
  const out = [];
  if (tier.level) {
    const cls = item.actor?.items?.find((i) => i.type === "class")?.name ?? "";
    out.push(L("PrereqLevel", { ordinal: ordinal(tier.level), cls }).trim());
  }
  if (tier.resource) out.push(L("PrereqResource", { n: tier.min, resource: cap(tier.resource) }));
  return out;
}

export async function featureCardContent(item, { lineKey = null } = {}) {
  const actor = item.actor;
  const html = item.system?.description?.value ?? "";
  const ctx = { item, actor, rollData: actor?.getRollData?.() ?? item.getRollData?.() ?? {} };
  const reads = await readAll(html, ctx);
  const lines = item.type === "ability" || showsTriggerEffect(item) ? itemEffectiveLines(item).filter((l) => !lineKey || l.key === lineKey) : [];
  if (!lines.length) return descriptionEmbed(item, html, reads);
  return lines.map((l) => lineEmbed(item, l, reads)).join("");
}

export async function postFeatureCard(item, { lineKey = null, flags = {}, speaker = null } = {}) {
  const Msg = ds.documents.DrawSteelChatMessage;
  return Msg.create({
    type: "standard",
    title: item.name,
    content: await featureCardContent(item, { lineKey }),
    "system.parts": [{ type: "content" }],
    speaker: speaker ?? Msg.getSpeaker({ actor: item.actor }),
    flags: foundry.utils.mergeObject({ core: { canPopout: true }, [MODULE_ID]: { featureCard: { itemUuid: item.uuid, actorUuid: item.actor?.uuid ?? null } } }, flags),
  });
}

async function postGain(actor, gain, formula) {
  const roll = new ds.rolls.DSRoll(String(formula));
  await roll.evaluate();
  const g = GAINS[gain];
  const title = game.i18n.format("DRAW_STEEL.EDITOR.Enrichers.Gain.MessageTitle.Default", { type: game.i18n.localize(g.label), targets: "" });
  await ds.documents.DrawSteelChatMessage.create({
    title,
    rolls: roll.isDeterministic ? [] : [roll],
    type: "standard",
    "system.parts": [{ type: "roll", flavor: title, rolls: [roll] }],
    flags: { core: { canPopout: true } },
    speaker: ds.documents.DrawSteelChatMessage.getSpeaker({ actor }),
  });
  await actor.modifyTokenAttribute(g.path, roll.total, true, false);
}

async function runEnricher(raw, item, actor) {
  const TE = foundry.applications.ux.TextEditor.implementation;
  const host = document.createElement("div");
  host.hidden = true;
  host.innerHTML = await TE.enrichHTML(raw, { relativeTo: item, rollData: actor?.getRollData?.() ?? {} });
  document.body.append(host);
  await new Promise((r) => requestAnimationFrame(r));
  host.querySelector("a[data-type], a.inline-roll")?.click();
  setTimeout(() => host.remove(), 2000);
}

Hooks.on("renderChatMessageHTML", (message, html) => {
  const info = message.getFlag(MODULE_ID, "featureCard");
  if (!info) return;
  const actor = info.actorUuid ? fromUuidSync(info.actorUuid) : null;
  html.querySelectorAll("[data-dst-card-button]").forEach((btn) => {
    const gain = btn.dataset.dstCardButton === "gain";
    if (gain && !actor?.isOwner) {
      btn.disabled = true;
      return;
    }
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      if (gain) return postGain(actor, btn.dataset.gain, btn.dataset.formula);
      const item = await fromUuid(info.itemUuid).catch(() => null);
      await runEnricher(decodeURIComponent(btn.dataset.enricher), item, actor);
    });
  });
});

export const shareCardsOn = () => getSetting("featureShareCards") !== false;

const FREE_STRIKE_PART = "dstFreeStrike000";
const MAKES_FREE_STRIKE = /\bmakes? a free strike\b/i;

Hooks.on("preCreateChatMessage", (message) => {
  const parts = message.system?.parts;
  const use = parts?.contents?.find?.((p) => p.type === "abilityUse");
  if (!use || parts.has?.(FREE_STRIKE_PART)) return;
  const ability = use.ability;
  const actor = ability?.actor;
  const value = Number(actor?.system?.monster?.freeStrike);
  if (actor?.type !== "npc" || !value) return;
  const shown = new Set(use.effects ?? []);
  const text = [...(ability.system.effects ?? [])].filter((e) => !shown.size || shown.has(e.id))
    .map((e) => e.description ?? "").join(" ").replace(/<[^>]+>/g, " ");
  if (!MAKES_FREE_STRIKE.test(text)) return;
  const roll = new ds.rolls.DamageRoll(String(value));
  roll.evaluateSync();
  message.updateSource({ [`system.parts.${FREE_STRIKE_PART}`]: { _id: FREE_STRIKE_PART, type: "roll", rolls: [roll.toJSON()] } });
});

function openTriggerPicker(event, target, item, lines) {
  const Menu = foundry.applications.ux.ContextMenu.implementation;
  const entries = lines.map((line) => ({ label: line.name, icon: "fa-solid fa-bolt", onClick: () => postFeatureCard(item, { lineKey: line.key }) }));
  const picker = new Menu(document.createElement("div"), "*", entries, { jQuery: false, fixed: true });
  setTimeout(() => {
    ui.context = picker;
    picker.render(target, { event });
  }, 0);
}

Hooks.on("getDocumentListContextOptions", (app, items) => {
  const docOf = (target) => app._getEmbeddedDocument?.(target) ?? null;
  const isFeature = (doc) => doc?.documentName === "Item" && SHARE_TYPES.has(doc.type);
  const share = items.find((e) => e.label === "DRAW_STEEL.SHEET.Share");
  if (share) {
    const systemShare = share.onClick;
    share.onClick = async (event, target) => {
      const doc = docOf(target);
      if (!shareCardsOn() || !isFeature(doc)) return systemShare(event, target);
      const lines = showsTriggerEffect(doc) ? itemEffectiveLines(doc) : [];
      if (lines.length < 2) return postFeatureCard(doc);
      openTriggerPicker(event, target, doc, lines);
    };
  }
  const canToggle = (target, on) => {
    const doc = docOf(target);
    return isFeature(doc) && doc.isOwner && showsTriggerEffect(doc) !== on && itemEffectiveLines(doc).length > 0;
  };
  const at = share ? items.indexOf(share) + 1 : items.length;
  items.splice(at, 0, {
    label: "DS_TRIGGERS.Card.MenuTrigger",
    icon: "fa-solid fa-list-ul",
    visible: (target) => canToggle(target, true),
    onClick: (event, target) => setTriggerEffect(docOf(target), true),
  }, {
    label: "DS_TRIGGERS.Card.MenuFullDescription",
    icon: "fa-solid fa-align-left",
    visible: (target) => canToggle(target, false),
    onClick: (event, target) => setTriggerEffect(docOf(target), false),
  });
});
