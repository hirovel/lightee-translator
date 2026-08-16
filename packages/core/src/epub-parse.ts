/**
 * EPUB 解析器（混合路线：jszip + fast-xml-parser + htmlparser2 + 自研提取）。
 *
 * 职责:
 *   - zip 解包 → container.xml → OPF（manifest/spine）→ 按 spine 顺序读章节
 *   - nav.xhtml / toc.ncx 目录 → 章节标题（fallback 正文 h1）
 *   - XHTML 正文提取: 块级切分 · 斜体/粗体 → md 标记 · ruby 双轨（平假名剥离 / 片假名标记）
 *   - 插图抽取: <img> → 资源重命名 imgNN.jpg（按全书出现顺序）+ 正文流 [插图: imgNN] 标记
 *
 * 设计决策（见 docs/lightee-wiki.md）: 格式标记传递（B 方案）· 注音双轨 · 章首插图页方案的数据基础。
 */

import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { parseDocument } from "htmlparser2";
import type { Element, Text, ChildNode } from "domhandler";

// ===== 类型 =====
export interface EpubImage {
  /** 重命名后的资源名，如 img01.jpg */
  name: string;
  /** 原 EPUB 内路径，如 OEBPS/images/p001.jpg */
  sourcePath: string;
  /** 图注（figcaption/alt） */
  caption?: string;
}

export interface EpubParagraph {
  /** 带格式标记的文本（*斜体* **粗体** [插图: imgNN]） */
  text: string;
  kind: "text" | "heading";
}

export interface EpubChapter {
  id: string;
  title: string;
  paragraphs: EpubParagraph[];
  images: EpubImage[];
  /**
   * 所属卷标题（EV-01 合本分卷）。仅当全书识别出 ≥2 个卷时才有值——
   * 单卷书标了等于没标，还会诱导导入层走多卷路径。
   * 来源优先级：目录层级（nav 嵌套 / NCX 嵌套）> 平目录 span 分隔符 > 卷扉页兜底。
   */
  volumeTitle?: string;
  /**
   * 所属卷序号（0 起，按出现顺序）。**同名分节不合并**——kakuyomu 连载书的
   * 「幕間」可以出现多次，各是独立分节；只有序号才能区分它们。
   * 与 volumeTitle 同生同灭。
   */
  volumeIndex?: number;
}

export interface ParsedEpub {
  title: string;
  authors: string[];
  language?: string;
  chapters: EpubChapter[];
  /** 抽取的插图文件: 重命名后名称 → 二进制 */
  images: Map<string, Buffer>;
}

// ===== 常量 =====
const BLOCK_TAGS = new Set(["p", "li", "blockquote", "td", "th", "dt", "dd"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const CONTAINER_TAGS = new Set(["html", "div", "section", "article", "main", "body"]);
const KATAKANA_RE = /^[\u30a0-\u30ff\u31f0-\u31ffー・]+$/;
const HIRAGANA_RE = /^[\u3040-\u309fー]+$/;

// ===== XML 工具（fast-xml-parser）=====
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (name) => name === "itemref" || name === "item" || name === "navPoint" || name === "li",
});

