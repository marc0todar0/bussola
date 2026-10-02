import { Icon } from "@iconify/react";
import { getIconPrefix } from "../utils/generic";

const MyIcon = ({ icon, family, size = 30, color = "white" }) => (
  <Icon icon={`${getIconPrefix(family)}:${icon}`} width={size} height={size} color={color} />
);

export default MyIcon;
