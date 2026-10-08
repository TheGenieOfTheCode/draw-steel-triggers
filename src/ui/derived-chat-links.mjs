import { getSetting } from "../util.mjs";
import { itemEffectiveLines } from "../triggers/feature-triggers.mjs";
import { derivedActive, derivedFor, isDerived } from "../triggers/derived.mjs";

const norm = (s) => String(s ?? "").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
const opening = (s) => norm(s).replace(/^(?:whenever|when|if|each time)\s+/, "").slice(0, 48);

async function linkTriggers(embed) {
  const ability = fromUuidSync(embed.dataset.uuid);
  if (ability?.type !== "ability" || !ability.actor || isDerived(ability)) return;
  const pairs = itemEffectiveLines(ability)
    .map((line) => ({ line, derived: derivedFor(ability.actor, ability.id, line.key) }))
    .filter((p) => p.derived);
  if (!pairs.length) return;
  const TE = foundry.applications.ux.TextEditor.implementation;
  for (const block of embed.querySelectorAll("dd.effect p")) {
    const text = norm(block.textContent);
    const hit = pairs.find(({ line }) => text.length && opening(text) === opening(line.sentence)
      && text.length <= norm(line.sentence).length * 1.3 + 10);
    if (!hit) continue;
    block.innerHTML = await TE.enrichHTML(`@UUID[${hit.derived.uuid}]{${hit.derived.name}}`, { relativeTo: hit.derived });
    block.classList.add("dst-derived-link");
  }
}

Hooks.on("renderChatMessageHTML", (_message, html) => {
  if (!getSetting("derivedChatLinks") || !derivedActive()) return;
  for (const embed of html.querySelectorAll("document-embed.ability[data-uuid]")) linkTriggers(embed);
});