// ===== 主入口 =====
export async function parseEpub(data: Buffer): Promise<ParsedEpub> {
  const zip = await JSZip.loadAsync(data);

  // 1. container.xml → OPF 路径
  const containerRaw = await readText(zip, "META-INF/container.xml");
  const container = xml.parse(containerRaw).container;
  const opfPath = container?.rootfiles?.rootfile?.["@_full-path"] ?? container?.rootfiles?.rootfile?.fullPath;
  if (!opfPath) throw new Error("EPUB 缺少 container.xml 根文件");

  const opfRaw = await readText(zip, opfPath);
  const opf = xml.parse(opfRaw).package;
  const baseDir = opfPath.replace(/[^/]*$/, "");

  // 2. 元数据
  const dc = opf?.metadata ?? {};
  const title = metadataText(dc.title) ?? "无题";
  const authorsRaw = dc.creator;
  const authorValues = Array.isArray(authorsRaw) ? authorsRaw : authorsRaw == null ? [] : [authorsRaw];
  const authors = authorValues
    .map(metadataText)
    .filter((value): value is string => value !== null && value.length > 0);
  const language = metadataText(dc.language) ?? undefined;

  // 3. manifest: href → 条目
  const manifestItems = new Map<string, { id: string; href: string; mediaType: string }>();
  for (const item of Array.isArray(opf?.manifest?.item) ? opf.manifest.item : [opf?.manifest?.item]) {
    if (item && item["@_href"]) {
      manifestItems.set(item["@_id"], {
        id: item["@_id"],
        href: item["@_href"],
        mediaType: item["@_media-type"] ?? "",
      });
    }
  }

  // 4. spine 顺序
  const spine = (Array.isArray(opf?.spine?.itemref) ? opf.spine.itemref : [opf?.spine?.itemref])
    .map((r: { "@_idref"?: string }) => r?.["@_idref"])
    .filter((x: unknown): x is string => typeof x === "string")
    .map((idref: string) => manifestItems.get(idref))
    .filter((x: unknown): x is { id: string; href: string; mediaType: string } => x !== undefined);
  if (spine.length === 0) throw new Error("EPUB spine 为空");

  // 5. 目录（nav 优先，NCX 兜底）——保留层级，分卷识别靠它（EV-01）
  const toc = await readToc(zip, baseDir, manifestItems);
  const navHrefs = toc.titles;
  // ≥2 个分组才算分卷；单组多为「书名包所有章」的导出器形态
  const tocVolumes = toc.groups.length >= 2 ? toc.groups : [];
  const hrefVolume = new Map<string, number>();
  tocVolumes.forEach((group, index) => {
    for (const href of group.hrefs) hrefVolume.set(href, index);
  });

  // 6. 按 spine 读章节（无正文段的项 = 卷首页/封面页 → 跳过）
  const chapters: EpubChapter[] = [];
  const images = new Map<string, Buffer>();
  const imageRefs: EpubImage[] = [];
  let imgSeq = 0;
  /** 目录分组的推进指针（组序号）：目录没提到的 spine 项跟随上一章所在卷 */
  let currentVolume: number | null = null;
  /** 卷扉页兜底的推进指针（仅平目录时启用）；每张扉页开一个新分节，同名不合并 */
  let separatorVolume: { title: string; index: number } | null = null;
  // 独立计数器而非 separatorVolume.index+1：后者在循环回边上会被 TS 窄化成 null（同 TS7022 的坑）
  let separatorCount = 0;

  for (let i = 0; i < spine.length; i++) {
    const item = spine[i]!;
    const fullHref = baseDir + item.href;
    const htmlRaw = await readText(zip, fullHref);
    const refsBefore = imageRefs.length;
    const blocks = extractBlocksFromXhtml(htmlRaw, {
      imageRefs,
      onImage: (img) => {
        imgSeq += 1;
        return `img${String(imgSeq).padStart(2, "0")}.jpg`;
      },
    });

    const heading = blocks.find((b) => b.kind === "heading");
    const hrefKey = item.href.split("#")[0] ?? item.href;
    const tocTitle = navHrefs.get(hrefKey);
    const textBlocks = blocks.filter((b) => b.kind === "text");
    const isMetadataPage =
      i === 0 &&
      (tocTitle === title || heading?.text === title) &&
      textBlocks.length <= 4 &&
      textBlocks.every((b) => /^(作者|译者|插画|绘者|原作|著者|author|by)[:：\\s]/i.test(b.text.trim()));

    // 卷首页/封面/元数据页：没有正文，或首个页面只是书名与作者信息 → 跳过。
    if (isMetadataPage || textBlocks.length === 0) {
      // 卷扉页兜底：目录是平的时，「只有标题无正文 + 标题命中卷式样」的页就是卷分隔符。
      // 此前这类页被当封面一律丢弃——扁平导入的分卷信息正是死在这里。
      if (tocVolumes.length === 0) {
        const separatorLabel = (tocTitle ?? heading?.text ?? "").trim();
        if (separatorLabel && VOLUME_RE.test(separatorLabel)) {
          separatorVolume = { title: separatorLabel, index: separatorCount };
          separatorCount += 1;
        }
      }
      const consumed = imageRefs.length - refsBefore;
      if (consumed > 0) imageRefs.splice(refsBefore, consumed);
      continue;
    }

    const title_ = tocTitle ?? (heading ? heading.text : `第${i + 1}节`);

    let volumeTitle: string | undefined;
    let volumeIndex: number | undefined;
    if (tocVolumes.length > 0) {
      // 显式注解：`?? currentVolume` 在循环回边上会让 TS 的窄化分析成环（TS7022）
      const mapped: number | null = hrefVolume.get(hrefKey) ?? currentVolume;
      currentVolume = mapped;
      if (mapped !== null) {
        volumeIndex = mapped;
        volumeTitle = tocVolumes[mapped]!.title;
      }
    } else if (separatorVolume) {
      volumeTitle = separatorVolume.title;
      volumeIndex = separatorVolume.index;
    }

    chapters.push({
      id: `ch${String(chapters.length + 1).padStart(3, "0")}`,
      title: title_,
      paragraphs: blocks,
      images: [], // 图片引用在下方统一按章节分配
      ...(volumeTitle !== undefined && volumeIndex !== undefined ? { volumeTitle, volumeIndex } : {}),
    });
  }

  // 分卷归一：<2 个不同分节（按序号，不按名字）= 没有分卷（全部清除）；
  // 前置孤儿章（前書き等）归入第一个分节
  const labeled = chapters.filter((c) => c.volumeIndex !== undefined);
  const distinctIndices = new Set(labeled.map((c) => c.volumeIndex));
  if (distinctIndices.size >= 2) {
    const first = labeled[0]!;
    for (const ch of chapters) {
      if (ch.volumeIndex !== undefined) break;
      ch.volumeIndex = first.volumeIndex;
      ch.volumeTitle = first.volumeTitle;
    }
  } else {
    for (const ch of chapters) {
      delete ch.volumeTitle;
      delete ch.volumeIndex;
    }
  }

  // 7. 图片二进制抽取（按章节归属）
  const seen = new Set<string>();
  for (const ref of imageRefs) {
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    const src = ref.sourcePath;
    const zipPath = src.startsWith("/") ? src.slice(1) : src.startsWith("OEBPS/") || !baseDir ? src : baseDir + src.replace(/^\.\//, "");
    const file = zip.file(zipPath);
    if (file) {
      try {
        images.set(ref.name, await file.async("nodebuffer"));
      } catch {
        // 图片读取失败 → 跳过（不阻断正文）
      }
    }
  }
  // 章节图片归属
  let refIdx = 0;
  for (const ch of chapters) {
    const count = ch.paragraphs.filter((p) => p.text.includes("[插图:")).length;
    ch.images = imageRefs.slice(refIdx, refIdx + count).map((r) => ({ ...r }));
    refIdx += count;
  }

  return { title, authors, language, chapters, images };
}

function metadataText(value: unknown): string | null {
  if (Array.isArray(value)) return metadataText(value[0]);
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "#text" in value) {
    const text = (value as { "#text"?: unknown })["#text"];
    return text == null ? null : String(text);
  }
  return value == null ? null : String(value);
}

