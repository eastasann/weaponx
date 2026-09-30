/**
 * docs/06_design-tokens.json(DTCG 形式)から apps/web/src/styles/tokens.css を生成する(ADR-020)。
 * 実行は `make tokens`。semantic 層だけを書き出し、primitive はエイリアスの解決にだけ使う。
 */
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = resolve(root, "docs/06_design-tokens.json");
const output = resolve(root, "apps/web/src/styles/tokens.css");

type Json = { [key: string]: Json } | Json[] | string | number | boolean | null;
type Obj = { [key: string]: Json };

const doc = (await Bun.file(source).json()) as Obj;

const isObj = (v: Json | undefined): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function lookup(path: string): Json {
  let node: Json = doc;
  for (const key of path.split(".")) {
    if (!isObj(node) || !(key in node)) throw new Error(`参照先が見つかりません: {${path}}`);
    node = node[key] as Json;
  }
  return node;
}

/** `{a.b.c}` を解いた `$value` を返す。値の中のエイリアスは呼び出し側が再帰で解く。 */
function resolveAlias(v: Json): Json {
  if (typeof v === "string" && v.startsWith("{") && v.endsWith("}")) {
    const target = lookup(v.slice(1, -1));
    if (!isObj(target) || !("$value" in target)) {
      throw new Error(`トークンではありません: ${v}`);
    }
    return resolveAlias(target.$value as Json);
  }
  return v;
}

const resolved = (v: Json | undefined): Json => resolveAlias(v as Json);

function dimension(v: Json | undefined): string {
  const d = resolved(v);
  if (!isObj(d)) throw new Error("dimension が不正です");
  return `${d.value}${d.unit}`;
}

function color(v: Json | undefined): string {
  const c = resolved(v);
  if (!isObj(c) || typeof c.hex !== "string") throw new Error("color が不正です");
  if (typeof c.alpha !== "number" || c.alpha >= 1) return c.hex;
  const a = Math.round(c.alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${c.hex}${a}`;
}

function cubicBezier(v: Json | undefined): string {
  const b = resolved(v);
  if (!Array.isArray(b)) throw new Error("cubicBezier が不正です");
  return `cubic-bezier(${b.join(", ")})`;
}

function fontFamily(v: Json | undefined): string {
  const f = resolved(v);
  if (!Array.isArray(f)) throw new Error("fontFamily が不正です");
  return f.map((name) => (String(name).includes(" ") ? `"${name}"` : name)).join(", ");
}

function tokens(group: string): [string, Obj][] {
  const node = (doc.semantic as Obj)[group];
  if (!isObj(node)) throw new Error(`semantic.${group} がありません`);
  return Object.entries(node).filter(([k, v]) => !k.startsWith("$") && isObj(v)) as [string, Obj][];
}

const colorNode = (doc.semantic as Obj).color as Obj;
const colorEntries = (node: Json | undefined) =>
  Object.entries(node as Obj).filter(([k]) => !k.startsWith("$")) as [string, Obj][];
const lightColors = colorEntries(colorNode.light);
const darkColors = colorEntries(colorNode.dark);

const colorLines = (entries: [string, Obj][]) =>
  entries.map(([name, t]) => `  --token-color-${name}: ${color(t.$value)};`);

const common: string[] = [];
const utilities: string[] = [];

for (const [name, t] of tokens("typography")) {
  const v = t.$value as Obj;
  const lh = resolved(v.lineHeight);
  const weight = resolved(v.fontWeight);
  const vars = {
    "font-family": fontFamily(v.fontFamily),
    "font-size": dimension(v.fontSize),
    "font-weight": String(weight),
    "letter-spacing": dimension(v.letterSpacing),
    "line-height": String(lh),
  };
  for (const [prop, value] of Object.entries(vars)) {
    common.push(`  --typography-${name}-${prop}: ${value};`);
  }
  const ext = ((t.$extensions as Obj | undefined)?.["com.weaponx"] as Obj | undefined)
    ?.fontVariantNumeric;
  const rules = Object.keys(vars).map((prop) => `  ${prop}: var(--typography-${name}-${prop});`);
  if (typeof ext === "string") rules.push(`  font-variant-numeric: ${ext};`);
  utilities.push(`.typography-${name} {\n${rules.join("\n")}\n}`);
}

for (const group of ["space", "size", "radius"]) {
  for (const [name, t] of tokens(group)) {
    common.push(`  --${group}-${name}: ${dimension(t.$value)};`);
  }
}

for (const [name, t] of tokens("shadow")) {
  const s = resolved(t.$value) as Obj;
  common.push(
    `  --shadow-${name}: ${dimension(s.offsetX)} ${dimension(s.offsetY)} ${dimension(s.blur)} ${dimension(s.spread)} ${color(s.color)};`,
  );
}

for (const [name, t] of tokens("motion")) {
  const m = resolved(t.$value) as Obj;
  common.push(`  --motion-${name}-duration: ${dimension(m.duration)};`);
  common.push(`  --motion-${name}-easing: ${cubicBezier(m.timingFunction)};`);
}

for (const [name, t] of tokens("duration")) {
  common.push(`  --duration-${name}: ${dimension(t.$value)};`);
}

const themeLines = lightColors.map(([name]) => `  --color-${name}: var(--token-color-${name});`);

const css = `/* docs/06_design-tokens.json から scripts/gen-tokens.ts が生成する。直接編集しない(make tokens) */
:root {
${[...colorLines(lightColors), ...common].join("\n")}
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
${colorLines(darkColors)
  .map((l) => `  ${l}`)
  .join("\n")}
  }
}

@theme inline {
${themeLines.join("\n")}
}

${utilities.join("\n\n")}
`;

await Bun.write(output, css);
