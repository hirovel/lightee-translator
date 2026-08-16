/**
 * TR-04：思考展示的纯逻辑。DOM 读写留在 workspace-bridge，这里只算「该显示什么」。
 *
 * 要回答的问题就一个：**运行中的这两分钟，模型在干什么。**
 * 此前界面上只有一个转圈的秒表，于是「正常地慢」和「卡在第 3 次重试」长得一模一样。
 */
import { describe, expect, it } from "vitest";
import { emptyThinking, reduceThinking, describeThinking } from "./thinking-view.js";

const at = (ms: number) => 1_700_000_000_000 + ms;

describe("reduceThinking 累积", () => {
  it("增量按到达顺序拼起来", () => {
    let state = emptyThinking();
    state = reduceThinking(state, { label: "translate:ch001", delta: "先看" }, at(0));
    state = reduceThinking(state, { label: "translate:ch001", delta: "人名读法" }, at(100));
    expect(state.text).toBe("先看人名读法");
    expect(state.chars).toBe(6);
    expect(state.done).toBe(false);
  });

  it("done 收尾后不再累积——迟到的增量不该让已结束的块又动起来", () => {
    let state = emptyThinking();
    state = reduceThinking(state, { label: "a", delta: "正文" }, at(0));
    state = reduceThinking(state, { label: "a", delta: "", done: true }, at(10));
    state = reduceThinking(state, { label: "a", delta: "迟到" }, at(20));
    expect(state.text).toBe("正文");
    expect(state.done).toBe(true);
  });

  it("换 attempt 即换一个块：重来一次就该从头显示，而不是把两次的思考粘在一起", () => {
    let state = emptyThinking();
    state = reduceThinking(state, { label: "a", attempt: 1, delta: "第一次" }, at(0));
    state = reduceThinking(state, { label: "a", attempt: 2, delta: "第二次" }, at(500));
    expect(state.text).toBe("第二次");
    expect(state.attempt).toBe(2);
    expect(state.startedAt).toBe(at(500));
  });

  it("换 label 同样换块——上一章的思考不该出现在这一章下面", () => {
    let state = emptyThinking();
    state = reduceThinking(state, { label: "translate:ch001", delta: "甲" }, at(0));
    state = reduceThinking(state, { label: "translate:ch002", delta: "乙" }, at(50));
    expect(state.text).toBe("乙");
    expect(state.label).toBe("translate:ch002");
  });
});

describe("describeThinking 展示", () => {
  it("运行中给出打字机尾巴：只显示最后一段，长思考不会把界面顶爆", () => {
    let state = emptyThinking();
    state = reduceThinking(state, { label: "a", delta: "0123456789ABCDEFGHIJ" }, at(0));
    const view = describeThinking(state, { tailChars: 8 });
    expect(view.tail).toBe("CDEFGHIJ");
    expect(view.running).toBe(true);
  });

  it("尾巴不足阈值时原样显示，不左填充", () => {
    let state = emptyThinking();
    state = reduceThinking(state, { label: "a", delta: "短" }, at(0));
    expect(describeThinking(state, { tailChars: 8 }).tail).toBe("短");
  });

  it("换行折成空格——打字机是一行，多行会把卡片撑开又缩回，闪得没法看", () => {
    let state = emptyThinking();
    state = reduceThinking(state, { label: "a", delta: "上\n\n下" }, at(0));
    expect(describeThinking(state, { tailChars: 20 }).tail).toBe("上 下");
  });

  it("结束后折叠成一行摘要，字符数说人话", () => {
    let state = emptyThinking();
    state = reduceThinking(state, { label: "a", delta: "推".repeat(13_447) }, at(0));
    state = reduceThinking(state, { label: "a", delta: "", done: true }, at(1000));
    const view = describeThinking(state);
    expect(view.running).toBe(false);
    expect(view.summary).toContain("13,447");
    expect(view.summary).toContain("思考");
  });

  /**
   * 重试次数必须露脸。2026-08-12 的跑批里 ch003 连废三次、耗掉 380 秒，
   * 而界面上只有一个一直在涨的秒表——「正常地慢」和「卡在第 3 次重试」
   * 在用户眼里完全一样。
   */
  it("第 2 次起把尝试次数写进摘要", () => {
    let state = emptyThinking();
    state = reduceThinking(state, { label: "a", attempt: 3, thinking: "high", delta: "x" }, at(0));
    const view = describeThinking(state);
    expect(view.summary).toContain("第 3 次");
    expect(view.summary).toContain("high");
  });

  it("第 1 次不写次数——没重试就别制造「出事了」的暗示", () => {
    let state = emptyThinking();
    state = reduceThinking(state, { label: "a", attempt: 1, delta: "x" }, at(0));
    expect(describeThinking(state).summary).not.toContain("第 1 次");
  });

  it("空状态不产出任何展示", () => {
    const view = describeThinking(emptyThinking());
    expect(view.visible).toBe(false);
    expect(view.tail).toBe("");
  });
});