// ===== 目录解析 =====

/** 目录树节点。此前目录被拍平成 href→label，合本 EPUB 的分卷层级正是在那一步丢掉的（EV-01）。 */
interface TocEntry {
  label: string;
  href: string | null;
  children: TocEntry[];
}

interface TocInfo {
  /** href → 标题（全层级，首见优先）——原 readNavTitles 的产出，语义不变 */
  titles: Map<string, string>;
  /** 顶层带子项条目 = 卷候选（已做单包裹下钻）。<2 个时调用方应忽略——单卷标了等于没标。 */
  groups: Array<{ title: string; hrefs: Set<string> }>;
}

async function readToc(
  zip: JSZip,
  baseDir: string,
  manifestItems: Map<string, { id: string; href: string; mediaType: string }>
): Promise<TocInfo> {
  let entries: TocEntry[] = [];

  // nav.xhtml（EPUB3）：nav[epub:type=toc] > ol > li(> a|span + ol?) 递归。
  // 目录里的链接相对**目录文件自身**，而 spine 条目相对 OPF——nav 放在子目录
  // （kakuyomu 的 Text/nav.xhtml）时不换算基准，每个 href 都对不上 spine。
  const navItem = [...manifestItems.values()].find((i) => i.href.endsWith("nav.xhtml"));
  if (navItem) {
    try {
      const raw = await readText(zip, baseDir + navItem.href);
      entries = parseNavEntries(parseDocument(raw));
      resolveEntryHrefs(entries, navItem.href.replace(/[^/]*$/, ""));
    } catch {
      // nav 解析失败 → 走 NCX / h1 兜底
    }
  }

  // toc.ncx（EPUB2 兜底：manifest 未声明时也尝试从 zip 根目录找）
  if (entries.length === 0) {
    const manifestNcx = [...manifestItems.values()].find((i) => i.href.endsWith(".ncx"));
    const zipNcx = Object.values(zip.files).find((f) => f.name.endsWith(".ncx") && !f.dir);
    if (manifestNcx || zipNcx) {
      try {
        const ncxPath = manifestNcx ? baseDir + manifestNcx.href : (zipNcx?.name ?? "");
        const raw = await readText(zip, ncxPath);
        entries = ncxEntries(xml.parse(raw).ncx?.navMap?.navPoint);
        // NCX 的基准同样是它自己所在目录（换算成 OPF 相对路径）
        const ncxBase = manifestNcx
          ? manifestNcx.href.replace(/[^/]*$/, "")
          : zipNcx && zipNcx.name.startsWith(baseDir)
            ? zipNcx.name.slice(baseDir.length).replace(/[^/]*$/, "")
            : "";
        resolveEntryHrefs(entries, ncxBase);
      } catch {
        // NCX 失败 → 忽略
      }
    }
  }

  // 标题表用完整树（卷条目自身的 href 也该有标题）
  const titles = new Map<string, string>();
  const walkTitles = (list: TocEntry[]) => {
    for (const e of list) {
      if (e.href && e.label && !titles.has(e.href)) titles.set(e.href, e.label);
      walkTitles(e.children);
    }
  };
  walkTitles(entries);

  // 单包裹下钻：唯一顶层节点包住全部（书名节点，常见导出器形态）→ 其子项才是真正的顶层
  let top = entries;
  while (top.length === 1 && top[0]!.children.length > 0) top = top[0]!.children;

  let groups = top
    .filter((e) => e.children.length > 0 && e.label.length > 0)
    .map((e) => {
      const hrefs = new Set<string>();
      const collect = (list: TocEntry[]) => {
        for (const c of list) {
          if (c.href) hrefs.add(c.href);
          collect(c.children);
        }
      };
      collect(e.children);
      return { title: e.label, hrefs };
    });

  // 平目录 span 分隔符（kakuyomu 等 Web 小说导出器）：目录不嵌套，分节信息是
  // 「有标签、无链接、无子项」的条目插在章节列表中间——它不指向任何页面，
  // 存在的唯一意义就是给后面的章节分组。≥2 个这样的分隔符才启用，
  // 且丢弃没有章节跟随的空组（相邻分隔符/结尾分隔符）。
  if (groups.length < 2) {
    const spanGroups: Array<{ title: string; hrefs: Set<string> }> = [];
    let open: { title: string; hrefs: Set<string> } | null = null;
    let separators = 0;
    for (const e of top) {
      if (!e.href && e.children.length === 0 && e.label.length > 0) {
        separators += 1;
        open = { title: e.label, hrefs: new Set() };
        spanGroups.push(open);
      } else if (e.href && open) {
        open.hrefs.add(e.href);
      }
    }
    if (separators >= 2) groups = spanGroups.filter((g) => g.hrefs.size > 0);
  }

  return { titles, groups };
}

