/**
 * IV-04 —— 可选环节的降级必须是一个有名字的动作，不是五种手写的 try/catch。
 *
 * 立项时以为还有若干裸 await 待包。实测扫下来，术语提取里的可选环节**已经全部有守卫**了：
 * 阅读轮三级、语气归属一处、译名复核走 outcome.failed、双关按批、拟声词/语气档案走
 * 局部 degrade。问题不在于漏了哪个，而在于同一件事有五种写法——读的人要逐个辨认
 * 哪个是刻意降级、哪个是随手吞掉，写的人则没有可照抄的范式。
 */
import { describe, expect, it } from "vitest";
import { optional } from "../src/optional.js";

describe("IV-04 optional", () => {
  it("成功时原样返回，不发告警", async () => {
    const warnings: string[] = [];
    const value = await optional("拟声词决策", async () => [1, 2, 3], {
      onWarn: (m) => warnings.push(m),
      because: "少了这一档不影响译文交付",
    });
    expect(value).toEqual([1, 2, 3]);
    expect(warnings).toEqual([]);
  });

  it("失败时返回 null 并把「少了什么、为什么可以少」一起说清楚", async () => {
    const warnings: string[] = [];
    const value = await optional("拟声词决策", async () => {
      throw new Error("响应被截断");
    }, {
      onWarn: (m) => warnings.push(m),
      because: "少了这一档不影响译文交付",
    });

    expect(value).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("拟声词决策");
    expect(warnings[0]).toContain("响应被截断");
    // because 要出现在给作者看的那句话里：否则「少了拟声词表」会被读成「翻译坏了」
    expect(warnings[0]).toContain("少了这一档不影响译文交付");
  });

  it("返回 null 而不是空值——调用方必须自己写出降级用什么", async () => {
    const value = await optional<string[]>("语气档案", async () => {
      throw new Error("boom");
    }, { because: "已有降级路径" });
    // 若这里返回 []，调用方就能一路不看结果地写下去，降级后果无人承认
    expect(value).toBeNull();
    expect(value ?? []).toEqual([]);
  });

  it("没有 onWarn 也不抛——降级通道缺席不该把可选环节变成致命环节", async () => {
    await expect(optional("双关检测", async () => {
      throw new Error("boom");
    }, { because: "增强项" })).resolves.toBeNull();
  });
});
