import { describe, expect, it } from "vitest";
import { JsonPayloadError, extractJsonPayload, stripJsonFence } from "./json-fence.js";

const fence = "`".repeat(3);

/**
 * 模型时不时会把 JSON 包在代码围栏里。实测记录里 5 次术语链路调用有 1 次这样返回
 * （耗时 117 秒、3792 字符的那次）。
 *
 * voice-extraction 会直接剥离围栏；voice-attribution 此前只做裸 JSON.parse，
 * 靠一轮「修复重问」兜住——数据没丢，但在一个平均 17 秒起步的链路上白花一次调用。
 */
describe("剥离 JSON 代码围栏", () => {
  it("剥掉 ```json 围栏", () => {
    expect(stripJsonFence(`${fence}json\n{"a":1}\n${fence}`)).toBe(`{"a":1}`);
  });

  it("剥掉不带语言标注的围栏", () => {
    expect(stripJsonFence(`${fence}\n[1,2]\n${fence}`)).toBe("[1,2]");
  });

  it("裸 JSON 原样返回（只去首尾空白）", () => {
    expect(stripJsonFence('  {"a":1}  ')).toBe('{"a":1}');
  });

  it("正文里出现的围栏不当作包裹——只处理首尾成对的那种", () => {
    const text = `{"note":"见 ${fence}code${fence} 段"}`;
    expect(stripJsonFence(text)).toBe(text);
  });

  it("只有开头有围栏、结尾缺失 → 不动它，交给解析器如实报错", () => {
    const broken = `${fence}json\n{"a":1}`;
    expect(stripJsonFence(broken)).toBe(broken);
  });

  it("空串与纯空白安全", () => {
    expect(stripJsonFence("")).toBe("");
    expect(stripJsonFence("   \n ")).toBe("");
  });
});

/**
 * 仓库里曾有四套各自手搓的 JSON 提取实现，四种失败模式（PL-24）。
 * 共享实现的契约：能修的畸形一次修完，修不了的**如实报错并带上原始片段**，
 * 绝不静默返回 null——静默失败是上一轮质量事故的根因。
 */
describe("extractJsonPayload：共享 JSON 提取", () => {
  it("解析裸 JSON 对象与数组", () => {
    expect(extractJsonPayload('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonPayload("[1,2]")).toEqual([1, 2]);
  });

  it("剥离成对围栏后解析", () => {
    expect(extractJsonPayload(`${fence}json\n{"a":1}\n${fence}`)).toEqual({ a: 1 });
  });

  it("前后有解说文字时切出 JSON 主体", () => {
    const raw = `好的，以下是复核结果：\n[{"ja":"勇者","zh":"勇者"}]\n如有问题请告知。`;
    expect(extractJsonPayload(raw)).toEqual([{ ja: "勇者", zh: "勇者" }]);
  });

  it("去掉对象与数组的尾逗号", () => {
    expect(extractJsonPayload('{"a":1,}')).toEqual({ a: 1 });
    expect(extractJsonPayload('[{"a":1},]')).toEqual([{ a: 1 }]);
  });

  it("字符串里的逗号和花括号不被误修", () => {
    expect(extractJsonPayload('{"note":"逗号, 花括号 } 都在正文里"}')).toEqual({ note: "逗号, 花括号 } 都在正文里" });
  });

  it("正文含围栏字样但没有可解析 JSON → 如实报错，不猜测", () => {
    const raw = `${fence}json 这只是说明文字，我没有给出 JSON。`;
    expect(() => extractJsonPayload(raw)).toThrow(JsonPayloadError);
  });

  it("报错信息带原始片段前 200 字符", () => {
    const raw = `无法完成：${"あ".repeat(500)}`;
    let caught: unknown;
    try {
      extractJsonPayload(raw);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JsonPayloadError);
    const failure = caught as JsonPayloadError;
    expect(failure.snippet).toHaveLength(200);
    expect(failure.snippet).toBe(raw.slice(0, 200));
    expect(failure.message).toContain(raw.slice(0, 40));
  });

  it("空响应报错而不是返回 null", () => {
    expect(() => extractJsonPayload("   ")).toThrow(JsonPayloadError);
  });

  it("截断的 JSON 报错而不是补全", () => {
    expect(() => extractJsonPayload('{"a":1, "b":')).toThrow(JsonPayloadError);
  });
});
