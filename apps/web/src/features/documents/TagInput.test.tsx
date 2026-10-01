import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import i18n from "../../lib/i18n";
import { finalTags, TagInput } from "./TagInput";

beforeAll(async () => {
  await i18n.changeLanguage("ja");
});
afterEach(cleanup);

function Harness({ initial = [] as string[] }) {
  const [tags, setTags] = useState(initial);
  const [input, setInput] = useState("");
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TagInput projectId="p" value={tags} onChange={setTags} input={input} onInput={setInput} />
      <output data-testid="tags">{tags.join("|")}</output>
    </QueryClientProvider>
  );
}

const tagsOf = () => screen.getByTestId("tags").textContent;

describe("TagInput", () => {
  test("Enter で確定してチップにし、入力欄を空にする。フォームは送信しない", async () => {
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "タグ" });
    await userEvent.type(input, "  提出 {Enter}");
    expect(tagsOf()).toBe("提出");
    expect((input as HTMLInputElement).value).toBe("");
  });

  test("大文字・小文字、全角・半角の英数字が違うだけのタグは足さず、既存のチップを光らせる", async () => {
    render(<Harness initial={["Final"]} />);
    await userEvent.type(screen.getByRole("textbox", { name: "タグ" }), "ＦＩＮＡＬ{Enter}");
    expect(tagsOf()).toBe("Final");
    expect(screen.getByRole("listitem").getAttribute("data-flash")).toBe("true");
  });

  test("5件になったら入力欄を無効にして理由を添える。×で外すと入力できる", async () => {
    render(<Harness initial={["a", "b", "c", "d", "e"]} />);
    const input = screen.getByRole("textbox", { name: "タグ" }) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByText("タグは5件まで付けられます")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "タグ e を外す" }));
    expect(input.disabled).toBe(false);
    expect(tagsOf()).toBe("a|b|c|d");
  });

  test("20文字を超える入力は理由を出し、確定しない", async () => {
    render(<Harness />);
    await userEvent.type(
      screen.getByRole("textbox", { name: "タグ" }),
      `${"あ".repeat(21)}{Enter}`,
    );
    expect(screen.getByText("20文字以内で入力してください")).toBeTruthy();
    expect(tagsOf()).toBe("");
  });
});

describe("finalTags", () => {
  test("確定していない入力は、確定してから検証する", () => {
    const result = finalTags(["a", "b", "c", "d"], " e ");
    expect(result.ok && result.value.map((tag) => tag.label)).toEqual(["a", "b", "c", "d", "e"]);
    expect(finalTags(["a", "b", "c", "d", "e"], "f")).toEqual({ ok: false, error: "too_many" });
  });

  test("確定していない入力が既存のタグと重複するときは、足さない", () => {
    const result = finalTags(["Final"], "final");
    expect(result.ok && result.value).toHaveLength(1);
  });

  test("入力が空なら確定済みのタグだけを検証する", () => {
    expect(finalTags(["a"], "  ").ok).toBe(true);
  });
});
