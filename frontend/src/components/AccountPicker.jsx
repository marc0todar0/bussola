import { forwardRef, useImperativeHandle, useRef } from "react";
import MyIcon from "./MyIcon";
import Select from "react-select";
import { Blurrable, currencyFormat } from "./Amount";
import { selectTheme } from "../utils/theme";
import { useT } from "../i18n";

const AccountPicker = forwardRef((props, ref) => {
  const { t } = useT();
  const {
    isAccount,
    isFrom,
    arrayPicker,
    currentId,
    setCurrentId,
    onUseAmount,
    shortcutHint,
    isOpen = false,
    onOpenChange,
  } = props;
  const selectRef = useRef(null);

  useImperativeHandle(ref, () => ({
    open: () => {
      onOpenChange?.(true);
      selectRef.current?.focus();
    },
  }), [onOpenChange]);

  const current = arrayPicker.find((k) => k.id == currentId);
  if (!current) return null;
  const { id, name, color, icon, amount, icon_family } = current;

  const handleChange = (k) => {
    setCurrentId(k.value);
    // Same exit as Escape: close the menu and drop the focus, so the keyboard
    // goes straight back to the keypad instead of staying trapped in the select
    // (with the focus in here isKeyTargetBusy blocks the global shortcuts).
    onOpenChange?.(false);
    selectRef.current?.blur();
  };

  return (
    <div style={{ ...styles.fromToView, backgroundColor: color }}>
      <div style={styles.fromToViewButton}>
        <Select
          ref={selectRef}
          // The field sits on the account's own colour, but its menu drops
          // over the form below: both follow the theme through the tokens.
          theme={selectTheme}
          options={arrayPicker.map((item) => ({
            value: item.id,
            label: item.name,
          }))}
          placeholder={isAccount ? t("picker.chooseAccount") : t("picker.chooseCategory")}
          onChange={(e) => handleChange(e)}
          onKeyDown={(e) => {
            // Escape leaves the select (closes the menu, drops the focus)
            // without closing the form: the keyboard goes back to the keypad.
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onOpenChange?.(false);
              selectRef.current?.blur();
            }
          }}
          value={{ value: id, label: name }}
          // Menu controlled by the parent: one piece of state for the two
          // selects, so "From" and "To" cannot both be open. No openMenuOnFocus,
          // which made "From" open by itself when the modal took the focus.
          menuIsOpen={isOpen}
          onMenuOpen={() => onOpenChange?.(true)}
          onMenuClose={() => onOpenChange?.(false)}
        />

        <div style={{ maxWidth: "90%" }}>
          <div style={styles.fromToDescribtion}>
            {isFrom
              ? isAccount ? t("picker.fromAccount") : t("picker.fromCategory")
              : isAccount ? t("picker.toAccount") : t("picker.toCategory")}
            {shortcutHint && (
              <span className="kbd-hint" style={styles.hint}>{shortcutHint}</span>
            )}
          </div>
          <div style={styles.fromToName}>{name}</div>
          {isAccount && onUseAmount && (
            <div
              onClick={() => onUseAmount(amount)}
              title={t("picker.useBalance")}
              style={styles.balancePill}
            >
              {/* Visible without any hovering, so bank mode has to reach it:
                  a balance you can read at a glance is exactly the kind this
                  feature exists to cover. */}
              <Blurrable>{currencyFormat(amount)}</Blurrable>
            </div>
          )}
        </div>
        <div style={styles.iconContainer}>
          <MyIcon icon={icon} family={icon_family} size={30} color={"white"} />
        </div>
      </div>
    </div>
  );
});

AccountPicker.displayName = "AccountPicker";

const styles = {
  fromToView: {
    flex: 1,
    flexDirection: "row",
    minWidth: 0,
  },
  fromToViewButton: {
    flex: 1,
    paddingHorizontal: 20,
    paddingVertical: 10,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  fromToName: {
    color: "white",
    fontWeight: "bold",
    // at a fixed 25px a name like "Banca Cartesio" wrapped on narrow screens
    fontSize: "clamp(16px, 5.2vw, 25px)",
    lineHeight: 1.2,
  },
  fromToDescribtion: {
    color: "white",
    fontSize: "clamp(12px, 3.6vw, 15px)",
  },
  iconContainer: {
    justifyContent: "center",
    alignItems: "center",
  },
  balancePill: {
    display: "inline-block",
    marginTop: 4,
    padding: "2px 8px",
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.25)",
    color: "white",
    fontSize: 13,
    fontWeight: "bold",
    cursor: "pointer",
    userSelect: "none",
  },
  hint: {
    marginLeft: 6,
    padding: "0 5px",
    borderRadius: 4,
    backgroundColor: "rgba(255,255,255,0.3)",
    fontSize: 11,
    fontFamily: "monospace",
  },
};

export default AccountPicker;
