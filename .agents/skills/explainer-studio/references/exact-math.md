# Exact math: integers and rationals, never a float on screen

Every number a learner reads comes from this module. Floats may move meshes; they never reach a readout.

## Rules

1. **Counts are integers. Ratios are rationals.** Use `BigInt` (or integers you have proved stay below
   `Number.MAX_SAFE_INTEGER`) for numerator and denominator.
2. **Normalize on construction:** reduce by gcd, keep the sign on the numerator, refuse a zero denominator.
3. **Compare by cross-multiplication**, never by converting to a decimal.
4. **Common denominators use the lcm**, so a worked example shows the smallest one a person would choose.
5. **Decimals are derived exactly** from the rational. A denominator whose only prime factors are 2 and 5
   terminates; anything else repeats, and the repeating block is marked.
6. **Rounding is visible.** A rounded value is shown with an approximately-equals sign and its precision
   ("about 3.14, to 2 decimal places"). Measured real-world constants carry units and a source in the
   write-up.
7. **Money is integer cents.**
8. **Animation may use floats** (positions, easing), but the value it animates TO comes from this module.

## An original rational module (`math.js`)

```js
// math.js: pure, no DOM, no three. Exact arithmetic for readouts and worked examples.
const abs = (a) => (a < 0n ? -a : a);

export function gcd(a, b) {
  a = abs(a); b = abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}
export function lcm(a, b) {
  return a === 0n || b === 0n ? 0n : abs((a / gcd(a, b)) * b);
}

export class Q {
  constructor(n, d = 1n) {
    n = BigInt(n); d = BigInt(d);
    if (d === 0n) throw new RangeError('denominator is zero');
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d); // never 0 because d is not 0
    this.n = n / g;
    this.d = d / g;
    Object.freeze(this);
  }
  static of(n, d = 1n) { return new Q(n, d); }
  add(o) { return new Q(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Q(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Q(this.n * o.n, this.d * o.d); }
  div(o) {
    if (o.n === 0n) throw new RangeError('division by zero');
    return new Q(this.n * o.d, this.d * o.n);
  }
  cmp(o) {
    const l = this.n * o.d, r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  eq(o) { return this.n === o.n && this.d === o.d; }
  /** Whole part plus a proper fraction. BigInt division truncates toward zero, so the sign is kept apart. */
  toMixed() {
    const whole = this.n / this.d;
    const rest = abs(this.n - whole * this.d);
    return { negative: this.n < 0n, whole: abs(whole), num: rest, den: this.d };
  }
  toString() { return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`; }
  toTex() {
    if (this.d === 1n) return `${this.n}`;
    const m = this.toMixed();
    const sign = m.negative ? '-' : '';
    if (m.whole === 0n) return `${sign}\\tfrac{${m.num}}{${m.den}}`;
    return m.num === 0n ? `${sign}${m.whole}` : `${sign}${m.whole}\\,\\tfrac{${m.num}}{${m.den}}`;
  }
}

/** Scale a fraction to an equivalent one with denominator `to` (it must be a multiple of the reduced one). */
export function expandTo(q, to) {
  to = BigInt(to);
  if (to % q.d !== 0n) return null;
  const k = to / q.d;
  return { num: q.n * k, den: to, factor: k }; // deliberately NOT reduced: this is the "re-slice" view
}

/** Exact decimal digits: { negative, whole, fixed, repeat, truncated }. */
export function decimalParts(q, maxDigits = 60) {
  const negative = q.n < 0n;
  const n = abs(q.n), d = q.d;
  const whole = n / d;
  let r = n % d;
  const digits = [];
  const seen = new Map(); // remainder -> digit index where it first appeared
  while (r !== 0n && !seen.has(r) && digits.length < maxDigits) {
    seen.set(r, digits.length);
    r *= 10n;
    digits.push(r / d);
    r %= d;
  }
  if (r === 0n) return { negative, whole, fixed: digits.join(''), repeat: '', truncated: false };
  if (seen.has(r)) {
    const at = seen.get(r);
    return { negative, whole, fixed: digits.slice(0, at).join(''), repeat: digits.slice(at).join(''), truncated: false };
  }
  return { negative, whole, fixed: digits.join(''), repeat: '', truncated: true };
}

/** "0.1(6)" for 1/6, "0.75" for 3/4, "\u2248 0.0588..." when the period is longer than maxDigits. */
export function formatDecimal(q, maxDigits = 60) {
  const p = decimalParts(q, maxDigits);
  const sign = p.negative ? '-' : '';
  const frac = p.fixed + (p.repeat ? `(${p.repeat})` : '');
  const body = frac ? `${sign}${p.whole}.${frac}` : `${sign}${p.whole}`;
  return p.truncated ? `\u2248 ${body}...` : body;
}

