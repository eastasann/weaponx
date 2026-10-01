import { type FieldError, type TextResult, validateSingleLine } from "@weaponx/shared";
import { validationFailed } from "./errors";

/**
 * 入力の検証結果を集めて、1つでも不備があれば `VALIDATION_FAILED`(02-01 8章)を投げる。
 * 画面が欄ごとに理由を出せるよう、最初の不備で止めずにすべての欄を調べる。
 */
export class FieldCollector {
  private readonly errors: Record<string, FieldError> = {};

  /** 検証した値を返す。不備があれば欄を記録して空文字を返す */
  take(field: string, result: TextResult): string {
    if (result.ok) return result.value;
    this.errors[field] = result.error;
    return "";
  }

  text(field: string, raw: string, options: { max: number; required?: boolean }): string {
    return this.take(field, validateSingleLine(raw, options));
  }

  /** 呼び出し側は、すべての欄を `take` / `text` に通してから最後に呼ぶ */
  done(): void {
    if (Object.keys(this.errors).length > 0) throw validationFailed(this.errors);
  }
}
