// Month and weekday names are not here: they come from Intl through the i18n
// module (see useT), which knows them in every language the browser supports.

const parseDateyyyymmdd = (stringDate) => {
  const year = stringDate.substring(0, 4);
  const month = Number(stringDate.substring(4, 6));
  const day = stringDate.substring(6, 8);

  const dd = new Date(year, month - 1, day);

  return {
    year: dd.getFullYear(),
    month: dd.getMonth() + 1,
    day: dd.getDate(),
    dd: dd,
  };
};

const formatDate = (date) => {
  const d = new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${month}${day}`;
};

function getIconPrefix(family, style = "solid") {
  const map = {
    Ionicons: "ion",
    MaterialCommunityIcons: "mdi",
    FontAwesome: "fa",
    FontAwesome5: {
      solid: "fa6-solid",
      regular: "fa6-regular",
      brands: "fa6-brands",
    },
    Entypo: "entypo",
    MaterialIcons: "material-symbols",
    AntDesign: "ant-design",
  };

  if (family === "FontAwesome5") {
    return map[family][style] || "fa6-solid";
  }

  if (map[family]) return map[family];
  if (family && typeof family === "string") return family;
  return "mdi";
}

// Lower case with accents stripped: "caffe" finds "Caffè", "ESSELUNGA" finds
// "Esselunga".
const normalizeText = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

function toMoneyFormat(value) {
  let n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) < 0.005) n = 0;
  return n.toFixed(2);
}

export { parseDateyyyymmdd, formatDate, getIconPrefix, toMoneyFormat, normalizeText };

// The catalogues hold no plural machinery -- an interface needs two forms, not
// a rules engine -- so the caller picks the form and t() fills in the number.
export const membersLabel = (t, n) =>
  n === 1 ? t("wallet.membersOne") : t("wallet.members", { n });