/** True when n/d has a terminating decimal (reduced denominator has only 2s and 5s). */
export function terminates(q) {
  let d = q.d;
  while (d % 2n === 0n) d /= 2n;
  while (d % 5n === 0n) d /= 5n;
  return d === 1n;
}

/** Digit-by-digit long division for non-negative integers: Divide, Multiply, Subtract, Bring down. */
export function longDivision(dividend, divisor) {
  dividend = BigInt(dividend); divisor = BigInt(divisor);
  if (divisor <= 0n || dividend < 0n) throw new RangeError('needs dividend >= 0 and divisor > 0');
  const digits = dividend.toString().split('').map((c) => BigInt(c));
  const steps = [];
  let rem = 0n;
  let quotient = 0n;
  for (let i = 0; i < digits.length; i++) {
    const current = rem * 10n + digits[i]; // bring down
    const q = current / divisor;           // divide
    const product = q * divisor;           // multiply
    rem = current - product;               // subtract
    quotient = quotient * 10n + q;
    steps.push({ index: i, broughtDown: digits[i], current, q, product, remainder: rem });
  }
  return { quotient, remainder: rem, steps, check: quotient * divisor + rem === dividend };
}

export const SELF_TESTS = [
  ['1/2 + 1/3 = 5/6', () => Q.of(1, 2).add(Q.of(1, 3)).toString() === '5/6'],
  ['6/8 reduces to 3/4', () => Q.of(6, 8).toString() === '3/4'],
  ['2/4 equals 1/2', () => Q.of(2, 4).eq(Q.of(1, 2))],
  ['-3/-6 is 1/2', () => Q.of(-3, -6).toString() === '1/2'],
  ['7/3 is 2 1/3', () => { const m = Q.of(7, 3).toMixed(); return m.whole === 2n && m.num === 1n && m.den === 3n; }],
  ['-7/2 is -3 1/2', () => { const m = Q.of(-7, 2).toMixed(); return m.negative && m.whole === 3n && m.num === 1n; }],
  ['3/5 < 2/3', () => Q.of(3, 5).cmp(Q.of(2, 3)) === -1],
  ['lcm(4, 6) = 12', () => lcm(4n, 6n) === 12n],
  ['3/4 as twelfths is 9/12', () => { const e = expandTo(Q.of(3, 4), 12); return e && e.num === 9n && e.den === 12n; }],
  ['1/6 = 0.1(6)', () => formatDecimal(Q.of(1, 6)) === '0.1(6)'],
  ['3/4 = 0.75', () => formatDecimal(Q.of(3, 4)) === '0.75'],
  ['1/7 = 0.(142857)', () => formatDecimal(Q.of(1, 7)) === '0.(142857)'],
  ['1/8 terminates, 1/12 does not', () => terminates(Q.of(1, 8)) && !terminates(Q.of(1, 12))],
  ['156 / 12 = 13 R 0', () => { const r = longDivision(156n, 12n); return r.quotient === 13n && r.remainder === 0n && r.check; }],
  ['1000 / 7 = 142 R 6', () => { const r = longDivision(1000n, 7n); return r.quotient === 142n && r.remainder === 6n && r.check; }],
];

/** Names of failing self-tests; an empty array means every check passed. */
export function runSelfTests() {
  return SELF_TESTS.filter(([, check]) => !check()).map(([name]) => name);
}
```

## Running the self-tests

- In the page: when the URL has `?selftest`, call `runSelfTests()` at startup and, if anything fails, show
  the failing names in the console panel AND `console.error` them, so the verification run fails loudly.
- Under Bun:

```js
// math.test.js
import { expect, test } from 'bun:test';
import { runSelfTests } from './math.js';

test('exact math self-tests', () => {
  expect(runSelfTests()).toEqual([]);
});
```

## Showing the math

- Inline fractions without a math library: a small stacked-fraction element (`<span class="frac"><span>3</span><span>4</span></span>`)
  styled with CSS keeps the page tiny.
- If the plan needs typeset formulas, vendor KaTeX locally (script, CSS, and only the fonts you use) and count
  it against the transfer budget; render with `throwOnError: false` and treat any render error as a console
  error to fix.
- Long division: show each `steps[i]` in sync with the scene (Divide, Multiply, Subtract, Bring down), then
  the check line `quotient x divisor + remainder = dividend` computed by the module, never typed by hand.
