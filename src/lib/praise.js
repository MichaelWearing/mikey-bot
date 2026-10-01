// Fun praise for a deathless night, shared by the two places that hand it out: the
// personal /feedback headline ("🌟 No deaths tonight, <personal>") and the /summary
// roll call's field title ("🌟 No Deaths (3) — <group>").
//
// One entry per joke with both phrasings, rather than two separate lists, so the two
// surfaces can't drift apart as lines get added. Every `group` line has to read right
// for a single person as well as a crowd — on a rough night only one raider makes it.
export const DEATHLESS_PRAISE = [
  { personal: "you are a GOD GAMER", group: "certified GOD GAMER energy" },
  { personal: "you are built different", group: "built different" },
  { personal: "the floor is scared of you", group: "the floor is scared of them" },
  { personal: "the healers want to adopt you", group: "the healers want to adopt them" },
  { personal: "you are simply unkillable", group: "simply unkillable" },
  { personal: "not a scratch on you", group: "not a scratch on them" },
  { personal: "you made it look easy", group: "they made it look easy" },
  { personal: "the repair bill says zero", group: "no repair bill in sight" },
];

export function randomPraise(key) {
  return DEATHLESS_PRAISE[Math.floor(Math.random() * DEATHLESS_PRAISE.length)][key];
}
