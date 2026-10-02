import { currencyFormat } from "../utils/amountFormat";
import { HIDDEN_STYLE, SR_ONLY, useAmountBlur } from "../utils/blur";
import { useT } from "../i18n";

// Re-exported so the components that already import it from here keep working;
// the formatting itself lives in utils/amountFormat, which knows the language
// and the wallet's currency.
export { currencyFormat };

// Wraps anything that reads as money so it obeys bank mode. For the amounts
// that are not drawn by <Amount> -- the account picker's balance pill, the
// snapshot detail, the portfolio list -- where the surrounding layout is
// already built and only the number needs hiding.
export const Blurrable = ({ children, style }) => {
  const hidden = useAmountBlur();
  const { t } = useT();

  if (!hidden) return children;

  return (
    <>
      <span aria-hidden="true" style={{ ...HIDDEN_STYLE, ...style }}>
        {children}
      </span>
      <span style={SR_ONLY}>{t("blur.hidden")}</span>
    </>
  );
};

// formatAmount comes from the context rather than importing currencyFormat
// directly: reading the context is what subscribes this component to the
// language and to the wallet's currency, so changing either re-renders every
// amount on screen. Calling the module function alone left the numbers in the
// old language until something unrelated happened to re-render them, and the
// currency has exactly the same problem the moment somebody switches wallet.
//
// noSymbol was called isNotEuroSign, which was true only of an application
// that could count in one currency. It says what it now means: print the
// digits without the unit. The calculator uses it for every operand but the
// last, where the expression already carries one symbol at the end.
const Amount = ({ size, amount, color, isAbs, noSymbol, isString, forceSign }) => {
  const { t, formatAmount, formatPlainAmount } = useT();
  const hidden = useAmountBlur();

  if ((!amount || isNaN(amount) || amount.length === 0) && !isString) amount = 0;
  if (!isString && Math.abs(Number(amount)) < 0.005) amount = 0;
  if (isAbs && amount < 0 && !isString) amount *= -1;

  const finalColor = color ? color : amount < 0 ? "var(--negative)" : "var(--positive)";

  // The sizes arrive as numbers meant for a wide layout. On narrow screens they
  // stayed put and the amounts wrapped: scale them with the width, stopping at
  // the nominal size above ~600px.
  const fontSize =
    typeof size === "number"
      ? `clamp(${(size * 0.72).toFixed(1)}px, ${(size / 6).toFixed(2)}vw, ${size}px)`
      : size;

  const text = isString ? amount : noSymbol ? formatPlainAmount(amount) : formatAmount(amount);

  const body = (
    <>
      {forceSign && amount > 0 ? "+" : ""} {text}
    </>
  );

  return (
    <div
      style={{
        fontWeight: "bold",
        fontSize,
        color: finalColor,
        // Intl puts the symbol before the digits in some languages and after
        // them in others, and either way it is separated by a space: without
        // this the symbol ends up alone on a line of its own.
        whiteSpace: "nowrap",
      }}
    >
      {hidden ? (
        <>
          <span aria-hidden="true" style={HIDDEN_STYLE}>
            {body}
          </span>
          <span style={SR_ONLY}>{t("blur.hidden")}</span>
        </>
      ) : (
        body
      )}
    </div>
  );
};

export default Amount;
