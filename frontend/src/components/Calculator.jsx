import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  forwardRef,
  useImperativeHandle,
} from "react";

import { mainColor, secondaryColor } from "../config";
import CalculatorBox from "./CalculatorBox";
import Amount from "./Amount";
import { useT } from "../i18n";
import { evaluate } from "../utils/arithmetic";
import toast from "react-hot-toast";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import { FaTrash } from "react-icons/fa";
import { isKeyTargetBusy } from "../utils/useKeyboardShortcut";

const Calculator = forwardRef(({
  color,
  note,
  setNote,
  val,
  setVal,
  date,
  setDate,
  isToday,
  submit,
  closeForm,
  onDelete,
  busy = false,
}, ref) => {
  const { t, monthName } = useT();
  const [expression, setExpression] = useState();
  const [isImportValid, setIsImportValid] = useState();
  const [isSubmit, setIsSubmit] = useState(false);
  const noteRef = useRef(null);
  const dateRef = useRef(null);
  useEffect(() => {
    checkNewExpression(val);
  }, []);

  const checkNewExpression = useCallback((newExpr) => {
    if (newExpr && !isNaN(newExpr)) {
      setIsImportValid(true);
    } else {
      setIsImportValid(false);
    }
    setExpression(newExpr);
  }, []);

  // Moves the date by n days.
  const shiftDate = useCallback(
    (days) => {
      const d = new Date(date);
      d.setDate(d.getDate() + days);
      setDate(d);
    },
    [date, setDate]
  );

  // When the calendar closes (Esc, Enter, a click on a day) react-datepicker
  // puts the focus back on the input asynchronously, leaving the keyboard
  // trapped there. Drop the focus at once, and again when the library refocuses.
  const handleCalendarClose = useCallback(() => {
    const input = dateRef.current?.input;
    if (!input) return;
    const dropFocus = () => input.blur();
    input.addEventListener("focus", dropFocus, { once: true });
    setTimeout(() => input.removeEventListener("focus", dropFocus), 300);
    input.blur();
  }, []);

  // The API the form uses: load an amount (an account balance, say) and put
  // the focus on the note field.
  useImperativeHandle(ref, () => ({
    setAmount: (n) => {
      const num = Math.abs(Number(n));
      if (!Number.isFinite(num)) return;
      checkNewExpression(num.toFixed(2));
    },
    focusNote: () => noteRef.current?.focus(),
  }));

  // busy: the form is still saving the last GO. The form refuses a second
  // save on its own as well; this keeps GO and Enter from even asking.
  const handleSubmit = useCallback(() => {
    if (!isImportValid || busy) return;
    setVal(new Number(expression).toFixed(2).toString());
    setIsSubmit(true);
  }, [isImportValid, expression, busy]);

  const handleNewChar = useCallback(
    (char) => {
      let newExpr = new String(expression);
      const valid = checkIfIsValidNewChar(newExpr, char);
      if (!valid) return;
      if (valid === "replace") {
        const toConcat = new String(char).toString();
        newExpr = newExpr.substring(0, newExpr.length - 1);
        newExpr = newExpr.concat(toConcat);
      } else if (char === "<-") {
        newExpr = newExpr.substring(0, newExpr.length - 1);
      } else if (char === "=") {
        //console.log(newExpr);
        try {
          const newExpression = evaluate(newExpr.toString());
          //console.log("EVALUATE EXPRESSION:", newExpression);
          newExpr = newExpression;
          if (new Number(newExpression) < 0) {
            checkNewExpression(null);
            toast.error(t("calc.negative"));
            return;
          }
        } catch {
          toast.error(t("calc.invalid"));
        }
      } else {
        // DEFAULT
        //console.log("EXPRESSION:", expression, char);
        const toConcat = new String(char).toString();
        if (!expression) newExpr = toConcat;
        else {
          newExpr = newExpr.concat(toConcat);
        }
      }
      checkNewExpression(newExpr);
    },
    [expression]
  );

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (isKeyTargetBusy(event.target)) return;
      const digits = ["0","1","2","3","4","5","6","7","8","9"];
      const ops = ["+", "-", "*", "/"];
      if (digits.includes(event.key) || ops.includes(event.key) || event.key === ".") {
        event.preventDefault();
        handleNewChar(event.key);
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (isImportValid) handleSubmit();
        else handleNewChar("=");
      } else if (event.key === "Backspace") {
        event.preventDefault();
        handleNewChar("<-");
      } else if (event.key === "Delete") {
        event.preventDefault();
        checkNewExpression("0");
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeForm();
      } else if (event.key === "n" || event.key === "N") {
        event.preventDefault();
        noteRef.current?.focus();
      } else if (event.key === "g" || event.key === "G") {
        event.preventDefault();
        dateRef.current?.setFocus();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        shiftDate(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        shiftDate(1);
      } else if (event.key === "o" || event.key === "O") {
        event.preventDefault();
        setDate(new Date());
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    handleNewChar,
    handleSubmit,
    isImportValid,
    checkNewExpression,
    closeForm,
    shiftDate,
    setDate,
  ]);

  const checkIfIsValidNewChar = (exp, c) => {
    exp = new String(exp);
    if (isOperation(c)) {
      if (!exp || exp.length == 0) return false;
      if (isOperation(exp.charAt(exp.length - 1))) return "replace";
    } else if (c === ".") {
      if (!exp || exp.length == 0) return false;
      if (isOperation(exp.charAt(exp.length - 1))) return false;
      if (exp.charAt(exp.length - 1) === ".") return false;

      const piu = exp.lastIndexOf("+");
      const per = exp.lastIndexOf("*");
      const meno = exp.lastIndexOf("-");
      const div = exp.lastIndexOf("/");

      const lastIndex = Math.max(piu, per, meno, div);
      const lastNumber = "" + exp.substring(lastIndex + 1, exp.length);
      //console.log(lastNumber, typeof lastNumber, lastNumber.search(/\./));
      if (lastNumber.search(/\./) != -1) return false;
    } else if (isDigit(c)) {
      //check the number
      const piu = exp.lastIndexOf("+");
      const per = exp.lastIndexOf("*");
      const meno = exp.lastIndexOf("-");
      const div = exp.lastIndexOf("/");

      const lastIndex = Math.max(piu, per, meno, div);
      const lastNumber = exp.substring(lastIndex + 1, exp.length);
      const [int, dec] = lastNumber.split(".");
      //console.log(int, dec);
      if (dec && dec.length == 2) {
        return false;
      }
      //console.log("int", int, dec, lastNumber, lastNumber.search(/\./));
      if (int && lastNumber.search(/\./) === -1 && int.length > 8) return false;
    }
    return true;
  };

  const isOperation = (c) => {
    if (c === "+" || c === "-" || c === "*" || c === "/") {
      return true;
    }
    return false;
  };

  const isDigit = (c) => {
    if (
      c === "0" ||
      c === "1" ||
      c === "2" ||
      c === "3" ||
      c === "4" ||
      c === "5" ||
      c === "6" ||
      c === "7" ||
      c === "8" ||
      c === "9"
    ) {
      return true;
    }
    return false;
  };

  const splitExperssionOnOperations = () => {
    const array = [];
    let currentNumber = "";
    if (!expression) return [];
    let stringToIter = new String(expression);
    let i = 0;
    for (const c of stringToIter) {
      if (isOperation(c)) {
        array.push({ key: i++, value: currentNumber });
        currentNumber = "";
        array.push({ isOp: true, value: c, key: i++ });
      } else {
        currentNumber = currentNumber.concat(c);
      }
    }
    if (currentNumber) {
      array.push({ key: i++, value: currentNumber });
    }
    //console.log("ARRAY:", array);
    return array;
  };

  useEffect(() => {
    if (isSubmit) {
      submit();
      setIsSubmit(false);
    }
  }, [isSubmit]);


  return (
    <div style={{ flex: 1, width: "100%" }}>
      <div
        style={{
          height: 60,
          borderBottomWidth: 1,
          borderColor: secondaryColor,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          flexDirection: "row",
        }}
      >
        {splitExperssionOnOperations().map((k, i) => {
          //console.log(k);
          return (
            <Amount
              key={k.key}
              amount={k.value}
              isAbs={true}
              color={isImportValid ? color : "var(--text)"}
              size={30}
              noSymbol={i == splitExperssionOnOperations().length - 1 ? false : true}
              isString={k.isOp}
            />
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "12px",
          padding: "12px 0",
        }}
      >
        {/* Campo note */}
        <input
          ref={noteRef}
          onKeyDown={(e) => {
            // Escape / Enter leave the field without closing the form
            if (e.key === "Escape" || e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              e.target.blur();
            }
          }}
          style={{
            width: "100%",
            maxWidth: "500px",
            padding: "12px 16px",
            fontSize: "16px",
            borderRadius: "10px",
            border: "1px solid var(--border-strong)",
            boxShadow: "var(--shadow-sm)",
            outline: "none",
            transition: "border 0.2s ease",
          }}
          onFocus={(e) => (e.target.style.border = "1px solid var(--accent)")}
          onBlur={(e) => (e.target.style.border = "1px solid var(--border-strong)")}
          onChange={(k) => setNote(k.target.value)}
          value={note}
          placeholder={t("calc.notePlaceholder")}
        />

        {/* Data + Oggi */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            fontSize: "16px",
            color: "var(--text)",
          }}
        >
          <DatePicker
            ref={dateRef}
            selected={date}
            onChange={(date) => {
              if (!date) return;
              setDate(date);
            }}
            onCalendarClose={handleCalendarClose}
            onFocus={(e) => (e.target.style.border = "1px solid var(--accent)")}
            onBlur={(e) => (e.target.style.border = "1px solid var(--border-strong)")}
            popperPlacement="bottom"
            customInput={
              <input
                style={{
                  padding: "10px 14px",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "10px",
                  fontSize: "15px",
                  textAlign: "center",
                  boxShadow: "var(--shadow-sm)",
                  outline: "none",
                }}
              />
            }
          />
          <div>
            {isToday && (
              <span style={{ color: "var(--accent)", fontWeight: 600 }}>{t("calc.today")}, </span>
            )}
            {date.getDate()} {monthName(date.getMonth() + 1)}{" "}
            {date.getFullYear()}
            <span
              className="kbd-hint"
              style={{ marginLeft: 8, fontSize: 12, color: "var(--text-subtle)" }}
              title={t("calc.dateHint")}
            >
              G ←/→ O
            </span>
          </div>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              title={t("calc.deleteTransaction")}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "10px",
                border: "1px solid var(--negative-fill)",
                borderRadius: "10px",
                backgroundColor: "var(--surface)",
                color: "var(--negative-fill)",
                cursor: "pointer",
                boxShadow: "var(--shadow-sm)",
              }}
            >
              <FaTrash size={16} />
            </button>
          )}
        </div>
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "row",
          textAlign: "center",
        }}
      >
        <div style={{ flex: 1 }}>
          <CalculatorBox text="+" onClick={() => handleNewChar("+")} />
          <CalculatorBox text="-" onClick={() => handleNewChar("-")} />
          <CalculatorBox text="*" onClick={() => handleNewChar("*")} />
          <CalculatorBox text="/" onClick={() => handleNewChar("/")} />
        </div>
        <div style={{ flex: 3, display: "flex", flexDirection: "row" }}>
          <div style={{ flex: 1 }}>
            <CalculatorBox text="7" onClick={() => handleNewChar("7")} />
            <CalculatorBox text="4" onClick={() => handleNewChar("4")} />
            <CalculatorBox text="1" onClick={() => handleNewChar("1")} />
            <CalculatorBox
              text={t("common.close")}
              onClick={() => closeForm()}
              style={styles.close}
              hoverStyle={styles.closeHover}
            />
          </div>
          <div style={{ flex: 1 }}>
            <CalculatorBox text="8" onClick={() => handleNewChar("8")} />
            <CalculatorBox text="5" onClick={() => handleNewChar("5")} />
            <CalculatorBox text="2" onClick={() => handleNewChar("2")} />
            <CalculatorBox text="0" onClick={() => handleNewChar("0")} />
          </div>
          <div style={{ flex: 1 }}>
            <CalculatorBox text="9" onClick={() => handleNewChar("9")} />
            <CalculatorBox text="6" onClick={() => handleNewChar("6")} />
            <CalculatorBox text="3" onClick={() => handleNewChar("3")} />
            <CalculatorBox text="." onClick={() => handleNewChar(".")} />
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <CalculatorBox text="<-" onClick={() => handleNewChar("<-")} />
          <CalculatorBox
            text={t("calc.clear")}
            onClick={() => {
              setExpression("0");
              setIsImportValid(true);
            }}
          />
          <CalculatorBox
            style={{
              flex: 2,
              backgroundColor: isImportValid ? mainColor : secondaryColor,
              ...(busy && { opacity: 0.5, cursor: "wait" }),
            }}
          >
            <div
              style={{}}
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return;
                if (isImportValid) {
                  return handleSubmit();
                }
                handleNewChar("=");
              }}
            >
              <div style={{ ...styles.textBox, color: "white" }}>
                {isImportValid && "GO"}
                {!isImportValid && "="}
              </div>
            </div>
          </CalculatorBox>
        </div>
      </div>
    </div>
  );
});

Calculator.displayName = "Calculator";

export default Calculator;

const styles = {
  box: {
    borderWidth: 0.5,
    borderColor: secondaryColor,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
  },
  textBox: {
    fontSize: 20,
  },
  // Close: the only non-numeric key in the middle of the keypad, so it used to
  // get lost among the others. Solid slate rather than near-white: it stands
  // out at a glance yet stays a secondary action, below the blue GO.
  close: {
    backgroundColor: "var(--key-muted-bg)",
    borderColor: "var(--key-muted-border)",
    color: "var(--key-muted-text)",
    fontSize: 16,
    fontWeight: 600,
    letterSpacing: 0.3,
  },
  closeHover: {
    backgroundColor: "var(--key-muted-bg-hover)",
    borderColor: "var(--key-muted-border-hover)",
    color: "var(--key-muted-text-hover)",
  },
};
