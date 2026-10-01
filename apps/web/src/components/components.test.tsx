import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../lib/i18n";
import { Button } from "./Button";
import { type Column, DataTable } from "./DataTable";
import { ConfirmDialog } from "./Dialog";
import { ToastProvider, useNotify } from "./Toast";

beforeAll(async () => {
  await i18n.changeLanguage("ja");
  // 「開く ↗」の別タブへの遷移を、テストの中で実際に行わせない
  document.addEventListener("click", (event) => event.preventDefault());
});
afterEach(cleanup);

type Row = { id: string; name: string; updated: number; url: string | null };
const rows: Row[] = [
  { id: "1", name: "Banana", updated: 2, url: "https://example.com/b" },
  { id: "2", name: "apple", updated: 3, url: null },
  { id: "3", name: "Cherry", updated: 1, url: "https://example.com/c" },
];
const columns: Column<Row>[] = [
  { key: "name", header: "名前", sortValue: (r) => r.name, cell: (r) => r.name },
  {
    key: "updated",
    header: "更新",
    numeric: true,
    sortValue: (r) => r.updated,
    cell: (r) => r.updated,
  },
];

const names = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent);

describe("DataTable", () => {
  test("列見出しを押すと昇順、もう一度で降順に並べ替える", async () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(names()).toEqual(["Banana", "apple", "Cherry"]);
    await userEvent.click(screen.getByRole("button", { name: /名前/ }));
    expect(names()).toEqual(["apple", "Banana", "Cherry"]);
    await userEvent.click(screen.getByRole("button", { name: /名前/ }));
    expect(names()).toEqual(["Cherry", "Banana", "apple"]);
    await userEvent.click(screen.getByRole("button", { name: /更新/ }));
    expect(names()).toEqual(["Cherry", "Banana", "apple"]);
  });

  test("読み込み中は灰色の仮の行を指定の数だけ出し、実データは出さない", () => {
    render(
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading loadingRows={3} />,
    );
    expect(screen.getAllByRole("row", { hidden: true })).toHaveLength(4);
    expect(screen.queryByText("Banana")).toBeNull();
  });

  test("行を押すと onRowClick が呼ばれ、選んだ行は aria-selected になる", async () => {
    const onRowClick = mock((_row: Row) => {});
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        selectedKey="2"
        onRowClick={onRowClick}
      />,
    );
    await userEvent.click(screen.getByText("Cherry"));
    expect(onRowClick).toHaveBeenCalledWith(rows[2]);
    expect(screen.getAllByRole("row")[2]?.getAttribute("aria-selected")).toBe("true");
  });

  test("「開く ↗」は別タブで開き、行の選択を起こさない。リンクが無い行には出さない", async () => {
    const onRowClick = mock((_row: Row) => {});
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={onRowClick}
        openHref={(r) => r.url}
      />,
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    await userEvent.click(links[0] as HTMLElement);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  test("0件のときは empty を出す", () => {
    render(
      <DataTable
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        empty="条件に合うものがありません"
      />,
    );
    expect(screen.getByText("条件に合うものがありません")).toBeTruthy();
  });
});

describe("Button", () => {
  test("操作中は押せず、読み込み中の表示になる(design-spec 6.0.1)", async () => {
    const onClick = mock(() => {});
    render(
      <Button loading onClick={onClick}>
        保存
      </Button>,
    );
    const button = screen.getByRole("button", { name: /保存/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("ConfirmDialog", () => {
  test("確認で onConfirm、キャンセルで閉じる", async () => {
    const onConfirm = mock(() => {});
    const onOpenChange = mock((_open: boolean) => {});
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="削除"
        message="削除しますか"
        confirmLabel="削除する"
        destructive
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole("dialog", { name: "削除" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "削除する" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("実行中は閉じられず、キャンセルも押せない(ダイアログは閉じない。6.0.1)", async () => {
    const onOpenChange = mock((_open: boolean) => {});
    render(
      <ConfirmDialog
        open
        pending
        onOpenChange={onOpenChange}
        title="削除"
        message="m"
        confirmLabel="削除する"
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "キャンセル" }).hasAttribute("disabled")).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("Toast", () => {
  function Trigger() {
    const notify = useNotify();
    return (
      <>
        <button
          type="button"
          onClick={() => notify({ kind: "success", message: "資料を追加しました" })}
        >
          ok
        </button>
        <button
          type="button"
          onClick={() => notify({ kind: "error", message: "失敗", requestId: "abc123" })}
        >
          ng
        </button>
      </>
    );
  }

  test("失敗の通知はリクエスト ID を持ち、自分で閉じるまで残る", async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByText("ng"));
    expect(await screen.findByText("失敗")).toBeTruthy();
    expect(screen.getAllByText(/abc123/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.queryByText("失敗")).toBeNull();
  });

  test("成功の通知を出す", async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByText("ok"));
    expect(await screen.findByText("資料を追加しました")).toBeTruthy();
  });
});
