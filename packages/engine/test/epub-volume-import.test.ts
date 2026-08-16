/**
 * EV-01 合本 EPUB 分卷导入：EPUB 自带 ≥2 卷时按原书分卷落盘。
 *
 * 三条约定：
 *  · 无显式目标卷 → 逐卷建卷（label 用原书卷标题，id 优先从卷标题识别 vNN），章节写入各自卷目录
 *  · 显式指定目标卷 → 尊重用户选择，整本并入该卷（行为与旧版一致）
 *  · previewImport 返回卷摘要与每章卷标，确认对话框才画得出分组
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace, listVolumes } from "../src/workspace.ts";
import { importEpubFile, previewImport } from "../src/import-pipeline.ts";

/** 两卷合本：前書き + 第一巻（2章）+ 第二巻（2章），nav 嵌套目录 */
async function makeOmnibusEpub(): Promise<Buffer> {
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
  zip.file("OEBPS/v1ch1.xhtml", page("第1話 出会い", "<p>彼女に出会った。</p>"));
  zip.file("OEBPS/v1ch2.xhtml", page("第2話 約束", "<p>また明日ね。</p>"));
  zip.file("OEBPS/v2ch1.xhtml", page("第3話 再会", "<p>一年ぶりだった。</p>"));
  zip.file("OEBPS/v2ch2.xhtml", page("第4話 旅立ち", "<p>旅に出る。</p>"));
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>合本テスト</dc:title>
    <dc:identifier id="uid">omnibus-002</dc:identifier>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="maegaki" href="maegaki.xhtml" media-type="application/xhtml+xml"/>
    <item id="v1ch1" href="v1ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="v1ch2" href="v1ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="v2ch1" href="v2ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="v2ch2" href="v2ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="maegaki"/>
    <itemref idref="v1ch1"/>
    <itemref idref="v1ch2"/>
    <itemref idref="v2ch1"/>
    <itemref idref="v2ch2"/>
  </spine>
</package>`
  );
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目次</title></head><body>
<nav epub:type="toc"><ol>
  <li><a href="maegaki.xhtml">前書き</a></li>
  <li><span>第一巻 出会いの章</span><ol>
    <li><a href="v1ch1.xhtml">第1話 出会い</a></li>
    <li><a href="v1ch2.xhtml">第2話 約束</a></li>
  </ol></li>
  <li><span>第二巻 約束の章</span><ol>
    <li><a href="v2ch1.xhtml">第3話 再会</a></li>
    <li><a href="v2ch2.xhtml">第4話 旅立ち</a></li>
  </ol></li>
</ol></nav>
</body></html>`
  );
  return zip.generateAsync({ type: "nodebuffer", mimeType: "application/epub+zip" });
}

async function setup(): Promise<{ root: string; epubPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "lightee-epub-vol-"));
  const epubPath = join(root, "omnibus.epub");
  await writeFile(epubPath, await makeOmnibusEpub());
  return { root, epubPath };
}

