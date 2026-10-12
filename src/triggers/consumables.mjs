import { MODULE_ID, isPrimaryGM, getSetting } from "../util.mjs";
import { cardContent, facesIn, postSystemCard } from "../ui/system-card.mjs";
import { asPrimaryGM, queueSocket } from "./queue.mjs";

const FLAG = "consumable";
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const L = (key, data) => (data ? game.i18n.format(`DS_TRIGGERS.Consumable.${key}`, data) : game.i18n.localize(`DS_TRIGGERS.Consumable.${key}`));

export const isConsumable = (item) => item?.type === "treasure" && item.system?.category === "consumable";

const quantityOf = (item) => Math.max(0, Number(item?.system?.quantity ?? 1));

const spendOne = async (item) => {
  const left = Math.max(0, quantityOf(item) - 1);
  await item.update({ "system.quantity": left });
  return left;
};

export async function remindConsumable(actor, item) {
  if (!isPrimaryGM() || !actor || !isConsumable(item)) return;
  const whisper = game.users.filter((u) => u.isGM || actor.testUserPermission(u, "OWNER")).map((u) => u.id);
  const auto = getSetting("autoSpendConsumables") === true;
  const flag = { actorUuid: actor.uuid, itemId: item.id };
  if (auto) Object.assign(flag, { done: true, left: await spendOne(item) });
  const label = auto ? L("Spent", { left: flag.left }) : L("UseOne", { left: Math.max(0, quantityOf(item) - 1) });
  const button = `<button type="button" class="dst-consumable-use"${auto ? " disabled" : ""}><i class="fa-solid ${auto ? "fa-check" : "fa-box-open"}" inert></i> ${esc(label)}</button>`;
  return postSystemCard({
    title: item.name,
    flavor: "",
    content: cardContent({ intro: facesIn(esc(L("Used", { name: actor.name, item: "ITEM_LINK" })), [actor]).replace("ITEM_LINK", `@UUID[${item.uuid}]{${esc(item.name)}}`), buttons: button }),
    whisper,
    kind: "Consumable",
    flags: { [MODULE_ID]: { [FLAG]: flag } },
  });
}

async function useOne(messageId) {
  const message = game.messages.get(messageId);
  const data = message?.getFlag(MODULE_ID, FLAG);
  if (!data || data.done) return;
  const item = (await fromUuid(data.actorUuid))?.items.get(data.itemId);
  if (!item) return;
  const left = await spendOne(item);
  await message.setFlag(MODULE_ID, FLAG, { ...data, done: true, left });
}

Hooks.once("ready", () => queueSocket()?.register("consumableUseOne", useOne));

Hooks.on("renderChatMessageHTML", (message, html) => {
  const data = message.getFlag(MODULE_ID, FLAG);
  const button = data && html.querySelector?.(".dst-consumable-use");
  if (!button) return;
  const item = fromUuidSync(data.actorUuid)?.items?.get(data.itemId);
  const finished = (text) => {
    button.disabled = true;
    button.innerHTML = `<i class="fa-solid fa-check" inert></i> ${esc(text)}`;
  };
  if (data.done) return finished(L("Spent", { left: data.left ?? quantityOf(item) }));
  if (!item) return finished(L("Gone"));
  if (quantityOf(item) <= 0) return finished(L("Spent", { left: 0 }));
  button.innerHTML = `<i class="fa-solid fa-box-open" inert></i> ${esc(L("UseOne", { left: quantityOf(item) - 1 }))}`;
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    button.disabled = true;
    if (isPrimaryGM()) await useOne(message.id);
    else await asPrimaryGM("consumableUseOne", message.id);
  });
});
