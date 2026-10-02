import React from "react";

export default function Loading() {
  return (
    <div style={styles.container}>
      <div style={styles.spinner}></div>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    height: "100vh",
  },
  spinner: {
    width: "30px",
    height: "30px",
    border: "4px solid var(--border)",
    borderTop: "4px solid var(--accent)",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
  },
};

// Add this keyframe globally in your main CSS file or in a CSS-in-JS solution:
const styleSheet = document.styleSheets[0];
styleSheet.insertRule(`
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
`, styleSheet.cssRules.length);
