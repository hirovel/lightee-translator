/**
 * token 估算 —— 上下文预算判定用的保守估计。
 *
 * 从 translator-context.ts 迁出。那个模块同时装着一套与生产并行的 prompt 组装原型，
 * 两套 prompt 真相并存了很久；PL-24 删掉原型后，这里只留与组装无关的计量工具。
 */

/** 日文 token 估算（字符 / 1.8 的保守值） */
export function estTokensJa(text: string): number {
  return Math.ceil(text.length / 1.8);
}
