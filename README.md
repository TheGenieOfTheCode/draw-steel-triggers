# <img src="icons/dst-icon.svg" width="40" alt=""> Draw Steel: Triggers

[![Downloads](https://img.shields.io/github/downloads/TheGenieOfTheCode/draw-steel-triggers/total?label=Downloads&color=4aa94a)](https://github.com/TheGenieOfTheCode/draw-steel-triggers/releases)
[![Latest Version](https://img.shields.io/github/downloads/TheGenieOfTheCode/draw-steel-triggers/latest/total?label=Latest%20Version&color=4aa94a)](https://github.com/TheGenieOfTheCode/draw-steel-triggers/releases/latest)

*Never miss your moment.*

A Foundry VTT module for the Draw Steel system that watches for the moments your triggered actions are waiting for. When one comes up, it offers you the ability right then, and when timing matters, it pauses the game until you decide.

It reads the trigger already written on each ability, so there's nothing to set up.

**Requires Foundry v14 and the Draw Steel system.**

---

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/genieofthecode)

*If you like what I do, consider donating on Ko-fi. Thanks!*

---

https://github.com/user-attachments/assets/bd6db76f-b980-4c21-81e4-76f7e6609154

https://github.com/user-attachments/assets/9d4e3fc2-210c-4ec8-8ff8-2712021ad4cf

---

## Documentation

Full documentation is available on the **[Wiki](https://github.com/TheGenieOfTheCode/draw-steel-triggers/wiki)**.

---

## Features

**[The Trigger Stack](https://github.com/TheGenieOfTheCode/draw-steel-triggers/wiki/The-Trigger-Stack)**: When one of your triggered actions can be used, it appears on the Trigger Stack with Use and Decline buttons, in front of the player who owns it. Not in the mood to be asked for a while? Snooze it.

**[Pauses the game when it matters](https://github.com/TheGenieOfTheCode/draw-steel-triggers/wiki/Automation-Tiers)**: A triggered action that halves damage is no help once the damage has landed. So the game waits: the damage, the power roll, the forced movement or even the next turn holds until the decision is made.

**[Knows your triggered action](https://github.com/TheGenieOfTheCode/draw-steel-triggers/wiki/How-Triggers-Work)**: Every creature gets one triggered action per round. Once a hero has used theirs, they aren't offered another until the next round. Free triggered actions are always offered.

**[Traits, perks and complications too](https://github.com/TheGenieOfTheCode/draw-steel-triggers/wiki/Feature-Triggers)**: Ancestry traits, perks, complications, titles and class features that react to something are watched as well, like an orc's Relentless or a dragon knight's Draconian Guard.

**[Triggers inside abilities](https://github.com/TheGenieOfTheCode/draw-steel-triggers/wiki/Ability-Triggers)**: Some abilities set up something that happens later, like the free triggered actions of a censor's Judgement or a tactician's Mark. Those become abilities of their own, offered when the moment comes.

**[Heroic resources, handed out](https://github.com/TheGenieOfTheCode/draw-steel-triggers/wiki/Heroic-Resource-Gains)**: Ferocity when a fury takes damage, wrath when a judged creature strikes the censor, discipline when the Director spends Malice. Each gain posts a card in chat with an Undo button.

**[Malice for the Director](https://github.com/TheGenieOfTheCode/draw-steel-triggers/wiki/Feature-Triggers#basic-malice-features)**: At the start of each monster's turn, the Director is whispered the Malice features that monster can use, with their costs.

**[Tells you what it understood](https://github.com/TheGenieOfTheCode/draw-steel-triggers/wiki/Supported-Triggers)**: Every ability shows a badge saying how much of its trigger is automated, and the [gaps are listed](https://github.com/TheGenieOfTheCode/draw-steel-triggers/wiki/Not-Yet-Automated) openly. If a trigger is read wrong, describe it yourself in the [Trigger Builder](https://github.com/TheGenieOfTheCode/draw-steel-triggers/wiki/The-Trigger-Builder), and your version wins.

---

## Installation

Install via the Foundry module browser, or paste this manifest URL directly:

```
https://github.com/TheGenieOfTheCode/draw-steel-triggers/releases/latest/download/module.json
```

**Required dependencies:** [Draw Steel: CTLib](https://github.com/TheGenieOfTheCode/draw-steel-ctlib), [socketlib](https://foundryvtt.com/packages/socketlib), [Draw Steel: Target Damage](https://foundryvtt.com/packages/draw-steel-target-damage)

Foundry offers to install them alongside Triggers.

**Recommended:** [Draw Steel: Combat Tools](https://github.com/TheGenieOfTheCode/draw-steel-combat-tools), [lib-wrapper](https://foundryvtt.com/packages/lib-wrapper)

---

## Compatibility

- [Draw Steel: Combat Tools](https://github.com/TheGenieOfTheCode/draw-steel-combat-tools): pushes, pulls and slides can be held before the creature moves, judged and marked creatures are tracked, and abilities that Triggers offers get Combat Tools' effect buttons. Without it, forced movement triggers are offered after the movement instead.
- [Draw Steel - Resources UI](https://github.com/OmerCora/draw-steel-resources-ui): heroic resource gains that Triggers hands out are marked as used there, and the other way round.

Building a module that wants to work with triggers? See **[For Developers](https://github.com/TheGenieOfTheCode/draw-steel-triggers/wiki/For-Developers)**.

---

## Issues & Feedback

Bug reports and feature requests go in [Issues](https://github.com/TheGenieOfTheCode/draw-steel-triggers/issues).

---

## Credits

Module emblem incorporates the [Crossed swords icon](https://game-icons.net/1x1/lorc/crossed-swords.html) by Lorc, licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
