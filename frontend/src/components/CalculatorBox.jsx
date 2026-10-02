import { useState } from "react";

// hoverStyle: for buttons with a palette of their own (Close, say). Without
// it boxHover's backgroundColor would win over the style passed in, since it
// comes later in the spread, and the button would turn grey on hover.
const CalculatorBox = ({ text, onClick, children, style, hoverStyle }) => {
  const [isHovered, setHovered] = useState(false);
  const [isPressed, setPressed] = useState(false);

  return (
    <div
      onClick={onClick}
      style={{
        ...styles.box,
        ...style,
        ...(isHovered && (hoverStyle || styles.boxHover)),
        ...(isPressed && styles.boxActive),
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
    >
      {children ? children : <div style={styles.textBox}>{text}</div>}
    </div>
  );
};

export default CalculatorBox;

const styles = {
  box: {
    flex: 1,
    height: 30,
    margin: 4,
    borderRadius: 12,
    backgroundColor: "var(--surface-2)",
    border: "1px solid var(--border-strong)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    fontSize: 20,
    fontWeight: "500",
    color: "var(--text)", // dark gray
    cursor: "pointer",
    boxShadow: "0 2px 6px rgba(0, 0, 0, 0.05)",
    transition: "all 0.15s ease-in-out",
  },

  boxHover: {
    backgroundColor: "var(--surface-hover)", // subtle blue-gray hover
  },

  boxActive: {
    transform: "scale(0.97)",
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.1)",
  },
  textBox: {
    fontSize: 20,
  },
};