function parseNavEntries(doc: ReturnType<typeof parseDocument>): TocEntry[] {
  const navs: Element[] = [];
  const findNavs = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (n.type !== "tag") continue;
      const el = n as Element;
      if (el.name === "nav") navs.push(el);
      if (el.children) findNavs(el.children);
    }
  };
  findNavs(doc.children);
  const nav = navs.find((n) => n.attribs["epub:type"] === "toc") ?? navs[0];
  if (!nav) return [];
  const ol = findFirstTag(nav, "ol");
  return ol ? parseNavList(ol) : [];
}

function parseNavList(ol: Element): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const child of ol.children) {
    if (child.type !== "tag" || (child as Element).name !== "li") continue;
    const li = child as Element;
    let label = "";
    let href: string | null = null;
    let childOl: Element | null = null;
    for (const c of li.children) {
      if (c.type !== "tag") continue;
      const el = c as Element;
      if (el.name === "ol") {
        if (!childOl) childOl = el;
        continue;
      }
      // 规范形态是 li > (a|span)；label 首见优先，嵌套 ol 里的不算自己的标签
      if ((el.name === "a" || el.name === "span") && !label) {
        label = textOf(el).trim();
        if (el.name === "a" && el.attribs.href) href = el.attribs.href.split("#")[0]!;
      }
    }
    if (label || childOl) entries.push({ label, href, children: childOl ? parseNavList(childOl) : [] });
  }
  return entries;
}

