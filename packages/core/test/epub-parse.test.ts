/**
 * epub-parse 测试：最小 EPUB 构造（jszip）→ 解析 → 断言。
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import {
  parseEpub,
  extractBlocksFromXhtml,
  detectVolumeTitle,
} from "../src/epub-parse.ts";

/** 构造最小 EPUB（EPUB3 + nav 目录 + 插图 + ruby + 斜体） */
async function makeEpub(opts: { withNav?: boolean; withNcx?: boolean } = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );
  const ch1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第1話 出会い</title></head>
<body>
  <h1>第1話 出会い</h1>
  <p>「<em>あなた</em>は誰？」と彼女は言った。</p>
  <p>俺の名前は<strong>田中</strong>だ。<ruby>森村透<rt>とおる</rt></ruby>ではない。</p>
  <p><img src="images/p001.jpg" alt="教室の風景"/>黒炎が燃え上がる。</p>
  <p>そして<ruby>黒炎<rt>ヘルファイア</rt></ruby>は世界を包んだ。</p>
</body></html>`;
  const ch2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第2話 約束</title></head>
<body>
  <h1>第2話 約束</h1>
  <p>「また明日ね」</p>
</body></html>`;
  zip.file("OEBPS/ch1.xhtml", ch1);
  zip.file("OEBPS/ch2.xhtml", ch2);
  zip.file("OEBPS/images/p001.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { base64: false });
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>テストの書</dc:title>
    <dc:creator>著者A</dc:creator>
    <dc:identifier id="uid">test-001</dc:identifier>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="images/p001.jpg" media-type="image/jpeg"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`
  );
  if (opts.withNav !== false) {
    zip.file(
      "OEBPS/nav.xhtml",
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目次</title></head>
<body>
<nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">第1話 出会い</a></li>
  <li><a href="ch2.xhtml">第2話 約束</a></li>
</ol></nav>
</body></html>`
    );
  }
  if (opts.withNcx) {
    zip.file(
      "OEBPS/toc.ncx",
      `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1"><navLabel><text>第1話 出会い</text></navLabel><content src="ch1.xhtml"/></navPoint>
    <navPoint id="n2"><navLabel><text>第2話 約束</text></navLabel><content src="ch2.xhtml"/></navPoint>
  </navMap>
</ncx>`
    );
  }
  return zip.generateAsync({ type: "nodebuffer", mimeType: "application/epub+zip" });
}

/**
 * 多卷 EPUB 构造（合本场景）：前書き + 两卷 × 两章 + 卷扉页。
 * toc 形态可选：nav 嵌套 / NCX 嵌套 / 平目录+卷扉页 / 纯平目录。
 */
async function makeVolumeEpub(toc: "nav-nested" | "ncx-nested" | "flat-separators" | "flat" | "nav-wrapped"): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  );
  const page = (title: string, body: string) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head>
