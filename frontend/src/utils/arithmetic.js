// ---------------------------------------------------------------------------
// The calculator's arithmetic
// ---------------------------------------------------------------------------
// The keypad in the transaction form builds expressions such as "12.50+7*3"
// and evaluates them on "=". That was mathjs.evaluate: a whole symbolic
// algebra system -- units, matrices, complex numbers, 650 KB of the bundle and
// a known prototype-pollution advisory -- for four operations. This is those
// four operations and nothing else.
//
// A recursive-descent parser over a closed grammar, so there is nothing it
// can be talked into doing:
//
//   expression := term (("+" | "-") term)*
//   term       := factor (("*" | "/") factor)*
//   factor     := ("+" | "-") factor | "(" expression ")" | number
//   number     := digits ["." digits] | "." digits
//
// No eval, no Function, no identifiers: any other character is an error. The
// usual precedence applies (7+2*3 is 13), a leading sign is allowed -- the
// keypad lets an expression start with one -- and parentheses are accepted
// although the keypad has no key for them.
//
// It throws on anything it cannot read, and on a result that is not a finite
// number (5/0), which the calculator reports as an invalid expression rather
// than submitting "Infinity" as an amount.

const MAX_DEPTH = 64; // nested signs and parentheses; the keypad makes none

export function evaluate(expression) {
  const src = String(expression ?? "").replace(/\s+/g, "");
  let pos = 0;

  const fail = () => {
    throw new Error(`Not a valid expression (at position ${pos + 1})`);
  };
  const isDigit = (c) => c !== undefined && c >= "0" && c <= "9";

  const number = () => {
    const start = pos;
    while (isDigit(src[pos])) pos++;
    if (src[pos] === ".") {
      pos++;
      while (isDigit(src[pos])) pos++;
    }
    const text = src.slice(start, pos);
    if (text === "" || text === ".") fail();
    return Number(text);
  };

  const factor = (depth) => {
    if (depth > MAX_DEPTH) fail();
    const c = src[pos];
    if (c === "+") {
      pos++;
      return factor(depth + 1);
    }
    if (c === "-") {
      pos++;
      return -factor(depth + 1);
    }
    if (c === "(") {
      pos++;
      const value = expr(depth + 1);
      if (src[pos] !== ")") fail();
      pos++;
      return value;
    }
    return number();
  };

  const term = (depth) => {
    let value = factor(depth);
    while (src[pos] === "*" || src[pos] === "/") {
      const op = src[pos++];
      const right = factor(depth);
      value = op === "*" ? value * right : value / right;
    }
    return value;
  };

  const expr = (depth) => {
    let value = term(depth);
    while (src[pos] === "+" || src[pos] === "-") {
      const op = src[pos++];
      const right = term(depth);
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };

  const value = expr(0);
  if (pos !== src.length) fail();
  if (!Number.isFinite(value)) throw new Error("The result is not a finite number");
  return value;
}