function ncxEntries(points: unknown): TocEntry[] {
  const list = Array.isArray(points) ? points : points ? [points] : [];
  return list.map((p) => {
    const src = p?.content?.["@_src"] ?? p?.content?.src;
    return {
      label: String(metadataText(p?.navLabel?.text) ?? "").trim(),
      href: src ? String(src).split("#")[0]! : null,
      children: p?.navPoint ? ncxEntries(p.navPoint) : [],
    };
  });
}

/** 目录条目 href 换算为 OPF 相对路径（base = 目录文件所在目录，OPF 相对，以 / 结尾或为空） */
function resolveEntryHrefs(entries: TocEntry[], base: string): void {
  if (!base) return;
  for (const e of entries) {
    if (e.href) {
      const segments = (base + e.href).split("/");
      const out: string[] = [];
      for (const seg of segments) {
        if (seg === "." || seg === "") continue;
        if (seg === "..") out.pop();
        else out.push(seg);
      }
      e.href = out.join("/");
    }
    resolveEntryHrefs(e.children, base);
  }
}

function findFirstTag(el: Element, name: string): Element | null {
  for (const c of el.children) {
    if (c.type !== "tag") continue;
    const child = c as Element;
    if (child.name === name) return child;
    const found = findFirstTag(child, name);
    if (found) return found;
  }
  return null;
}

// ===== XHTML 正文提取 =====
export interface ExtractOptions {
  /** 插图引用收集（名字 → 原路径/图注），parseEpub 后统一读二进制 */
  imageRefs: EpubImage[];
  /** 图片回调: 返回重命名后的资源名（不含路径） */
  onImage: (img: { sourcePath: string; caption?: string }) => string;
}

export function extractBlocksFromXhtml(html: string, opts?: ExtractOptions): EpubParagraph[] {
  const doc = parseDocument(html);
  const blocks: EpubParagraph[] = [];

  const walkBlock = (nodes: ChildNode[]) => {
    for (const node of nodes) {
      if (node.type !== "tag") continue;
      const el = node as Element;
      const name = el.name.toLowerCase();

      if (name === "img") {
        // 独立插图（不在段落内）
        const src = el.attribs.src ?? "";
        const caption = el.attribs.alt ?? el.attribs.title;
        if (opts) {
          const resourceName = opts.onImage({ sourcePath: src, caption });
          opts.imageRefs.push({ name: resourceName, sourcePath: src, caption });
          blocks.push({ text: `[插图: ${resourceName.replace(/\.[a-z0-9]+$/i, "")}]`, kind: "text" });
        }
        continue;
      }
      if (name === "figcaption") {
        blocks.push({ text: inlineText(el, opts), kind: "text" });
        continue;
      }
      if (HEADING_TAGS.has(name)) {
        blocks.push({ text: inlineText(el, opts), kind: "heading" });
        continue;
      }
      if (BLOCK_TAGS.has(name)) {
        blocks.push({ text: inlineText(el, opts), kind: "text" });
        continue;
      }
      if (CONTAINER_TAGS.has(name) || name === "figure" || name === "table") {
        walkBlock(el.children);
      }
      // 其他标签（header/footer/script/style/nav）忽略
    }
  };

  walkBlock(doc.children);
  return blocks.filter((b) => b.text.trim().length > 0);
}