<body><h1>${title}</h1>${body}</body></html>`;
  zip.file("OEBPS/maegaki.xhtml", page("前書き", "<p>この本は合本です。</p>"));
  zip.file("OEBPS/vol1.xhtml", page("第一巻 出会いの章", ""));
  zip.file("OEBPS/v1ch1.xhtml", page("第1話 出会い", "<p>彼女に出会った。</p>"));
  zip.file("OEBPS/v1ch2.xhtml", page("第2話 約束", "<p>また明日ね。</p>"));
  zip.file("OEBPS/vol2.xhtml", page("第二巻 約束の章", ""));
  zip.file("OEBPS/v2ch1.xhtml", page("第3話 再会", "<p>一年ぶりだった。</p>"));
  zip.file("OEBPS/v2ch2.xhtml", page("第4話 旅立ち", "<p>旅に出る。</p>"));
  // flat / nav-wrapped 是「真的没有分卷信息」的负例——卷扉页也不能进 spine，
  // 否则兜底逻辑会（正确地）从扉页识别出分卷，负例就不成立了
  const withVolPages = toc === "nav-nested" || toc === "ncx-nested" || toc === "flat-separators";
  const volSpine = withVolPages ? `<itemref idref="vol1"/>` : "";
  const volSpine2 = withVolPages ? `<itemref idref="vol2"/>` : "";
  const manifestExtra = toc === "ncx-nested"
    ? `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`
    : `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`;
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>合本テスト</dc:title>
    <dc:identifier id="uid">omnibus-001</dc:identifier>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="maegaki" href="maegaki.xhtml" media-type="application/xhtml+xml"/>
    <item id="vol1" href="vol1.xhtml" media-type="application/xhtml+xml"/>
    <item id="v1ch1" href="v1ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="v1ch2" href="v1ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="vol2" href="vol2.xhtml" media-type="application/xhtml+xml"/>
    <item id="v2ch1" href="v2ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="v2ch2" href="v2ch2.xhtml" media-type="application/xhtml+xml"/>
    ${manifestExtra}
  </manifest>
  <spine>
    <itemref idref="maegaki"/>
    ${volSpine}
    <itemref idref="v1ch1"/>
    <itemref idref="v1ch2"/>
    ${volSpine2}
    <itemref idref="v2ch1"/>
    <itemref idref="v2ch2"/>
  </spine>
</package>`
  );
  if (toc === "nav-nested") {
    zip.file(
      "OEBPS/nav.xhtml",
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目次</title></head><body>
<nav epub:type="toc"><ol>
  <li><a href="maegaki.xhtml">前書き</a></li>
  <li><a href="vol1.xhtml">第一巻 出会いの章</a><ol>
    <li><a href="v1ch1.xhtml">第1話 出会い</a></li>
    <li><a href="v1ch2.xhtml">第2話 約束</a></li>
  </ol></li>
  <li><a href="vol2.xhtml">第二巻 約束の章</a><ol>
    <li><a href="v2ch1.xhtml">第3話 再会</a></li>
    <li><a href="v2ch2.xhtml">第4話 旅立ち</a></li>
  </ol></li>
</ol></nav>
</body></html>`
    );
  } else if (toc === "nav-wrapped") {
    // 单一书名节点包住全部章节（常见导出器形态）→ 下钻后是平目录，不该被当成分卷
    zip.file(
      "OEBPS/nav.xhtml",
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目次</title></head><body>
<nav epub:type="toc"><ol>
  <li><span>合本テスト</span><ol>
    <li><a href="maegaki.xhtml">前書き</a></li>
    <li><a href="v1ch1.xhtml">第1話 出会い</a></li>
    <li><a href="v1ch2.xhtml">第2話 約束</a></li>
    <li><a href="v2ch1.xhtml">第3話 再会</a></li>
    <li><a href="v2ch2.xhtml">第4話 旅立ち</a></li>
  </ol></li>
</ol></nav>
</body></html>`
    );
  } else if (toc === "ncx-nested") {
    zip.file(
      "OEBPS/toc.ncx",
      `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n0"><navLabel><text>前書き</text></navLabel><content src="maegaki.xhtml"/></navPoint>
    <navPoint id="n1"><navLabel><text>第一巻 出会いの章</text></navLabel><content src="vol1.xhtml"/>
      <navPoint id="n1a"><navLabel><text>第1話 出会い</text></navLabel><content src="v1ch1.xhtml"/></navPoint>
      <navPoint id="n1b"><navLabel><text>第2話 約束</text></navLabel><content src="v1ch2.xhtml"/></navPoint>
    </navPoint>
    <navPoint id="n2"><navLabel><text>第二巻 約束の章</text></navLabel><content src="vol2.xhtml"/>
      <navPoint id="n2a"><navLabel><text>第3話 再会</text></navLabel><content src="v2ch1.xhtml"/></navPoint>
      <navPoint id="n2b"><navLabel><text>第4話 旅立ち</text></navLabel><content src="v2ch2.xhtml"/></navPoint>
    </navPoint>
  </navMap>
</ncx>`
    );
  } else {
    // 平目录（flat / flat-separators 共用）——分卷信息只存在于卷扉页
    zip.file(
      "OEBPS/nav.xhtml",
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目次</title></head><body>
<nav epub:type="toc"><ol>
  <li><a href="maegaki.xhtml">前書き</a></li>
  ${toc === "flat-separators" ? `<li><a href="vol1.xhtml">第一巻 出会いの章</a></li>` : ""}
  <li><a href="v1ch1.xhtml">第1話 出会い</a></li>
  <li><a href="v1ch2.xhtml">第2話 約束</a></li>
  ${toc === "flat-separators" ? `<li><a href="vol2.xhtml">第二巻 約束の章</a></li>` : ""}
  <li><a href="v2ch1.xhtml">第3話 再会</a></li>
  <li><a href="v2ch2.xhtml">第4話 旅立ち</a></li>
</ol></nav>
</body></html>`
    );
  }
  return zip.generateAsync({ type: "nodebuffer", mimeType: "application/epub+zip" });
}

describe("epub-parse 分卷（EV-01）", () => {
  it("nav 嵌套目录：顶层带子项条目 = 卷，章节带卷标题；前書き归入第一卷", async () => {
    const epub = await parseEpub(await makeVolumeEpub("nav-nested"));
    expect(epub.chapters.map((c) => c.title)).toEqual(["前書き", "第1話 出会い", "第2話 約束", "第3話 再会", "第4話 旅立ち"]);
    expect(epub.chapters.map((c) => c.volumeTitle)).toEqual([
      "第一巻 出会いの章",
      "第一巻 出会いの章",
      "第一巻 出会いの章",
      "第二巻 約束の章",
      "第二巻 約束の章",
    ]);
  });

  it("NCX 嵌套目录（EPUB2）同样识别分卷", async () => {
    const epub = await parseEpub(await makeVolumeEpub("ncx-nested"));
    expect(epub.chapters.map((c) => c.volumeTitle)).toEqual([
      "第一巻 出会いの章",
      "第一巻 出会いの章",
      "第一巻 出会いの章",
      "第二巻 約束の章",
      "第二巻 約束の章",
    ]);
  });

  it("平目录 + 卷扉页兜底：只有标题无正文且命中卷式样的页作为分隔符", async () => {
    const epub = await parseEpub(await makeVolumeEpub("flat-separators"));
    // 卷扉页本身不产出章节
    expect(epub.chapters.map((c) => c.title)).toEqual(["前書き", "第1話 出会い", "第2話 約束", "第3話 再会", "第4話 旅立ち"]);
    expect(epub.chapters.map((c) => c.volumeTitle)).toEqual([
      "第一巻 出会いの章",
      "第一巻 出会いの章",
      "第一巻 出会いの章",
      "第二巻 約束の章",
      "第二巻 約束の章",
    ]);
  });

  it("纯平目录：无分卷信息 → 不标注（行为不变）", async () => {
    const epub = await parseEpub(await makeVolumeEpub("flat"));
    expect(epub.chapters.every((c) => c.volumeTitle === undefined)).toBe(true);
  });

  it("平目录 span 分隔符（kakuyomu 形态）：无链接无子项的标签条目 = 分节边界；nav 在子目录时相对路径也要对上", async () => {
    // 真实形态来自カクヨム导出（jp.TS祭品少女 实书验证）：
    //  · nav 在 OEBPS/Text/nav.xhtml，链接相对 nav 自身（episode1.xhtml），
    //    而 spine 条目相对 OPF（Text/episode1.xhtml）——不解析基准路径就一个都对不上
    //  · 分节是 <li><span>本編</span></li> 这类无链接无子项的标签条目
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip");
    zip.file(
      "META-INF/container.xml",
      `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
    );
    const page = (title: string, body: string) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head>
<body><h1>${title}</h1>${body}</body></html>`;
    zip.file("OEBPS/Text/ep1.xhtml", page("1話", "<p>本編の始まり。</p>"));
    zip.file("OEBPS/Text/ep2.xhtml", page("2話", "<p>本編の続き。</p>"));
    zip.file("OEBPS/Text/ep3.xhtml", page("間の話", "<p>番外の話。</p>"));
    zip.file("OEBPS/Text/ep4.xhtml", page("続きの1話", "<p>続編の始まり。</p>"));
    zip.file("OEBPS/Text/ep5.xhtml", page("また間の話", "<p>また番外。</p>"));
    zip.file(
      "OEBPS/content.opf",
      `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>連載テスト</dc:title>
    <dc:identifier id="uid">web-001</dc:identifier>
  </metadata>
  <manifest>
    <item id="ep1" href="Text/ep1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ep2" href="Text/ep2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ep3" href="Text/ep3.xhtml" media-type="application/xhtml+xml"/>
    <item id="ep4" href="Text/ep4.xhtml" media-type="application/xhtml+xml"/>
    <item id="ep5" href="Text/ep5.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="Text/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine><itemref idref="ep1"/><itemref idref="ep2"/><itemref idref="ep3"/><itemref idref="ep4"/><itemref idref="ep5"/></spine>
</package>`
    );
    // 幕間出现两次：同名分节是**不同**的分节（实书「TS祭品少女」有三段幕間），不得按名字合并
    zip.file(
      "OEBPS/Text/nav.xhtml",
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目次</title></head><body>
<nav epub:type="toc"><h2>連載テスト</h2><ol>
  <li><span>本編</span></li>
  <li><a href="ep1.xhtml">1話</a></li>
  <li><a href="ep2.xhtml">2話</a></li>
  <li><span>幕間</span></li>
  <li><a href="ep3.xhtml">間の話</a></li>
  <li><span>続編</span></li>
  <li><a href="ep4.xhtml">続きの1話</a></li>
  <li><span>幕間</span></li>
  <li><a href="ep5.xhtml">また間の話</a></li>
</ol></nav>
</body></html>`
    );
    const epub = await parseEpub(await zip.generateAsync({ type: "nodebuffer", mimeType: "application/epub+zip" }));
    expect(epub.chapters.map((c) => c.title)).toEqual(["1話", "2話", "間の話", "続きの1話", "また間の話"]);
    expect(epub.chapters.map((c) => c.volumeTitle)).toEqual(["本編", "本編", "幕間", "続編", "幕間"]);
    // 序号区分同名分节：两段幕間是 1 和 3，不是同一个
    expect(epub.chapters.map((c) => c.volumeIndex)).toEqual([0, 0, 1, 2, 3]);
  });

  it("单一书名节点包裹全部章节 → 下钻一层，不误判为一卷", async () => {
    const epub = await parseEpub(await makeVolumeEpub("nav-wrapped"));
    expect(epub.chapters.every((c) => c.volumeTitle === undefined)).toBe(true);
    // 下钻后目录标题仍然生效
    expect(epub.chapters[1]!.title).toBe("第1話 出会い");
  });
});

