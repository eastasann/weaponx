# weaponx

このリポジトリでは [DRAFT](https://github.com/dwnfrc/DWNFRC-DRAFT)(Document-driven, Reproducible, AI-powered, Full-stack Toolkit)を Claude Code のスキルとして使える。

DRAFT は、いきなりコードを書かずにコンセプトから設計書を段階的に練り上げ、確かな設計図ができてから実装に入るAI駆動開発フレームワーク。

## 設定

[`.claude/settings.json`](.claude/settings.json) が上流のマーケットプレイスを参照し、`draft` プラグインを有効にしている。スキルの実体はこのリポジトリに持たず、上流から取得する。

```json
{
  "extraKnownMarketplaces": {
    "draft-marketplace": {
      "source": { "source": "github", "repo": "dwnfrc/DWNFRC-DRAFT" }
    }
  },
  "enabledPlugins": { "draft@draft-marketplace": true }
}
```

この設定はディレクトリ単位で効く。weaponx の中では有効、外では無効になる。

## 初回だけ必要な手順

プラグインの取得は、フォルダを信頼したとき(対話セッションの初回起動時)に行われる。ヘッドレス実行(`claude -p`)や `claude plugin list` では取得が走らないため、その経路で使うなら1回だけ明示的に入れる:

```bash
claude plugin install draft@draft-marketplace
```

2回目以降は不要。取得後は `.claude/settings.json` が有効・無効を管理する。

## スキル一覧

| スキル | フェーズ | やること | 主な成果物 |
|--------|---------|---------|-----------|
| `/draft:guide` | — | 全体像の説明と現在フェーズの診断、次のスキルの案内 | なし |
| `/draft:concept` | Phase 0 | 対話でコンセプトを言語化 | `docs/concept.md` |
| `/draft:brainstorm` | Phase 1 | 壁打ち(スコープ・画面・ロール・フローを具体化) | `docs/brainstorm-notes.md` |
| `/draft:design-spec` | Phase 2 | 設計仕様書の作成 | `docs/design-spec.md`, `docs/screen_flow.mermaid` |
| `/draft:playbook` | Phase 3 | 技術スタック確定 + 開発ドキュメント7点セット生成 | `docs/01_prd.md` 〜 `docs/06_design-tokens.json` |
| `/draft:prep` | Phase 4 | 実装準備(コンテキスト + ステップ別プロンプト + 検出点) | `CLAUDE.md`, `docs/claude-code-prompts.md`, `scripts/doc-lint.sh` |
| `/draft:implement` | Phase 5 | プロンプト集から1ステップ実装 + 動作確認 | 実装コード |
| `/draft:feature` | イテレーション | 変更の設計(FDD作成) | `docs/features/YYYYMMDD-HHMM_{機能名}.md` |
| `/draft:feature-implement` | イテレーション | FDDから実装 + ドキュメント更新 + コミット | 実装コード + 更新されたdocs |
| `/draft:adopt` | 導入 | 既存プロジェクトにソース層を逆生成して導入 | `docs/` ソース層4点 + `CLAUDE.md` |
| `/draft:branch` | 補助 | 戦略と変更規模から作業場所を決めて準備 | 作業場所の決定 |
| `/draft:commit` | 補助 | リポジトリの流儀に合ったメッセージ・粒度でコミット | コミット |

迷ったら `/draft:guide` から始める。

## 更新と削除

プラグインは上流を参照しているため、更新は上流の取得で反映される:

```bash
claude plugin marketplace update draft-marketplace
```

使うのをやめるときは `.claude/settings.json` の `enabledPlugins` を `false` にするか、設定ごと消す。
