import { describe, expect, test } from "bun:test";
import en from "./en.json";
import ja from "./ja.json";

type Tree = { [key: string]: string | Tree };

/** 複数形の接尾辞(`_one`・`_other`)は言語ごとに違う(日本語は `_other` だけ)ので、外して比べる */
function keys(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string"
      ? [`${prefix}${key.replace(/_(zero|one|two|few|many|other)$/, "")}`]
      : keys(value, `${prefix}${key}.`),
  );
}

describe("翻訳ファイル", () => {
  test("日英のキーが一致する(02-01 10章)", () => {
    expect([...new Set(keys(ja))].sort()).toEqual([...new Set(keys(en))].sort());
  });

  test("値が空の文言が無い", () => {
    const empty = (tree: Tree): boolean =>
      Object.values(tree).some((v) => (typeof v === "string" ? v.trim() === "" : empty(v)));
    expect(empty(ja)).toBe(false);
    expect(empty(en)).toBe(false);
  });

  test("補間の変数名が日英で一致する(複数形は _other どうしで比べる)", () => {
    const vars = (tree: Tree, prefix = ""): [string, string][] =>
      Object.entries(tree).flatMap(([key, value]) =>
        typeof value === "string"
          ? /_(zero|one|two|few|many)$/.test(key)
            ? []
            : [
                [
                  `${prefix}${key.replace(/_other$/, "")}`,
                  [...value.matchAll(/{{(\w+)}}/g)]
                    .map((m) => m[1])
                    .sort()
                    .join(","),
                ],
              ]
          : vars(value, `${prefix}${key}.`),
      );
    expect(vars(ja)).toEqual(vars(en));
  });
});
