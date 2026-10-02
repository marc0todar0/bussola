import IconItem from "./IconItem";
import Amount from "./Amount";

const CategoryCard = ({ category, handleTouch, isExpenses }) => {
  const { name, sum, color, icon, icon_family } = category;

  return (
    <div
      data-nav-row
      onClick={() => handleTouch(category)}
      style={{ ...styles.container, borderWidth: 2, borderColor: color, borderRadius: 10 }}
    >
      <IconItem icon={icon} family={icon_family} color={color} />
      <div
        style={{
          borderBottomColor: "var(--border-card)",
          padding: 10,
          margin: "0 auto",
          flex: 1,
          flexDirection: "column",
          justifyContent: "flex-start",
          alignItems: "flex-start",
          display: "flex",
        }}
      >
        <div style={{ fontSize: 20 }}>{name}</div>
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            justifyContent: "space-between",
            width: "90%",
          }}
        >
          <Amount size={20} amount={isExpenses ? -sum : sum} />
        </div>
      </div>
    </div>
  );
};

export default CategoryCard;

const styles = {
  container: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "flex-start",
    alignItems: "center",
    margin: 20,
    padding: 10,
    border: "1px solid var(--border-card)",
    borderRadius: 10,
    cursor: "pointer",
  },
};
