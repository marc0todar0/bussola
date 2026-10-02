// The brand blue stays a literal: it reads on both themes, and a few callers
// build a translucent tint by appending an alpha to it (`${mainColor}22`),
// which a var() would break. The grey is a token, because darkgray on a dark
// page is a different contrast from darkgray on a white one; every use of it
// is a style value, where var() works. Neither may be handed to the chart
// library -- it cannot resolve a var(); see useThemeColors in utils/theme.js.
const mainColor = "dodgerblue";
const secondaryColor = "var(--neutral)";
// Icon names come from Iconify, which is what MyIcon actually renders with:
//   https://icon-sets.iconify.design/
// NOT from icons.expo.fyi. The two catalogues share the family names but not
// the icon names -- Iconify has "shopping-cart" where Expo has "shoppingcart"
// -- and a name that does not exist there renders as an empty square, with no
// error logged anywhere. getIconPrefix() in utils/generic.js maps the family
// names below onto Iconify prefixes and passes any other string through
// unchanged, so a raw prefix such as "fa6-brands" is a valid family too.
const icons = [
  {
    family: "AntDesign",
    icons: [
      "wifi",
      "form",
      "credit-card",
      "facebook",
      "github",
      "shopping-cart",
    ],
  },
  {
    family: "FontAwesome",
    icons: [
      "paypal",
      "cc-mastercard",
      "book",
      "beer",
      "bitcoin",
      "dollar",
      "euro",
      "vimeo",
    ],
  },
  {
    family: "FontAwesome5",
    icons: ["coins"],
  },
  {
    family: "Entypo",
    icons: ["dots-three-horizontal"],
  },
  {
    // Iconify keeps brand marks in their own set, so these two cannot sit
    // under Entypo the way they did in the Expo catalogue.
    family: "fa6-brands",
    icons: ["spotify", "dribbble"],
  },
  {
    family: "MaterialIcons",
    icons: ["card-travel", "sim-card"],
  },
  {
    family: "MaterialCommunityIcons",
    icons: [
      "contactless-payment-circle",
      "finance",
      "bank-transfer",
      "credit-card-refund",
      "credit-card-remove",
      "gas-station",
    ],
  },
  {
    family: "Ionicons",
    icons: ["restaurant", "fast-food", "people"],
  },
];

// ISO currencies selectable for a holding (the underlying's currency).
const isoCurrencies = ["EUR", "USD", "GBP", "CHF", "JPY", "AUD", "CAD", "CNY", "HKD", "SEK"];

// Holding types allowed per pillar, by stable code. Pillars not listed here
// (4 = long term) have no limit: every type is selectable.
//   1 = cash · 2 = emergency fund · 3 = planned expenses · 4 = long term
//
// These are codes and not names on purpose: a name follows the interface
// language, and a rule keyed on a name would stop matching the moment somebody
// switched language.
const typesPerPillar = {
  1: ["CASH"],
  2: ["CASH", "DEPOSIT_ACCOUNT", "INTEREST_ACCOUNT", "BOT", "MONEY_MARKET_ETF"],
  3: ["BOND", "BOT", "BTP"],
};

export { mainColor, secondaryColor, icons, isoCurrencies, typesPerPillar };