describe("EV-01 合本 EPUB 分卷导入", () => {
  it("无显式目标卷：按原书分卷落盘——卷标题识别为 id，label 用原书卷名", async () => {
    const { root, epubPath } = await setup();
    try {
      const ws = await createWorkspace(join(root, "ws"), { name: "合本" });
      const manifest = await importEpubFile(epubPath, ws);

      // 卷登记：第一巻→v01、第二巻→v02，label 保留原书卷标题
      const volumes = await listVolumes(ws);
      expect(volumes.map((v) => v.id)).toEqual(["v01", "v02"]);
      expect(volumes.map((v) => v.label)).toEqual(["第一巻 出会いの章", "第二巻 約束の章"]);

      // 章节归属：前書き（前置孤儿）+ 第1-2話 → v01；第3-4話 → v02
      expect(manifest.chapters.map((c) => ({ id: c.id, volume: c.volume }))).toEqual([
        { id: "ch001", volume: "v01" },
        { id: "ch002", volume: "v01" },
        { id: "ch003", volume: "v01" },
        { id: "ch004", volume: "v02" },
        { id: "ch005", volume: "v02" },
      ]);

      // 磁盘落位与内容完好
      expect(existsSync(join(ws.root, "source", "v01", "ch003.md"))).toBe(true);
      expect(existsSync(join(ws.root, "source", "v02", "ch004.md"))).toBe(true);
      const ch4 = await readFile(join(ws.root, "source", "v02", "ch004.md"), "utf-8");
      expect(ch4).toContain("# 第3話 再会");
      expect(ch4).toContain("一年ぶりだった。");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("显式指定目标卷：尊重用户选择，整本并入该卷", async () => {
    const { root, epubPath } = await setup();
    try {
      const ws = await createWorkspace(join(root, "ws"), { name: "合本" });
      const manifest = await importEpubFile(epubPath, ws, { volumeId: "v09" });
      expect(manifest.chapters.every((c) => c.volume === "v09")).toBe(true);
      const volumes = await listVolumes(ws);
      expect(volumes.map((v) => v.id)).toEqual(["v09"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("同名分节不合并：两段「幕間」各自成卷（kakuyomu 连载书形态）", async () => {
    // 平目录 + span 分隔符，幕間出现两次——按名字归并会把两段幕間塞进同一卷，打乱原书结构
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
    zip.file("OEBPS/ep1.xhtml", page("1話", "<p>本編。</p>"));
    zip.file("OEBPS/ep2.xhtml", page("間の話", "<p>幕間その一。</p>"));
    zip.file("OEBPS/ep3.xhtml", page("続きの1話", "<p>続編。</p>"));
    zip.file("OEBPS/ep4.xhtml", page("また間の話", "<p>幕間その二。</p>"));
    zip.file(
      "OEBPS/content.opf",
      `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>連載テスト</dc:title>
    <dc:identifier id="uid">serial-001</dc:identifier>
  </metadata>
  <manifest>
    <item id="ep1" href="ep1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ep2" href="ep2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ep3" href="ep3.xhtml" media-type="application/xhtml+xml"/>
    <item id="ep4" href="ep4.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine><itemref idref="ep1"/><itemref idref="ep2"/><itemref idref="ep3"/><itemref idref="ep4"/></spine>
</package>`
    );
    zip.file(
      "OEBPS/nav.xhtml",
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目次</title></head><body>
<nav epub:type="toc"><ol>
  <li><span>本編</span></li>
  <li><a href="ep1.xhtml">1話</a></li>
  <li><span>幕間</span></li>
  <li><a href="ep2.xhtml">間の話</a></li>
  <li><span>続編</span></li>
  <li><a href="ep3.xhtml">続きの1話</a></li>
  <li><span>幕間</span></li>
  <li><a href="ep4.xhtml">また間の話</a></li>
</ol></nav>
</body></html>`
    );
    const root = await mkdtemp(join(tmpdir(), "lightee-epub-vol-dup-"));
    const epubPath = join(root, "serial.epub");
    await writeFile(epubPath, await zip.generateAsync({ type: "nodebuffer", mimeType: "application/epub+zip" }));
    try {
      const ws = await createWorkspace(join(root, "ws"), { name: "連載" });
      const manifest = await importEpubFile(epubPath, ws);
      // 四个分节 = 四个卷，两段幕間 label 相同、id 不同、位置各归各
      const volumes = await listVolumes(ws);
      expect(volumes.map((v) => v.label)).toEqual(["本編", "幕間", "続編", "幕間"]);
      expect(new Set(volumes.map((v) => v.id)).size).toBe(4);
      const byId = new Map(manifest.chapters.map((c) => [c.id, c.volume]));
      expect(byId.get("ch002")).not.toBe(byId.get("ch004"));
      // 预览同样按分节区分：volumes 四条，章节 volumeIndex 对齐 volumes 下标
      const preview = await previewImport(epubPath);
      expect(preview.volumes?.map((v) => v.title)).toEqual(["本編", "幕間", "続編", "幕間"]);
      expect(preview.chapters.map((c) => c.volumeIndex)).toEqual([0, 1, 2, 3]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("previewImport：返回卷摘要与每章卷标", async () => {
    const { root, epubPath } = await setup();
    try {
      const preview = await previewImport(epubPath);
      expect(preview.volumes).toEqual([
        { title: "第一巻 出会いの章", chapters: 3 },
        { title: "第二巻 約束の章", chapters: 2 },
      ]);
      expect(preview.chapters.map((c) => c.volume)).toEqual([
        "第一巻 出会いの章",
        "第一巻 出会いの章",
        "第一巻 出会いの章",
        "第二巻 約束の章",
        "第二巻 約束の章",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
