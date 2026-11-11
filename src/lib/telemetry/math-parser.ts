type Node =
  | { kind: 'number'; value: number }
  | { kind: 'channel'; name: string }
  | { kind: 'negate'; operand: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] };

const binding: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 4 };
const functions: Record<string, number> = { sqrt: 1, abs: 1, min: 2, max: 2, filter: 2 };
export const MATH_CHANNEL_INPUTS = ['gLong', 'gLat', 'v', 's', 'slipRatio', 'throttle', 'gripUsage', 'understeerAngle'] as const;
type ChannelName = (typeof MATH_CHANNEL_INPUTS)[number];
export type MathChannelInputs = Partial<Record<ChannelName, ArrayLike<number>>>;

export function compileMathChannel(source: string) {
  if (source.length > 512) throw new SyntaxError('Expressions are limited to 512 characters.');
  const tokens = Array.from(source.matchAll(/\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z][A-Za-z0-9_]*|[^\s]/g))
    .filter(([token]) => token.trim());
  let position = 0;
  const peek = () => tokens[position]?.[0];
  const take = () => tokens[position++]?.[0];
  const error = (message: string) => new SyntaxError(`${message} (column ${(tokens[position - 1]?.index ?? 0) + 1})`);
  function parse(minBinding: number, depth: number): Node {
    if (depth > 64) throw error('Expression nesting is too deep');
    const token = take();
    let node: Node;
    if (token === '+' || token === '-') {
      const operand = parse(3, depth + 1);
      node = token === '-' ? { kind: 'negate', operand } : operand;
    } else if (token === '(') {
      node = parse(0, depth + 1);
      if (take() !== ')') throw error('Expected closing parenthesis');
    } else if (token && /^[\d.]/.test(token) && Number.isFinite(Number(token))) {
      node = { kind: 'number', value: Number(token) };
    } else if (token && Object.hasOwnProperty.call(functions, token)) {
      if (take() !== '(') throw error(`Expected '(' after ${token}`);
      const args = [parse(0, depth + 1)];
      while (peek() === ',') {
        take();
        args.push(parse(0, depth + 1));
      }
      if (take() !== ')' || args.length !== functions[token]) throw error(`${token} expects ${functions[token]} arguments`);
      if (token === 'filter' && (args[1].kind !== 'number' || !Number.isInteger(args[1].value) || args[1].value < 1 || args[1].value > 10000)) {
        throw error('Filter window must be a whole number from 1 to 10000 samples');
      }
      node = { kind: 'call', name: token, args };
    } else if (token && (MATH_CHANNEL_INPUTS as readonly string[]).includes(token)) {
      node = { kind: 'channel', name: token };
    } else {
      throw error(token ? `Unknown token '${token}'` : 'Expected a number, channel or function');
    }
    while (Object.hasOwnProperty.call(binding, peek()) && binding[peek()] >= minBinding) {
      const op = take();
      const right = parse(binding[op] + (op === '^' ? 0 : 1), depth + 1);
      node = { kind: 'binary', op, left: node, right };
    }
    return node;
  }

  const ast = parse(0, 0);
  if (peek() !== undefined) {
    const unexpected = take();
    throw error(`Unexpected token '${unexpected}'`);
  }
  return (inputs: MathChannelInputs, sampleCount: number) => {
    const samples = evaluate(ast, inputs, sampleCount);
    return Array.from(samples, (value) => Number.isFinite(value) ? value : null);
  };
}

function evaluate(node: Node, inputs: MathChannelInputs, count: number): Float64Array {
  if (node.kind === 'number') return new Float64Array(count).fill(node.value);
  if (node.kind === 'channel') {
    const values = inputs[node.name as ChannelName];
    return Float64Array.from({ length: count }, (_, i) => values?.[i] ?? NaN);
  }
  if (node.kind === 'negate') return evaluate(node.operand, inputs, count).map((v) => -v);
  if (node.kind === 'call') {
    const first = evaluate(node.args[0], inputs, count);
    if (node.name === 'abs') return first.map(Math.abs);
    if (node.name === 'sqrt') return first.map(Math.sqrt);
    if (node.name === 'filter') {
      const window = (node.args[1] as Extract<Node, { kind: 'number' }>).value;
      let sum = 0;
      let valid = 0;
      return first.map((v, i) => {
        if (Number.isFinite(v)) { sum += v; valid++; }
        const expired = first[i - window];
        if (Number.isFinite(expired)) { sum -= expired; valid--; }
        return valid > 0 ? sum / valid : NaN;
      });
    }
    const second = evaluate(node.args[1], inputs, count);
    const compare = node.name === 'min' ? Math.min : Math.max;
    return first.map((v, i) => compare(v, second[i]));
  }
  const left = evaluate(node.left, inputs, count);
  const right = evaluate(node.right, inputs, count);
  switch (node.op) {
    case '+': return left.map((v, i) => v + right[i]);
    case '-': return left.map((v, i) => v - right[i]);
    case '*': return left.map((v, i) => v * right[i]);
    case '/': return left.map((v, i) => v / right[i]);
    default: return left.map((v, i) => v ** right[i]);
  }
}
