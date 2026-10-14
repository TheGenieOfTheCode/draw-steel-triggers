import { getSetting } from "../util.mjs";

const OPTIONAL = /\b(?:you|they|it|the [\w'’-]+) (?:can|may)(?!['’]t)\b/i;

export function autoUseLevel() {
  if (!getSetting("autoUseMandatory")) return "none";
  return getSetting("autoUseTriggers") ? "all" : "mandatory";
}

const firstSentence = (text) => String(text ?? "").split(/(?<=[.!?])\s+/)[0];

export const lineMandatory = (line) => !!line && !line.action && !OPTIONAL.test(firstSentence(line.effect));

export function matchMandatory(m) {
  return lineMandatory(m?.item?.featureLine) && !(Number(m.item.featureLine.resourceCost) > 0);
}

export function autoApplies({ mandatory, costless = true, perRound = false }) {
  const level = autoUseLevel();
  if (!costless || level === "none") return false;
  if (mandatory) return true;
  return level === "all" && !perRound;
}