/** 内联文本提取（格式标记 + ruby 双轨 + 插图） */
function inlineText(el: Element, opts?: ExtractOptions): string {
  let out = "";
  for (const child of el.children) {
    out += nodeText(child, opts);
  }
  return out;
}

function nodeText(node: ChildNode, opts?: ExtractOptions): string {
  if (node.type === "text") {
    return (node as Text).data;
  }
  if (node.type !== "tag") return "";
  const el = node as Element;
  const name = el.name.toLowerCase();

  switch (name) {
    case "em":
    case "i":
      return `*${inlineText(el, opts)}*`;
    case "strong":
    case "b":
      return `**${inlineText(el, opts)}**`;
    case "br":
      return "\n";
    case "img": {
      if (!opts) return "";
      const src = el.attribs.src ?? "";
      const caption = el.attribs.alt ?? el.attribs.title;
      const resourceName = opts.onImage({ sourcePath: src, caption });
      opts.imageRefs.push({ name: resourceName, sourcePath: src, caption });
      return `[插图: ${resourceName.replace(/\.[a-z0-9]+$/i, "")}]`;
    }
    case "ruby": {
      return rubyText(el, opts);
    }
    case "rt":
    case "rp":
      return "";
    default:
      return inlineText(el, opts);
  }
}

/** ruby 双轨：平假名注音剥离 · 片假名注音标记传递 */
function rubyText(el: Element, opts?: ExtractOptions): string {
  // 结构: <ruby>基礎<rt>注音</rt></ruby> 或 <ruby><rb>基礎</rb><rt>注音</rt></ruby>
  let base = "";
  let rt = "";
  for (const child of el.children) {
    if (child.type !== "tag") {
      base += (child as Text).data;
      continue;
    }
    const c = child as Element;
    if (c.name === "rt" || c.name === "rp") {
      rt = textOf(c);
    } else if (c.name === "rb") {
      base += textOf(c);
    } else {
      base += nodeText(c, opts);
    }
  }
  if (!rt) return base;
  if (KATAKANA_RE.test(rt)) {
    // 片假名注音（双重阅读候选）→ 标记传递
    return `${base}(${rt})`;
  }
  // 平假名注音（标准读音/名字读法）→ 剥离
  return base;
}

// ===== 卷标题识别 =====
const VOLUME_RE = /^\s*(?:第([一二三四五六七八九十百千万0-9０-９]+)[巻卷]|Vol\.?\s*([0-9]+))\s*[:：\-—]?/;

const CN_NUM: Record<string, string> = {
  一: "1", 二: "2", 三: "3", 四: "4", 五: "5",
  六: "6", 七: "7", 八: "8", 九: "9", 十: "10",
  百: "100", 千: "1000", 万: "10000",
  "０": "0", "１": "1", "２": "2", "３": "3", "４": "4", "５": "5",
  "６": "6", "７": "7", "８": "8", "９": "9",
};

export function detectVolumeTitle(text: string): string | null {
  const m = VOLUME_RE.exec(text);
  if (!m) return null;
  let num = m[1] ?? m[2] ?? "";
  if (num.length === 0) return null;
  if (/[一二三四五六七八九十百千万]/.test(num)) {
    num = num
      .split("")
      .map((c) => CN_NUM[c] ?? c)
      .join("");
  }
  const n = parseInt(num, 10);
  if (Number.isNaN(n) || n <= 0) return null;
  return `v${String(n).padStart(2, "0")}`;
}

// ===== 工具 =====
function textOf(el: Element): string {
  let out = "";
  for (const c of el.children) {
    if (c.type === "text") out += (c as Text).data;
    else if (c.type === "tag") out += textOf(c as Element);
  }
  return out;
}

async function readText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) throw new Error(`EPUB 缺少文件: ${path}`);
  return file.async("string");
}
