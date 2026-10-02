import React, { useState } from "react";
import { FiChevronLeft, FiChevronRight } from "react-icons/fi";
import { mainColor } from "../config";

export default function ArrowButton({ direction = "left", onClick, size = 36 }) {
  const [hover, setHover] = useState(false);
  const Icon = direction === "left" ? FiChevronLeft : FiChevronRight;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: `2px solid ${mainColor}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        backgroundColor: hover ? mainColor : "transparent",
        transition: "background-color 0.2s, transform 0.15s",
        transform: hover ? "scale(1.1)" : "scale(1)",
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      <Icon size={size * 0.55} color={hover ? "white" : mainColor} style={{ transition: "color 0.2s" }} />
    </div>
  );
}
