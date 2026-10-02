import MyIcon from "./MyIcon";

/*
  MANDATORY: icon, color
  OPTIONAL: size, width, height
*/
const IconItem = ({ icon, family, color, size, width, height, styles }) => (
  <div
    style={{
      backgroundColor: color,
      width: width || 50,
      height: height || 45,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 4,
      ...styles,
    }}
  >
    <MyIcon icon={icon} family={family} size={size} color={"white"} />
  </div>
);

export default IconItem;