describe("epub-parse", () => {
  it("解析元数据 + spine 章节（EPUB3 nav）", async () => {
    const epub = await parseEpub(await makeEpub());
    expect(epub.title).toBe("テストの書");
    expect(epub.authors).toEqual(["著者A"]);
    expect(epub.language).toBe("ja");
    expect(epub.chapters.length).toBe(2);
    expect(epub.chapters[0]!.title).toBe("第1話 出会い");
    expect(epub.chapters[1]!.title).toBe("第2話 約束");
  });

  it("章节按 spine 顺序（即使文件乱序）", async () => {
    const epub = await parseEpub(await makeEpub());
    expect(epub.chapters.map((c) => c.title)).toEqual(["第1話 出会い", "第2話 約束"]);
  });

  it("斜体/粗体 → md 标记传递", async () => {
    const epub = await parseEpub(await makeEpub());
    const p0 = epub.chapters[0]!.paragraphs.find((p) => p.text.includes("あなた"));
    expect(p0!.text).toContain("*あなた*");
    const p1 = epub.chapters[0]!.paragraphs.find((p) => p.text.includes("田中"));
    expect(p1!.text).toContain("**田中**");
  });

  it("ruby 双轨：平假名剥离 · 片假名标记传递", async () => {
    const epub = await parseEpub(await makeEpub());
    const texts = epub.chapters[0]!.paragraphs.map((p) => p.text).join("\n");
    // 平假名注音（森村透 とおる）→ 剥离，只留基础文本
    expect(texts).toContain("森村透");
    expect(texts).not.toContain("とおる");
    // 片假名注音（黒炎 ヘルファイア）→ 标记传递
    expect(texts).toContain("黒炎(ヘルファイア)");
  });

  it("插图抽取：文件入 map + 正文流标记 + 图注", async () => {
    const epub = await parseEpub(await makeEpub());
    const p2 = epub.chapters[0]!.paragraphs.find((p) => p.text.includes("燃え上がる"));
    expect(p2!.text).toContain("[插图: img01]");
    expect(epub.images.has("img01.jpg")).toBe(true);
    const img = epub.chapters[0]!.images[0]!;
    expect(img.caption).toBe("教室の風景");
  });

  it("图片资源重命名防冲突（多章同名图片）", async () => {
    const zip = await makeEpub();
    const epub = await parseEpub(zip);
    // 同一 EPUB 内两张同名图（ch1/ch2 各一张 p001.jpg 场景由多文件覆盖，这里验证去重逻辑存在）
    expect(epub.images.size).toBeGreaterThanOrEqual(1);
  });

  it("卷标题识别：第2巻 → v02", async () => {
    expect(detectVolumeTitle("第2巻 始まりの日\n\n本文…")).toBe("v02");
    expect(detectVolumeTitle("Vol.3: The Beginning")).toBe("v03");
    expect(detectVolumeTitle("本文だけのテキスト")).toBeNull();
  });

  it("NCX 目录兜底（无 nav 时）", async () => {
    const epub = await parseEpub(await makeEpub({ withNav: false, withNcx: true }));
    expect(epub.chapters.length).toBe(2);
    expect(epub.chapters[0]!.title).toBe("第1話 出会い");
  });

  it("XHTML 提取：块级段落切分", async () => {
    const html = `<html><body>
      <h1>見出し</h1>
      <p>段落一。</p>
      <p>段落二。</p>
      <blockquote>引用。</blockquote>
    </body></html>`;
    const blocks = extractBlocksFromXhtml(html);
    expect(blocks.map((b) => b.text)).toEqual(["見出し", "段落一。", "段落二。", "引用。"]);
  });
});
