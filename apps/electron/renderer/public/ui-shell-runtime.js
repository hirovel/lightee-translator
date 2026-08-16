/* Generated from renderer/shell/ui-shell.html by scripts/sync-ui-shell.mjs. */
const stage = document.getElementById("stage");
const label = document.getElementById("label");
const prev = document.getElementById("prev");
const next = document.getElementById("next");
if (!stage || !label || !prev || !next) {
  throw new Error("Lightee prototype shell is incomplete");
}
const renderOnlyRuntime=window.__lighteeRenderOnlyRuntime===true;
// ===== 数据 =====
const STYLES={approved:'#4ade80',translated:'#60a5fa',translating:'#fbbf24',ready:'#718096',imported:'#4a5568'};
const LOGO=[
"   ✦  lightee",
"   ───────────",
];
/* 纯框架（作者裁定 2026-08-15）：外壳不再自带任何演示正文。
   从前这里躺着三段小说原文/译文、一份术语表和两条审校样例——独立打开设计稿时
   它们是预览内容，但发布后的软件仓库里不该有任何小说散文，哪怕是自撰的：
   演示散文的存在本身就是「往里粘真书更方便」的斜坡（上一批版权素材正是这么积累的）。
   结构保留、内容清空：所有渲染路径对空数据本来就有对应的空状态。 */
const DEMO_ROWS=[];
const TERMS=[];
const REVIEW_ISSUES={};
const REVIEW_STATUS={};
const REVIEW_INVALIDATED={};
const TRANSLATION_DRAFTS={};
function reviewPendingCount(){return Object.keys(REVIEW_STATUS).filter(paraId=>REVIEW_STATUS[paraId]==='open'&&!REVIEW_INVALIDATED[paraId]).length}
function translationCanEdit(){return chapterPhase==='approved'||chapterPhase==='revising'}
// —— 待审术语卡（v21: 左栏章节下方弹出）——
/* 纯框架：不再自带演示卡（这里从前的样例卡还残留着上一批被清除素材的人名）。
   队列耗尽的空状态是既有 UI，从空开始走的就是它。 */
const PENDING_CARDS=[];
let pendingIdx=0;
let pendingOpen=false;

/**
 * 真实应用判定（RH-12 / renderer-dom-ownership.md §2）。
 *
 * prototype-runtime 是设计稿运行时，它自带一整套 demo 数据（PENDING_CARDS / TERMS /
 * SIM / chapterPhase…）。在设计稿里那是内容，**在真实应用里那是假数据**——它会盖掉
 * workspace-bridge 从 IPC 读来的真实值，用户看到的是「术语待确认 5」「token 2481」
 * 这类凭空出现的数字。
 *
 * 因此：bridge 一旦挂载，任何由 demo 常量推导出来的写入都必须让位。
 * 这不是「尽量避免」——画错的状态比不画更坏，用户没法分辨哪个数字能信。
 */
/**
 * 「我是不是跑在真实应用里」。
 *
 * 判据必须是 preload 注入的 `window.lightee`——它在首帧之前就存在。
 * 曾经用 `__lighteeWorkspaceBridge`，那是 workspace-bridge **异步挂载完**才写的标记，
 * 于是首帧到挂载之间存在一个窗口期：设计稿骨架与 demo 数据会真真切切地渲染出来，
 * 用户看到的是「设计稿骨架：真实应用中此处为快捷设置」这类本不该出现的字。
 * 挂载后的标记保留为兜底（真实应用两者都有；独立打开设计稿两者都没有）。
 */
function lighteeReal(){return typeof window!=='undefined'&&(!!window.lightee||!!window.__lighteeWorkspaceBridge)}

/**
 * 线框小图标。设置界面的标题此前挂的是彩色 emoji（⚙ 🗂 ◈）——它们自带一套
 * 与本界面无关的配色和圆润造型，跟旁边的发丝分隔线、单色 chip 不是同一门语言，
 * 而且在不同系统上长相还不一样。这里改成统一的描边图标：16 视框、1.3 描边、
 * 继承当前文字颜色，跟界面里其他线条同宽。
 */
const UI_ICONS={
  edit:'<path d="M3 13.1h2.4l7.2-7.2-2.4-2.4L3 10.7z"/><path d="M9.9 4.4l2.4 2.4"/>',
  folder:'<path d="M2.2 12.8V3.9h4l1.4 1.7h6.2v7.2z"/>',
  sliders:'<path d="M2 5h12M2 11h12"/><circle cx="5.8" cy="5" r="1.7"/><circle cx="10.2" cy="11" r="1.7"/>',
  translate:'<path d="M1.8 3.2h6.6v4.6H4.9L3 9.6V7.8H1.8z"/><path d="M7.6 6.9h6.6v4.6h-1.3v2l-2-2H7.6z"/>',
  appearance:'<circle cx="8" cy="8" r="5.4"/><path d="M8 2.6a5.4 5.4 0 0 1 0 10.8z" fill="currentColor" stroke="none" opacity=".3"/>',
  chip:'<rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.2"/><path d="M6.6 2.2v2.2M9.4 2.2v2.2M6.6 11.6v2.2M9.4 11.6v2.2M2.2 6.6h2.2M2.2 9.4h2.2M11.6 6.6h2.2M11.6 9.4h2.2"/>',
  toggle:'<rect x="1.8" y="5" width="12.4" height="6" rx="3"/><circle cx="11.2" cy="8" r="1.9"/>',
  clipboard:'<path d="M5.6 3.2H4a.8.8 0 0 0-.8.8v9.2a.8.8 0 0 0 .8.8h8a.8.8 0 0 0 .8-.8V4a.8.8 0 0 0-.8-.8h-1.6"/><rect x="5.6" y="1.8" width="4.8" height="2.6" rx=".8"/>',
  file:'<path d="M9 1.8H4.6a.8.8 0 0 0-.8.8v10.8a.8.8 0 0 0 .8.8h6.8a.8.8 0 0 0 .8-.8V4.6z"/><path d="M9 1.8v2.8h3.2"/>',
};
function icon(name){return '<svg class="ui-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'+(UI_ICONS[name]||'')+'</svg>'}

/* 纯框架：计量全部归零。凭空的「token 2481 · 缓存 70%」是假数字，
   真值由 bridge 从 usage 事件里写。 */
const SIM={
  t1:0,t2:0,t3:0,token:0,cache:0,cost:0,hist:[],
  ctx:{term:0,tr1:0,tr2:0,rev:0},
  savedTokens:0,savedCost:0,
};

// v53: 多书模型（书 → 卷 → 章）——同时打开多本书，各书进度独立。
// 纯框架：只留一个空书骨架撑住 BOOKS[currentBook] 的解引用（约 20 处），
// 卷、章、术语全空——真实的树由 bridge 从 workspace.list 画。
const BOOKS={
  'workspace':{title:'工作区',path:'',vols:[]},
  _terms:{},
};
let currentBook='workspace';
// ===== 主界面（B 定案版）：三区 =====
let bTab='terms';
let viewMode='continuous'; // 连续编辑：原文上下文 + 单一译文编辑流
let chapterPhase='terms'; // terms → ready → translating → approved → revising
let authorAction=null;
let authorSelectionBound=false;
let authorInputBound=false;
let termSurface='queue';
let termDirectoryQuery='';
let termDirectoryFilter='all';
let termDirectorySort='recent';
let termDirectoryPage=1;
let termDirectoryPageSize=5;
let termDirectoryEditingId='';
let termDirectorySelected=[];
let termSync=null;
// 纯框架：术语同步的演示命中列表清空——这套种子只在独立打开设计稿、
// 点击演示术语行时可达，而演示术语行本身已经不存在了。
const TERM_SYNC_SEEDS={};
function renderMain(){
  return `<div class="main">
    <div class="side">
      <div class="side-drop-hint" aria-hidden="true"><span class="drop-ico">📥</span><span class="drop-txt">松手导入小说</span><span class="drop-sub">TXT / MD / EPUB</span></div>      <div class="side-drop-toast" data-side-drop-toast aria-live="polite"></div>
      <!-- v53: 书下拉 + 卷分组章节列表 -->
      <div class="book-tabs" id="book-tabs">${renderBookTabs()}</div>
      <div class="list" id="chapter-list" style="position:relative">${renderChapterList()}</div>
      <!-- v21: 术语表段（折叠） -->
      <div class="side-sec collapsed-sec" id="terms-sec">
        <div class="sec-head terms-sec-head" role="button" tabindex="0" data-key-action aria-controls="terms-body" aria-expanded="false" onclick="toggleSec('terms')"><span class="terms-sec-title">▚ 术语表 <span id="terms-count" class="terms-count">${lighteeReal()?'':currentTerms().length}</span><span id="terms-pending-mini" class="terms-pending-mini">${lighteeReal()?'':'待确认 '+(PENDING_CARDS.length-pendingIdx)}</span></span><span class="terms-sec-actions"><span class="terms-open-link" role="button" tabindex="0" data-key-action onclick="event.stopPropagation();setTermSurface('directory');selectMainTab('terms')">打开目录 →</span><span class="sec-arrow">▼</span></span></div>
        <div class="sec-body collapsed" id="terms-body" style="max-height:160px">${lighteeReal()?'':renderTermList()}</div>
      </div>
      <!-- v21 的「状态」段已删（作者裁定 2026-08-13）：那五行（阅读轮/术语提取/翻译/审校/导出）
           是写死的常量，从来不会更新；「阅读轮」这个阶段随译前提取退役后早就不存在了。
           真实进度在下方 foot 的进度条与 token 里，一块永远不动的仪表只会误导。 -->
      <!-- Agent 控制台（侧栏快捷入口 → 跳转 Agent tab） -->
      <div class="side-sec" id="agent-sec">
        <div class="sec-head" role="button" tabindex="0" onclick="selectMainTab('agent')"><span>▤ Agent 控制台</span><span class="open-link">打开 →</span></div>
      </div>
      <div class="foot">
        <div style="display:flex;justify-content:space-between"><span>进度</span><span id="side-progress-text">—</span></div>
        <div class="gbar" style="margin:3px 0"><div class="gfill green" id="side-progress-bar" style="width:0%"></div></div>
        <div style="display:flex;justify-content:space-between"><span>token</span><span id="m-token">0</span></div>
      </div>
    </div>
    <div class="center">
      <div class="center-header workbench-header">
        <div class="b-id">
          <span class="b-kicker" id="header-kicker"></span>
          <h1 id="header-chapter-title"></h1>
        </div>
        <div class="b-info" id="b-info">
          <div class="info-cell" id="info-cell" role="button" tabindex="0" title="点击进入对应面板">
            <div class="ic-top"><span class="ic-label" id="ic-label">术语确认</span><span class="ic-val" id="ic-val"><b>3/5</b></span></div>
            <div class="ic-track" id="ic-track"><i style="width:60%"></i></div>
            <div class="ic-detail" id="ic-detail">5 个待确认 · 点击进入</div>
          </div>
        </div>
        <div class="b-meta">
          <span class="bm-save"><span class="status-dot"></span>自动保存 · 原文只读</span>
          <span class="bm-src"><button class="toggle-src" id="toggle-src" type="button" title="显示/隐藏日文原文"><span class="dot"></span>原文</button><button class="toggle-src" id="edit-source" type="button" title="编辑日文原文" style="display:none">✎ 编辑原文</button></span>
        </div>
      </div>
      <div class="tabs workflow-tabs" role="tablist" aria-label="章节工作流">
        ${(()=>{
          const pending=pendingIdx<PENDING_CARDS.length;
          // 徽标三态（与 terminology-view.ts 的 termBadgeView 同一套语义）：
          //   数字 = 待确认 N 项 · 'ok' = 已确认 · 0 = 中性占位（未提取/待接管）
          // 从前是两态：`badge>0?badge:'✓'`——真实工作区一进来 badge 恒为 0，于是
          // 刚导入、一条术语都没有也顶着个绿勾。骨架不知道真状态时就不该替它下结论，
          // 真实状态随后由 bridge 的 updateTermBadge 接管。
          const tab=(key,label,badge,primary)=>{
            const mark=badge===null?null:badge==='ok'?{text:'✓',cls:'ok'}:badge>0?{text:String(badge),cls:'warn'}:{text:'–',cls:'idle'};
            return `<span class="tab workflow-tab ${bTab===key?'on':''}${primary?' workflow-tab-primary':''}" role="tab" tabindex="0" data-key-action data-btab="${key}" aria-selected="${bTab===key}"><span class="workflow-tab-main">${label}${mark?` <b class="workflow-tab-badge ${mark.cls}">${mark.text}</b>`:''}</span></span>`;
          };
          // 始终显示三 tab：正文编辑永远可进（作者可无 AI 翻译）；术语/审校带状态徽标
          return tab('bi','正文编辑',null,true)+tab('terms','术语确认',lighteeReal()?0:(pending?PENDING_CARDS.length-pendingIdx:'ok'))+tab('review','审校',null)+tab('agent','Agent 控制台',null);
        })()}
      </div>
      <div class="content" id="bpanel"></div>
      <!-- v77: 有内容才占位的事件抽屉；入口合并进底部状态栏 -->
      <div class="event-dock closed" id="event-dock">
        <div class="event-dock-head">
          <span class="event-dock-title">活动</span>
          <span class="event-dock-subtitle">本章最近事件</span>
          <span class="event-dock-actions">
            <span class="ev-ico" role="button" tabindex="0" data-key-action aria-label="清空事件流" title="清空事件流" onclick="clearEvents()">清空</span>
            <span class="ev-ico" id="ev-toggle" role="button" tabindex="0" data-key-action aria-label="收起事件流" title="收起事件流" onclick="toggleEvents()">收起</span>
          </span>
        </div>
        <div id="ev-list"></div>
      </div>
      <div class="busy-card" id="busy-card" role="status" aria-live="polite">
        <span class="busy-spin" aria-hidden="true"></span>
        <span class="busy-main">
          <span class="busy-line"><span class="busy-what" id="busy-what">任务进行中</span><span class="busy-time" id="busy-time">0 秒</span></span>
          <span class="busy-sub" id="busy-sub"></span>
          <span class="busy-note" id="busy-note"></span>
          <!-- 思考直播（TR-04）：运行中打字机滚动，结束后折叠成一行摘要。
               秒表只能说明「还没停」，这一行说明「在想什么」。 -->
          <span class="busy-think" id="busy-think" hidden>
            <button class="busy-think-head" id="busy-think-head" type="button" aria-expanded="false">
              <span class="busy-think-caret" aria-hidden="true">▸</span>
              <span class="busy-think-summary" id="busy-think-summary"></span>
            </button>
            <span class="busy-think-tail" id="busy-think-tail"></span>
            <span class="busy-think-full" id="busy-think-full" hidden></span>
          </span>
          <!-- 正文直播：轮 2 的二十来秒是正文在流式产出，此前那段时间界面上什么都没有，
               而思考块还标着 running，显示成「正在思考」。光流扫过的是**刚到达的那一段**，
               不是装饰——它标记的是真实的产出位置。 -->
          <span class="busy-body" id="busy-body" hidden>
            <span class="busy-body-head" id="busy-body-head"></span>
            <span class="busy-body-text" id="busy-body-text"></span>
          </span>
          <!-- 会话式时间轴：忙碌卡此前只答「还没停」与「在想什么」，答不了
               「刚才那两分钟经过了哪些环节」。这一段把观测到的阶段按序摊开。 -->
          <span class="busy-flow" id="busy-flow" hidden>
            <button class="busy-flow-head" id="busy-flow-head" type="button" aria-expanded="false">
              <span class="busy-flow-caret" aria-hidden="true">▸</span>
              <span class="busy-flow-summary" id="busy-flow-summary">运行流水</span>
            </button>
            <span class="busy-flow-list" id="busy-flow-list" hidden></span>
          </span>
          <!-- 快捷去处：出问题时最想去的三个地方，不必自己找 -->
          <span class="busy-jump" id="busy-jump" hidden>
            <button class="busy-jump-btn" type="button" data-busy-jump="agent">Agent 控制台</button>
            <button class="busy-jump-btn" type="button" data-busy-jump="chapter">本章译文</button>
            <button class="busy-jump-btn" type="button" data-busy-jump="review">审校面板</button>
          </span>
        </span>
      </div>
      <div class="footer">
        <!-- 状态区只留一条「此刻在做什么」。
             原本三格（术语/翻译/审校）里，翻译与审校复述的是章节树与侧栏进度条已经说过的话；
             术语那格则被长消息（如「思考能力探测完成: … (7/7 档可用)」）占满，把右侧
             度量与操作整排挤出可视区。一条会截断的活动行既不重复也不会撑破布局，
             空闲时整格隐藏，让页脚安静下来。 -->
        <!-- 左区只说「此刻在做什么」。翻译进度与 token 都已在侧栏常驻，
             底栏再放一份是同一个数字说两遍（作者裁定 2026-08-13）。空着就空着。 -->
        <!-- 左端：「活动」入口 + 正在做什么。两者是同一件事的两半——数字说有多少条，
             文字说此刻这条是什么，所以放在一起，且贴住左边缘。 -->
        <div class="footer-state">
          <span class="event-launch" id="ev-launch" role="button" tabindex="0" data-key-action title="展开/收起事件流" onclick="toggleEvents()">活动 <b class="event-count" id="ev-count">0</b></span>
          <span class="sys-agent" id="footer-activity" hidden><span class="agent-pip" id="footer-activity-pip"></span><span class="sa-text" id="footer-activity-text"></span></span>
          <!-- token 计数只留侧栏那一处（作者裁定 2026-08-13）：两处显示同一个数字，
               一处更新慢半拍就成了两个互相矛盾的事实。#sys-token 保留为隐藏节点，
               设计稿与既有更新代码的引用不必因此分叉。 -->
          <span class="footer-metric footer-token" hidden><span id="sys-token">0</span><small>tok</small></span>
        </div>
        <!-- 底栏动作区（重设计 2026-08-13）。
             从前每个 chip 都挂一枚 kbd 小方块：5 个按钮拖着 9 个小方块，
             一条状态栏被键位标签占掉大半，而这些键位在 Ctrl+/ 面板里本来就列着。
             现在键位只留在悬停提示与那份面板里，底栏只放动作本身，并按分量分组：
             主操作 → 本章工作（检查/导出）→ ｜ → 元操作（快捷键/设置，压暗）。 -->
        <div class="footer-actions">
          <!-- 默认文案必须是「无论如何都成立」的那一句：真实应用里 bridge 接管前会短暂
               显示它。EX-07 之后术语确认不再是翻译的前置条件，「先处理术语」既不是当前
               状态、也不是正确的下一步——它只是这里写死了很久没人改。 -->
          <span class="chip main-act" id="main-act-btn" title="开始翻译本章（Ctrl+T）" onclick="startTranslate()">开始翻译</span>
          <!-- 从前这里是「审校」：onclick 只往事件流写一行字，Ctrl+R 全代码库无人处理——
               一个假按钮配一个假快捷键。换成真实存在的动作：本章检查（确定性扫描）。 -->
          <span class="chip" title="对本章跑一遍确定性检查：引号配对 / 整段未译 / 禁翻词等，不调用 AI（Ctrl+R）" onclick="runChapterCheck()">本章检查</span>
          <span class="chip" title="导出译文（Ctrl+X）" onclick="toggleExport()">导出</span>
          <span class="footer-sep" aria-hidden="true"></span>
          <span class="chip quiet" title="快捷键一览（Ctrl+/）" onclick="window.__lighteeToggleShortcuts?.()">快捷键</span>
          <span class="chip quiet" title="设置（Ctrl+,）" onclick="openSettings()">设置</span>
          <!-- 「已保存」贴住右端收尾。它是状态不是动作，混在按钮之间读起来像第六个按钮；
               和左端的「活动」一左一右，中间留给正在做什么。用间距与它前面的按钮拉开，
               不再加竖线——那条线只会让底栏多一道栅栏。 -->
          <span class="footer-save" title="编辑会自动保存，不需要手动保存"><span class="status-dot"></span>已保存</span>
        </div>
      </div>
    </div>
  </div>`;
}

// 纯框架：不预选章节——骨架书里没有章节，真实章节 id 由 bridge 在 openChapter 时写入
let curChapter='';
let editingVol=null,editingChapter=null;
// v56 变体探索: 编辑方式 A=contenteditable B=模拟输入 C=浮层 · Tab 模式 A=⋯溢出 B=当前书+下拉 C=滚动
function openChapter(id){
  curChapter=id;
  // 卷归属一律问真实 DOM（同 moveCursor v102 的教训）：
  // 从前问的是 BOOKS 模拟数据，真实工作区里只有恰好与模拟数据同 id 的头两章能对上，
  // 之后的章节要么点亮错的卷、要么一个都不亮，收起的卷也不会自动展开。
  const list=document.getElementById('chapter-list');
  const volId=list?.querySelector('.item[data-cid="'+id+'"]')?.dataset.vol;
  const body=volId?list.querySelector('.vol-body[data-vol="'+volId+'"]'):null;
  const wasClosed=Boolean(body&&!body.classList.contains('open'));
  if(wasClosed)setVolumeOpenById(volId,true);
  syncCurrentVolume();
  const cursor=document.getElementById('ch-cursor');
  if(wasClosed&&cursor)cursor.style.opacity='0';
  if(wasClosed)setTimeout(()=>moveCursor(true),290);
  else moveCursor();
  pushEvent('打开章节 '+id,'act');
}
// kitty 式光标：高亮条滑到当前章（transform/transition 平滑）
// v102: 纯 DOM 驱动（不依赖 BOOKS 模拟数据），bridge 真实树也可用
function moveCursor(snap=false){
  const list=document.getElementById('chapter-list');
  const cur=list?list.querySelector('.item[data-cid="'+curChapter+'"]'):null;
  let c=document.getElementById('ch-cursor');
  if(!list)return;
  if(!cur){if(c)c.style.opacity='0';return}
  // 卷是否展开：查 item 所在卷体 .open（真实树/模拟树通用）
  const volId=cur.dataset.vol;
  const volBody=volId?list.querySelector('.vol-body[data-vol="'+volId+'"]'):null;
  const volOpen=volBody?volBody.classList.contains('open'):true;
  if(!volOpen){if(c)c.style.opacity='0';return}
  const fresh=!c;
  if(fresh){
    c=document.createElement('div');
    c.id='ch-cursor';c.className='ch-cursor';
    list.insertBefore(c,list.firstChild);
  }
  const placeWithoutSlide=fresh||snap;
  if(placeWithoutSlide)c.classList.add('placing');
  const lr=list.getBoundingClientRect();
  const cr=cur.getBoundingClientRect();
  c.style.height=Math.round(cr.height)+'px';
  c.style.top=Math.round(cr.top-lr.top+list.scrollTop)+'px';
  if(placeWithoutSlide){
    c.style.opacity='0';
    c.getBoundingClientRect();
    setTimeout(()=>{c.classList.remove('placing');c.style.opacity='1'},0);
  }else c.style.opacity='1';
}
function renderBookTabs(){
  // v59: 下拉模式——当前书标签舒展占满 + ＋ 固定右端
  // v74: 单栏收敛——书名即切换入口（触发器内嵌书名+路径），＋ 固定右端
  return `<div class="book-bar">
    <div class="cs" id="cs-book" style="flex:1;min-width:0"></div>
    <span class="book-add" role="button" tabindex="0" data-key-action aria-label="打开工作区选择器" title="添加书（打开工作区）" onclick="pushEvent(&quot;打开工作区选择器&quot;,&quot;act&quot;)">＋</span>
  </div>`;
}
function renderBookCs(){
  const el=document.getElementById('cs-book');
  if(!el)return;
  const opts=Object.keys(BOOKS).map(id=>({v:id,label:BOOKS[id].title,sub:BOOKS[id].path}));
  const b=BOOKS[currentBook];
  const trig=`<span class="trig-title" title="${b.title}">${b.title}</span>`;
  renderCs(el,opts,currentBook,(v)=>{switchBook(v);closeAllCs()},trig);
}
function refreshBookCs(){renderBookCs()}
function switchBook(id){
  if(!BOOKS[id])return;
  currentBook=id;
  // 只重渲染章节树 + 刷新书栏 trigger，不重建 book-bar（避免下拉刷新感）
  const cl=document.getElementById('chapter-list');
  if(cl){cl.innerHTML=renderChapterList();cl.style.animation='none';void cl.offsetWidth;cl.style.animation='listIn .25s ease';}
  refreshBookCs();
  moveCursor();
  pushEvent('切换书 → '+BOOKS[id].title,'act');
}
function closeBook(id){
  if(Object.keys(BOOKS).length<=1){pushEvent('至少保留一本书','err');return}
  delete BOOKS[id];
  if(currentBook===id)currentBook=Object.keys(BOOKS)[0];
  document.getElementById('book-tabs').innerHTML=renderBookTabs();
  rerenderChapterList();
  setTimeout(refreshBookCs,0);
  pushEvent('已关闭 '+id+'（进度保留在文件系统）','act');
}
function findVol(v){return BOOKS[currentBook].vols.find(x=>x.v===v)}
function findChapter(id){return BOOKS[currentBook].vols.flatMap(x=>x.chapters).find(c=>c.id===id)}
// v60 重写: 编辑交互——DOM 局部替换（不重渲染列表），一次点击即编辑
function beginEdit(kind,id,btn){
  if(!btn)return;
  const titleEl=btn.previousElementSibling;
  if(!titleEl||titleEl.tagName==='INPUT')return;
  const tgt=kind==='vol'?findVol(id):findChapter(id);
  if(!tgt)return;
  if(kind==='vol')editingVol=id;else editingChapter=id; // 防卷折叠/章打开
  const host=btn.closest('.vol-head,.item');
  if(host)host.classList.add('editing');
  const inp=document.createElement('input');
  inp.className='ed-sim';
  inp.value=tgt[kind==='vol'?'name':'title'];
  inp.onclick=(e)=>e.stopPropagation();
  inp.onkeydown=(e)=>{if(e.key==='Enter'){e.preventDefault();saveEdit(kind,id,inp)}else if(e.key==='Escape'){cancelEdit(kind,id,inp)}};
  inp.onblur=()=>saveEdit(kind,id,inp);
  titleEl.replaceWith(inp);
  btn.style.display='none'; // 原位隐藏 ✎，保存/取消后恢复；不再显示 ✓/✕ 按钮
  inp.focus();inp.select();
}
function saveEdit(kind,id,inp){
  if(!inp||inp.dataset.done)return;
  inp.dataset.done='1';
  const tgt=kind==='vol'?findVol(id):findChapter(id);
  const val=inp.value.trim();
  if(tgt&&val)tgt[kind==='vol'?'name':'title']=val;
  restoreEdit(kind,id,inp,val||(tgt?tgt[kind==='vol'?'name':'title']:''));
  if(kind==='vol')editingVol=null;else editingChapter=null;
  pushEvent('✓ '+(kind==='vol'?'卷名':'章名')+'已更新','ok');
}
function cancelEdit(kind,id,inp){
  if(!inp||inp.dataset.done)return;
  inp.dataset.done='1';
  const tgt=kind==='vol'?findVol(id):findChapter(id);
  restoreEdit(kind,id,inp,tgt?tgt[kind==='vol'?'name':'title']:'');
  if(kind==='vol')editingVol=null;else editingChapter=null;
}
function restoreEdit(kind,id,inp,text){
  // 找到原位隐藏的 ✎（replaceWith 后 inp 脱离 DOM，用 titleEl.nextElementSibling 找回）
  const host=inp.closest('.vol-head,.item');
  if(host)host.classList.remove('editing');
  const titleEl=document.createElement('span');
  titleEl.className=kind==='vol'?'vol-title':'it-title';
  titleEl.textContent=text;
  if(kind==='vol'){
    titleEl.append(' ');
    const mark=document.createElement('span');mark.className='vol-current';mark.textContent='◈';
    titleEl.append(mark);
  }
  inp.replaceWith(titleEl);
  const btn=titleEl.nextElementSibling;
  if(btn&&(btn.classList.contains('vol-edit')||btn.classList.contains('ch-edit')))btn.style.display='';
}

function beginNewChapter(v){
  const book=BOOKS[currentBook];
  const vol=book?.vols.find(x=>x.v===v);
  if(!vol)return;
  // 原型：用内存数据新建占位章节；真实落盘走 IPC（后续接线）。
  const id='ch'+String(Date.now()).slice(-3);
  const chapter={id,title:'新章节',state:'imported',icon:'○'};
  vol.chapters.push(chapter);
  rerenderChapterList();
  setVolumeOpen(vol,true);
  const list=document.getElementById('chapter-list');
  const item=list?.querySelector('.item[data-cid="'+id+'"]');
  if(item){
    item.scrollIntoView({block:'nearest'});
    const btn=item.querySelector('.ch-edit');
    if(btn)beginEdit('chap',id,btn);
  }
  // 进入 CodeMirror 编辑态（占位：中央显示空白编辑区）
  curChapter=id;
  const bpanel=document.getElementById('bpanel');
  if(bpanel)bpanel.innerHTML='<div class="empty-state" style="padding:40px 20px;text-align:center;color:var(--dimmer);font-size:13px"><div class="big" style="font-size:30px;margin-bottom:10px">✎</div>新建章节 · 可在此粘贴内容（CodeMirror 接入中）</div>';
  pushEvent('＋ 新建章节 · 可粘贴内容','act');
}
// ===== 通用提示系统：所有弹出提示统一显示在标题栏正中 =====
// 用法：
//   showToast('消息')                        → 信息提示（默认 3s）
//   showToast('消息',{duration:5000})        → 自定义时长
//   showToast('已删除…',{undo:fn})           → 带「撤销」按钮（默认 5s，点击执行 undo）
//   window.showToast 供 bridge / 后续模块复用
let toastTimer=null;
function showToast(msg,opts={}){
  const {undo=null,duration=3000}={...opts};
  let t=document.getElementById('titlebar-toast');
  if(!t){t=document.createElement('div');t.id='titlebar-toast';t.className='titlebar-toast';document.body.appendChild(t)}
  t.innerHTML='<span>'+msg+'</span>'+(undo?'<span class="undo-btn">撤销</span>':'');
  t.classList.add('show');
  const btn=t.querySelector('.undo-btn');
  if(btn){btn.onclick=(e)=>{e.stopPropagation();t.classList.remove('show');if(undo)undo()}}
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),duration);
}
// 兼容旧名：带撤销按钮的删除提示（5s）
function showUndoToast(msg,undoFn){
  showToast(msg,{undo:undoFn,duration:5000});
}
function beginDeleteChapter(id,btn){
  const chapter=findChapter(id);
  if(!chapter)return;
  const isTranslated=chapter.state==='approved'||chapter.state==='translated'||chapter.state==='translating'||chapter.state==='reviewing'||chapter.state==='revising';
  if(isTranslated&&!btn.classList.contains('confirm')){btn.classList.add('confirm');btn.textContent='确认？';setTimeout(()=>{btn.classList.remove('confirm');btn.textContent='删'},2600);return}
  btn.classList.remove('confirm');btn.textContent='删';
  const vol=BOOKS[currentBook].vols.find(v=>v.chapters.some(c=>c.id===id));
  const idx=vol?vol.chapters.findIndex(c=>c.id===id):-1;
  if(!vol||idx<0)return;
  const removed=vol.chapters.splice(idx,1)[0];
  if(curChapter===id){curChapter=vol.chapters[0]?.id||'';const bpanel=document.getElementById('bpanel');if(bpanel)bpanel.innerHTML=''}
  rerenderChapterList();
  const undoId=pushUndo('删除章节《'+removed.title+'》',()=>{vol.chapters.splice(Math.min(idx,vol.chapters.length),0,removed);rerenderChapterList()});
  showUndoToast('已删除章节《'+removed.title+'》',()=>undoById(undoId));
  pushEvent('已删除章节《'+removed.title+'》 <span class="ev-undo" data-action="undo" data-undo-id="'+undoId+'">↩ 撤回</span>','err');
}
function beginDeleteVolume(v){
  const vol=findVol(v);
  if(!vol)return;
  // 卷删除需两次确认（更强）
  const btn=document.querySelector('.vol-head[data-vol="'+v+'"] .vol-del');
  if(btn&&!btn.classList.contains('confirm')){btn.classList.add('confirm');btn.textContent='确认？';setTimeout(()=>{btn.classList.remove('confirm');btn.textContent='删'},2600);return}
  if(btn){btn.classList.remove('confirm');btn.textContent='删'}
  const book=BOOKS[currentBook];
  const idx=book.vols.findIndex(x=>x.v===v);
  if(idx<0)return;
  const removed=book.vols.splice(idx,1)[0];
  const count=removed.chapters.length;
  rerenderChapterList();
  const undoId=pushUndo('删除卷《'+removed.name+'》',()=>{book.vols.splice(Math.min(idx,book.vols.length),0,removed);rerenderChapterList()});
  showUndoToast('已删除卷《'+removed.name+'》'+(count?'（'+count+' 章）':''),()=>undoById(undoId));
  pushEvent('已删除卷《'+removed.name+'》'+(count?'（'+count+' 章）':'')+' <span class="ev-undo" data-action="undo" data-undo-id="'+undoId+'">↩ 撤回</span>','err');
}
function setVolumeOpenById(volId,open){
  if(!volId)return;
  const list=document.getElementById('chapter-list');
  const head=list?.querySelector('.vol-head[data-vol="'+volId+'"]');
  const body=list?.querySelector('.vol-body[data-vol="'+volId+'"]');
  head?.querySelector('.arrow')?.classList.toggle('closed',!open);
  body?.classList.toggle('open',open);
  // 模拟数据里有同 id 的卷时同步 open 标志——原型自身的 rerenderChapterList 依赖它
  const vol=BOOKS[currentBook]?.vols.find(v=>v.v===volId);
  if(vol)vol.open=open;
}
function setVolumeOpen(vol,open){
  if(vol)setVolumeOpenById(vol.v,open);
}
function syncCurrentVolume(){
  // 当前章属于哪个卷，只认文件树上那一行的 data-vol：bridge 渲染的是真实工作区，
  // 章节 id 与 BOOKS 模拟数据毫无关系，查模拟数据只会点亮错的卷或一个都不亮。
  const list=document.getElementById('chapter-list');
  const volId=list?.querySelector('.item[data-cid="'+curChapter+'"]')?.dataset.vol;
  list?.querySelectorAll('.vol-head').forEach(head=>head.classList.toggle('current-vol',Boolean(volId)&&head.dataset.vol===volId));
}
function toggleVol(v){
  const book=BOOKS[currentBook];
  const vol=book.vols.find(x=>x.v===v);
  if(!vol)return;
  setVolumeOpen(vol,!vol.open);
  const hasCurrent=vol.chapters.some(ch=>ch.id===curChapter);
  if(vol.open&&hasCurrent){
    const cursor=document.getElementById('ch-cursor');
    if(cursor)cursor.style.opacity='0';
    setTimeout(()=>moveCursor(true),290);
  }else requestAnimationFrame(moveCursor);
}
function renderChapterList(){
  const book=BOOKS[currentBook];
  if(!book)return '';
  const volHtml=book.vols.map(vol=>{
    const done=vol.chapters.filter(c=>c.state==='approved'||c.state==='translated').length;
    const chapHtml=vol.chapters.map(c=>{
      const titleHtml = `<span class="it-title">${c.title}</span>
           <span class="ch-edit" title="改章名" onclick="event.stopPropagation();beginEdit('chap','${c.id}',this)">✎</span>
           <span class="ch-del" title="删除章节" onclick="event.stopPropagation();beginDeleteChapter('${c.id}',this)">删</span>`;
      return `
      <div class="item ${c.state==='translating'?'glow':''}" role="button" tabindex="0" data-key-action data-cid="${c.id}" data-vol="${vol.v}" onclick="if(!editingChapter)openChapter('${c.id}')">
        <span class="drag-grip" title="拖拽排序">⠿</span>
        <span style="color:${STYLES[c.state]};font-size:11px">${c.icon}</span>
        ${titleHtml}

        <span class="st" style="color:${c.id===curChapter&&pendingIdx<PENDING_CARDS.length?'var(--accent2)':STYLES[c.state]}">${c.id===curChapter&&pendingIdx<PENDING_CARDS.length?'术语确认':c.state==='approved'?'已译':c.state==='translated'?'待审':c.state==='translating'?'翻译中':c.state==='ready'?'待译':'未开始'}</span>
      </div>`;
    }).join('');
    const hasCur = vol.chapters.some(c=>c.id===curChapter);
    const volNameHtml = `<span class="vol-title">${vol.name} <span class="vol-current">◈</span></span>
         <span class="vol-edit" title="改卷名" onclick="event.stopPropagation();beginEdit('vol','${vol.v}',this)">✎</span>
         <span class="vol-new" title="新建章节" onclick="event.stopPropagation();beginNewChapter('${vol.v}')">＋</span>
         <span class="vol-del" title="删除卷" onclick="event.stopPropagation();beginDeleteVolume('${vol.v}')">删</span>`;
    return `
      <div class="vol-head ${hasCur?'current-vol':''}" role="button" tabindex="0" data-key-action data-vol="${vol.v}" onclick="if(!editingVol)toggleVol('${vol.v}')">
        <span class="arrow ${vol.open?'':'closed'}">▶</span>
        <span style="font-size:10px;color:var(--dimmer)">${vol.v}</span>
        ${volNameHtml}
        <span style="font-size:10px;color:var(--dimmer)">${done}/${vol.chapters.length} 已译</span>
      </div>
      <div class="vol-body ${vol.open?'open':''}" data-vol="${vol.v}"><div>${chapHtml}</div></div>`;
  }).join('');
  return `<div class="book-meta">${book.title} · ${book.path}</div>`+volHtml;
}
// 统一重渲染文件树：innerHTML 会销毁 ch-cursor，需立即重建光标（snap）
function rerenderChapterList(){
  const list=document.getElementById('chapter-list');
  if(!list)return;
  list.innerHTML=renderChapterList();
  moveCursor();
  // .item 有 volItemIn 入场动画(translateY 4px)，立即测量会偏移；动画结束后再校正一次
  clearTimeout(rerenderChapterList._t);
  rerenderChapterList._t=setTimeout(()=>moveCursor(),320);
}

// ===== v21: 左栏待审/术语/状态 =====
function renderPendingCards(){
  if(pendingIdx >= PENDING_CARDS.length) return '<div style="font-size:11px;color:var(--green);padding:4px 14px 10px">✓ 术语待审已全部处理</div>';
  const c = PENDING_CARDS[pendingIdx];
  return `<div class="pending-card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <b style="font-size:12px;color:var(--text)">${c.ja}</b>${c.reading?`<span style="font-size:10px;color:var(--dim)">${c.reading}</span>`:''}
      <span style="font-size:10px;color:var(--dim)">${pendingIdx+1}/${PENDING_CARDS.length}</span>
    </div>
    <div class="pc-ctx">${c.ctx}</div>
    <div class="pc-cands">
      ${c.cands.map((x,i)=>`<div class="pc-cand" role="button" tabindex="0" data-key-action onclick="decidePending(${i})">
        <div><div class="cand-zh">${x.zh}</div><div class="cand-ev">${x.ev}</div></div>
        <span class="cand-meta">${x.c*100|0}%</span>
      </div>`).join('')}
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
      <span style="font-size:10px;color:var(--dimmer)">点击候选确认 · 或输入自定义译法</span>
      <span class="pc-skip" role="button" tabindex="0" data-key-action onclick="skipPending()">跳过 →</span>
    </div>
    <div style="display:flex;gap:5px;margin-top:6px;align-items:center">
      <input id="pc-custom-input" placeholder="自定义译法…" style="flex:1;background:var(--panel2);border:1px solid var(--border2);border-radius:5px;padding:4px 7px;font-size:11px;color:var(--text);outline:none" onfocus="this.style.borderColor='rgba(125,211,252,.5)'" onblur="this.style.borderColor='var(--border2)'" onkeydown="if(event.key==='Enter')decideCustom()" />
      <span class="chip" role="button" tabindex="0" data-key-action style="font-size:10px" onclick="decideCustom()">确认</span>
    </div>
  </div>`;
}
function togglePending(){
  pendingOpen=!pendingOpen;
  const body=document.getElementById('pz-body');
  if(body){if(!lighteeReal())body.innerHTML=renderPendingCards();body.classList.toggle('open',pendingOpen)}
  const head=document.querySelector('.pz-head span:last-child');
  if(head)head.textContent=pendingOpen?'收起 ▲':'展开 ▼';
  document.querySelector('.pz-head')?.setAttribute('aria-expanded',String(pendingOpen));
}
function decidePending(i){
  const c=PENDING_CARDS[pendingIdx];
  if(!c)return;
  currentTerms().push({ja:c.ja,zh:c.cands[i].zh,st:'✓',type:c.kind?'双关':'候选',vol:'v02'});
  pendingIdx++;
  if(pendingIdx>=PENDING_CARDS.length)chapterPhase='ready';
  refreshSide();
  pushEvent('确认 '+c.ja+' → '+c.cands[i].zh,'ok');
}
function skipPending(){
  if(pendingIdx<PENDING_CARDS.length)pendingIdx++;
  refreshSide();
  pushEvent('跳过 '+PENDING_CARDS[Math.max(0,pendingIdx-1)].ja,'act');
}
function decideCustom(){
  const inp=document.getElementById('pc-custom-input');
  const v=inp?.value.trim();
  if(!v){pushEvent('请输入译法','err');return}
  const c=PENDING_CARDS[pendingIdx];
  currentTerms().push({ja:c.ja,zh:v,st:'✓',type:'作者指定',vol:'v02'});
  pendingIdx++;
  if(pendingIdx>=PENDING_CARDS.length)chapterPhase='ready';
  if(inp)inp.value='';
  refreshSide();
  pushEvent('✓ 已确认 '+c.ja+' → '+v+'（自定义）','ok');
}
function currentTerms(){return BOOKS._terms?.[currentBook]??TERMS}
function escapeTermText(value){return String(value??'').replace(/[&<>\"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]))}
function directoryTerms(){
  const confirmed=currentTerms().map((term,index)=>({id:'term-'+index,sourceIndex:index,ja:term.ja,zh:term.zh,type:term.type||'术语',source:term.vol||'本书',uses:(index*7+4)%22+1,status:'confirmed'}));
  const pending=PENDING_CARDS.slice(pendingIdx).map((card,index)=>({id:'pending-'+(pendingIdx+index),sourceIndex:-1,ja:card.ja,zh:card.cands?.[0]?.zh||'待定',type:card.kind?'候选·双关':'候选',source:'第3章',uses:0,status:'pending'}));
  return confirmed.concat(pending);
}
function filteredDirectoryTerms(){
  let rows=directoryTerms();
  if(termDirectoryFilter!=='all')rows=rows.filter(row=>row.status===termDirectoryFilter);
  const query=termDirectoryQuery.trim().toLowerCase();
  if(query)rows=rows.filter(row=>[row.ja,row.zh,row.type,row.source].some(value=>String(value).toLowerCase().includes(query)));
  rows.sort((a,b)=>termDirectorySort==='ja'?a.ja.localeCompare(b.ja,'ja'):termDirectorySort==='zh'?a.zh.localeCompare(b.zh,'zh'):b.uses-a.uses);
  return rows;
}
function setTermSurface(surface){
  termSurface=surface;termDirectoryPage=1;termDirectoryEditingId='';
  if(current==='main'&&bTab==='terms')renderPanel();
}
function setTermDirectoryQuery(query){
  termDirectoryQuery=query;termDirectoryPage=1;renderPanel();
  requestAnimationFrame(()=>{const input=document.getElementById('term-directory-search');if(input){input.focus();input.setSelectionRange(query.length,query.length)}});
}
function setTermDirectoryFilter(filter){termDirectoryFilter=filter;termDirectoryPage=1;termDirectoryEditingId='';renderPanel()}
function setTermDirectorySort(sort){termDirectorySort=sort;termDirectoryPage=1;renderPanel()}
function changeTermDirectoryPage(page){
  const total=Math.max(1,Math.ceil(filteredDirectoryTerms().length/termDirectoryPageSize));
  termDirectoryPage=Math.max(1,Math.min(total,termDirectoryPage+page));
  renderPanel();
}
function toggleTermDirectorySelect(id,checked){
  if(checked&&!termDirectorySelected.includes(id))termDirectorySelected.push(id);
  if(!checked)termDirectorySelected=termDirectorySelected.filter(item=>item!==id);
  renderPanel();
}
function toggleAllDirectoryRows(checked){
  const rows=filteredDirectoryTerms().slice((termDirectoryPage-1)*termDirectoryPageSize,termDirectoryPage*termDirectoryPageSize);
  termDirectorySelected=checked?rows.map(row=>row.id):termDirectorySelected.filter(id=>!rows.some(row=>row.id===id));
  renderPanel();
}
function beginDirectoryEdit(id){
  const row=directoryTerms().find(item=>item.id===id);
  if(!row||row.sourceIndex<0)return;
  termDirectoryEditingId=id;renderPanel();
  requestAnimationFrame(()=>document.querySelector('[data-term-edit-zh]')?.focus());
}
function cancelDirectoryEdit(){termDirectoryEditingId='';renderPanel()}
function createTermSync(id,oldJa,oldZh,newJa,newZh){
  const seeds=(TERM_SYNC_SEEDS[id]||[]).map(seed=>({...seed,match:seed.match||oldZh,selected:seed.kind==='exact'}));
  termSync={termId:id,oldJa,oldZh,newJa,newZh,scope:'book',occurrences:seeds,selected:seeds.filter(row=>row.kind==='exact').map(row=>row.id),phase:'found',applied:0,skipped:0,previousDrafts:{},previousInvalidated:{},affectedChapters:[]};
}
function termSyncRows(){
  if(!termSync)return [];
  if(termSync.scope==='volume')return termSync.occurrences.filter(row=>row.volume==='v02');
  if(termSync.scope==='chapter')return termSync.occurrences.filter(row=>row.chapterId==='ch003');
  return termSync.occurrences;
}
function termSyncScopeLabel(scope){return scope==='volume'?'当前卷 · v02':scope==='chapter'?'当前章节 · ch003':'全书已译正文'}
function termSyncContext(row){
  const value=escapeTermText(row.context);
  const needle=escapeTermText(row.match||termSync?.oldZh||'');
  return needle?value.split(needle).join('<mark>'+needle+'</mark>'):value;
}
function revealTermSync(){
  requestAnimationFrame(()=>document.querySelector('.term-sync-surface')?.scrollIntoView({behavior:'auto',block:'start'}));
}
function dismissTermSync(){
  if(!termSync)return;
  pushEvent('术语只用于后续翻译 · '+termSync.newZh,'act');
  termSync=null;
  renderPanel();
}
function previewTermSync(){
  if(!termSync)return;
  termSync.phase='preview';
  renderPanel();
  revealTermSync();
}
function setTermSyncScope(scope){
  if(!termSync)return;
  termSync.scope=scope;
  termSync.selected=termSyncRows().filter(row=>row.kind==='exact').map(row=>row.id);
  renderPanel();
  revealTermSync();
}
function toggleTermSyncOccurrence(id,checked){
  if(!termSync)return;
  if(checked&&!termSync.selected.includes(id))termSync.selected.push(id);
  if(!checked)termSync.selected=termSync.selected.filter(item=>item!==id);
  renderPanel();
}
function toggleAllTermSync(checked){
  if(!termSync)return;
  const exact=termSyncRows().filter(row=>row.kind==='exact').map(row=>row.id);
  termSync.selected=checked?[...new Set([...termSync.selected,...exact])]:termSync.selected.filter(id=>!exact.includes(id));
  renderPanel();
}
function termSyncVisibleDraft(row){
  const id=row.paragraphId;
  const hasDraft=Object.prototype.hasOwnProperty.call(TRANSLATION_DRAFTS,id);
  const element=document.querySelector('.ce-translation[data-para="'+id+'"]');
  return {hasDraft,value:element?.textContent??(hasDraft?TRANSLATION_DRAFTS[id]:(row.baseText||'')),element};
}
function applyTermSync(){
  if(!termSync)return;
  const rows=termSyncRows().filter(row=>termSync.selected.includes(row.id));
  if(!rows.length){pushEvent('请至少选择一处精确命中','err');return}
  termSync.applyRows=rows.map(row=>row.id);
  termSync.phase='applying';
  renderPanel();
  revealTermSync();
  setTimeout(()=>{
    let applied=0;
    let skipped=0;
    const previousDrafts={};
    const previousInvalidated={};
    rows.forEach(row=>{
      const visible=row.paragraphId?termSyncVisibleDraft(row):null;
      if(!visible||(!visible.element&&!visible.hasDraft&&!row.baseText)){applied++;return}
      const current=visible.value;
      const match=row.match||termSync.oldZh;
      if(!current.includes(match)){skipped++;return}
      previousDrafts[row.paragraphId]={exists:visible.hasDraft,value:visible.value};
      const next=current.replace(match,termSync.newZh);
      TRANSLATION_DRAFTS[row.paragraphId]=next;
      if(visible.element)visible.element.textContent=next;
      if(row.paragraphId&&!Object.prototype.hasOwnProperty.call(previousInvalidated,row.paragraphId))previousInvalidated[row.paragraphId]=Boolean(REVIEW_INVALIDATED[row.paragraphId]);
      if(row.paragraphId)REVIEW_INVALIDATED[row.paragraphId]=true;
      applied++;
    });
    termSync.previousDrafts=previousDrafts;
    termSync.previousInvalidated=previousInvalidated;
    termSync.applied=applied;
    termSync.skipped=skipped;
    termSync.affectedChapters=[...new Set(rows.map(row=>row.chapterId))];
    termSync.phase='done';
    if(applied)chapterPhase='revising';
    pushEvent('✓ 术语已同步 '+applied+' 处正文'+(skipped?' · '+skipped+' 处需手动处理':''),'ok');
    renderPanel();
    revealTermSync();
  },260);
}
function undoTermSync(){
  if(!termSync)return;
  Object.entries(termSync.previousDrafts||{}).forEach(([id,previous])=>{
    const element=document.querySelector('.ce-translation[data-para="'+id+'"]');
    if(previous.exists)TRANSLATION_DRAFTS[id]=previous.value;
    else delete TRANSLATION_DRAFTS[id];
    if(element)element.textContent=previous.value||'';
  });
  Object.entries(termSync.previousInvalidated||{}).forEach(([id,wasInvalidated])=>{if(wasInvalidated)REVIEW_INVALIDATED[id]=true;else delete REVIEW_INVALIDATED[id]});
  termSync.phase='undone';
  pushEvent('已撤销本次术语同步','act');
  renderPanel();
  revealTermSync();
}
function renderTermSyncSurface(){
  if(!termSync)return '';
  const rows=termSyncRows();
  const exact=rows.filter(row=>row.kind==='exact');
  const variants=rows.filter(row=>row.kind!=='exact');
  const selected=exact.filter(row=>termSync.selected.includes(row.id));
  const scope=termSync.scope;
  if(termSync.phase==='applying')return `<section class="term-sync-surface"><div class="term-sync-head"><div><span class="term-sync-kicker">正文同步</span><h4>正在同步已有译文</h4><p>${escapeTermText(termSync.oldZh)} → <strong>${escapeTermText(termSync.newZh)}</strong></p></div><div class="term-sync-count"><strong>${termSync.selected.length}</strong><span>处待写入</span></div></div><div class="term-sync-progress"><span></span></div><div class="term-sync-summary"><span>只修改译文，原文保持不变</span></div></section>`;
  if(termSync.phase==='done'||termSync.phase==='undone'){
    const undone=termSync.phase==='undone';
    return `<section class="term-sync-surface"><div class="term-sync-result"><div><strong>${undone?'已撤销本次同步':'已完成术语同步'}</strong><span>${undone?'正文已恢复到同步前状态':`已修改 ${termSync.applied} 处 · 涉及 ${termSync.affectedChapters.length} 个章节`}</span><small>${termSync.skipped?`另有 ${termSync.skipped} 处未自动修改，请手动处理`:undone?'可以重新预览全文命中':'后续章节将使用新译法'}</small></div><div class="term-sync-actions">${undone?'':`<button class="term-sync-button" type="button" data-key-action onclick="undoTermSync()">撤销本次同步</button>`}<button class="term-sync-button" type="button" data-key-action onclick="termSync=null;renderPanel()">收起</button></div></div></section>`;
  }
  if(termSync.phase==='found')return `<section class="term-sync-surface"><div class="term-sync-head"><div><span class="term-sync-kicker">正文同步</span><h4>术语已更新</h4><p><del>${escapeTermText(termSync.oldZh)}</del><span> → </span><strong>${escapeTermText(termSync.newZh)}</strong></p></div><div class="term-sync-count"><strong>${exact.length}</strong><span>处精确命中</span></div></div><div class="term-sync-summary"><span>${exact.length?`已译正文 · ${new Set(rows.map(row=>row.chapterId)).size} 个章节${variants.length?` · ${variants.length} 个变体待确认`:''}`:'没有找到旧译法的精确命中'}</span><div class="term-sync-actions">${exact.length?'<button class="term-sync-button primary" type="button" data-key-action onclick="previewTermSync()">预览全文同步</button>':''}<button class="term-sync-button" type="button" data-key-action onclick="dismissTermSync()">只用于后续翻译</button></div></div></section>`;
  return `<section class="term-sync-surface"><div class="term-sync-head"><div><span class="term-sync-kicker">正文同步 · ${termSyncScopeLabel(scope)}</span><h4>确认修改已有译文</h4><p><del>${escapeTermText(termSync.oldZh)}</del><span> → </span><strong>${escapeTermText(termSync.newZh)}</strong></p></div><div class="term-sync-count"><strong>${selected.length}</strong><span>处已选择</span></div></div><div class="term-sync-toolbar"><div class="term-sync-scopes">${[['book','全书已译正文'],['volume','当前卷 v02'],['chapter','当前章节 ch003']].map(([key,label])=>`<button class="term-sync-scope ${scope===key?'active':''}" type="button" data-key-action onclick="setTermSyncScope('${key}')">${label}</button>`).join('')}</div><span>${rows.length} 处命中</span></div><div class="term-sync-match-head"><label><input type="checkbox" ${exact.length&&selected.length===exact.length?'checked':''} onchange="toggleAllTermSync(this.checked)" /> 全选精确命中 ${selected.length} / ${exact.length}</label><span>${variants.length?variants.length+' 个变体需手动确认':'没有额外变体'}</span></div><div class="term-sync-list">${rows.length?rows.map(row=>`<label class="term-sync-hit ${row.kind==='exact'?'':'variant'}"><input type="checkbox" ${row.kind==='exact'?'':'disabled'} ${termSync.selected.includes(row.id)?'checked':''} onchange="toggleTermSyncOccurrence('${row.id}',this.checked)" /><span class="term-sync-hit-main"><span class="term-sync-hit-top"><strong>${escapeTermText(row.volume)} · ${escapeTermText(row.chapter)} · ${escapeTermText(row.paragraphId)}</strong><span>${row.kind==='exact'?'精确命中':'变体待确认'}</span></span><span class="term-sync-hit-context">${termSyncContext(row)}</span><span class="term-sync-hit-replace"><b>${escapeTermText(row.match||termSync.oldZh)}</b><span>→</span><b>${escapeTermText(termSync.newZh)}</b></span></span></label>`).join(''):'<div class="term-directory-empty"><strong>当前范围没有命中</strong><span>可以切换范围，或只保存术语供后续翻译使用。</span></div>'}</div><div class="term-sync-foot"><span>只修改译文，原文保持不变</span><div class="term-sync-actions"><button class="term-sync-button" type="button" data-key-action onclick="termSync.phase='found';renderPanel()">返回</button><button class="term-sync-button primary" type="button" data-key-action ${selected.length?'':'disabled'} onclick="applyTermSync()">同步 ${selected.length} 处</button></div></div></section>`;
}
function saveDirectoryTerm(id){
  const row=directoryTerms().find(item=>item.id===id);
  if(!row||row.sourceIndex<0)return;
  const ja=document.querySelector('[data-term-edit-ja]')?.value.trim();
  const zh=document.querySelector('[data-term-edit-zh]')?.value.trim();
  const type=document.querySelector('[data-term-edit-type]')?.value.trim();
  if(!ja||!zh){pushEvent('日文和译文不能为空','err');return}
  const term=currentTerms()[row.sourceIndex];
  const oldJa=term?.ja??row.ja;
  const oldZh=term?.zh??row.zh;
  if(term){term.ja=ja;term.zh=zh;term.type=type||'术语'}
  termDirectoryEditingId='';
  if(oldJa!==ja||oldZh!==zh)createTermSync(id,oldJa,oldZh,ja,zh);
  refreshSide();renderPanel();
  if(termSync)revealTermSync();
  pushEvent('✓ 已更新术语 '+ja+' → '+zh+(oldZh!==zh?' · 请确认正文同步范围':''),'ok');
}
function deleteDirectoryTerm(id){
  const row=directoryTerms().find(item=>item.id===id);
  if(!row||row.sourceIndex<0)return;
  termDirectorySelected=termDirectorySelected.filter(item=>item!==id);
  deleteTerm(row.sourceIndex);termDirectoryPage=Math.max(1,termDirectoryPage-((filteredDirectoryTerms().length-1)%termDirectoryPageSize===0?1:0));
  renderPanel();
}
function renderTermDirectory(){
  const all=directoryTerms();
  const filtered=filteredDirectoryTerms();
  const totalPages=Math.max(1,Math.ceil(filtered.length/termDirectoryPageSize));
  termDirectoryPage=Math.min(termDirectoryPage,totalPages);
  const start=(termDirectoryPage-1)*termDirectoryPageSize;
  const pageRows=filtered.slice(start,start+termDirectoryPageSize);
  const counts={all:all.length,confirmed:all.filter(row=>row.status==='confirmed').length,pending:all.filter(row=>row.status==='pending').length,deleted:0};
  const selectedOnPage=pageRows.filter(row=>termDirectorySelected.includes(row.id)).length;
  return `<section class="term-directory" aria-labelledby="term-directory-title">
    <div class="term-directory-head"><div><span class="term-section-kicker">本书权威目录</span><h3 id="term-directory-title">术语表 <small>共 ${all.length} 条</small></h3></div><button class="term-directory-add" type="button" data-key-action onclick="pushEvent('新增术语入口（原型）','act')">＋ 新增术语</button></div>
    <div class="term-directory-toolbar"><label class="term-directory-search"><span>⌕</span><input id="term-directory-search" type="search" value="${escapeTermText(termDirectoryQuery)}" placeholder="搜索日文、译文、类型或来源" oninput="setTermDirectoryQuery(this.value)" /></label><div class="term-directory-filters" role="tablist" aria-label="术语筛选">${[['all','全部'],['confirmed','已确认'],['pending','待确认'],['deleted','已删除']].map(([key,label])=>`<button type="button" role="tab" class="${termDirectoryFilter===key?'active':''}" aria-selected="${termDirectoryFilter===key}" data-key-action onclick="setTermDirectoryFilter('${key}')">${label} <b>${counts[key]}</b></button>`).join('')}</div><label class="term-directory-sort"><span>排序</span><select onchange="setTermDirectorySort(this.value)"><option value="recent" ${termDirectorySort==='recent'?'selected':''}>最近使用</option><option value="ja" ${termDirectorySort==='ja'?'selected':''}>日文</option><option value="zh" ${termDirectorySort==='zh'?'selected':''}>译文</option></select></label></div>
    ${renderTermSyncSurface()}
    ${termDirectorySelected.length?`<div class="term-directory-selection"><span>已选 ${termDirectorySelected.length} 条</span><button type="button" data-key-action onclick="pushEvent('批量操作入口（原型）','act')">批量操作</button><button type="button" data-key-action onclick="termDirectorySelected=[];renderPanel()">清除选择</button></div>`:''}
    <div class="term-directory-table" role="table" aria-rowcount="${filtered.length}"><div class="term-table-row term-table-head" role="row"><span><input type="checkbox" aria-label="选择当前页" ${pageRows.length&&selectedOnPage===pageRows.length?'checked':''} onchange="toggleAllDirectoryRows(this.checked)" /></span><span>日文</span><span>译文</span><span>类型</span><span>来源</span><span>使用</span><span>状态</span><span>操作</span></div>${pageRows.length?pageRows.map(row=>{const editing=termDirectoryEditingId===row.id;return editing?`<div class="term-table-row term-table-editing" role="row"><span></span><input data-term-edit-ja value="${escapeTermText(row.ja)}" aria-label="日文" /><input data-term-edit-zh value="${escapeTermText(row.zh)}" aria-label="译文" /><input data-term-edit-type value="${escapeTermText(row.type)}" aria-label="类型" /><span>${row.source}</span><span>${row.uses||'—'}</span><span class="term-status ${row.status}">已确认</span><span class="term-row-actions"><button type="button" data-key-action title="保存" aria-label="保存术语" onclick="saveDirectoryTerm('${row.id}')">✓</button><button type="button" data-key-action title="取消" aria-label="取消编辑" onclick="cancelDirectoryEdit()">×</button></span></div>`:`<div class="term-table-row" role="row"><span><input type="checkbox" aria-label="选择 ${escapeTermText(row.ja)}" ${termDirectorySelected.includes(row.id)?'checked':''} onchange="toggleTermDirectorySelect('${row.id}',this.checked)" /></span><span class="term-ja"><strong>${escapeTermText(row.ja)}</strong></span><span class="term-zh">${escapeTermText(row.zh)}</span><span class="term-type">${escapeTermText(row.type)}</span><span class="term-source">${escapeTermText(row.source)}</span><span class="term-uses">${row.uses||'—'}</span><span class="term-status ${row.status}">${row.status==='pending'?'待确认':'已确认'}</span><span class="term-row-actions"><button type="button" data-key-action title="编辑" aria-label="编辑 ${escapeTermText(row.ja)}" onclick="beginDirectoryEdit('${row.id}')">✎</button><button type="button" data-key-action title="删除" aria-label="删除 ${escapeTermText(row.ja)}" onclick="deleteDirectoryTerm('${row.id}')">×</button></span></div>`}).join(''):`<div class="term-directory-empty"><strong>没有匹配的术语</strong><span>换一个日文、译文或类型关键词试试。</span></div>`}</div>
    <div class="term-directory-foot"><span>${filtered.length?`${start+1}–${Math.min(start+termDirectoryPageSize,filtered.length)} / ${filtered.length}`:'0 条结果'}</span><div><button type="button" data-key-action ${termDirectoryPage<=1?'disabled':''} onclick="changeTermDirectoryPage(-1)">← 上一页</button><span>第 ${termDirectoryPage} / ${totalPages} 页</span><button type="button" data-key-action ${termDirectoryPage>=totalPages?'disabled':''} onclick="changeTermDirectoryPage(1)">下一页 →</button></div></div>
  </section>`;
}
// 事件流（底部系统栏动态事件——v19 设计，定义在早期版本丢失后补齐）
// v77: 事件抽屉；空列表不占空间，入口留在底部状态栏
let evHidden=false;
function syncEventDock(){
  const el=document.getElementById('ev-list');
  const dock=document.getElementById('event-dock');
  const launch=document.getElementById('ev-launch');
  const count=document.getElementById('ev-count');
  const ic=document.getElementById('ev-toggle');
  const n=el?.children.length??0;
  if(count)count.textContent=String(n);
  launch?.classList.toggle('hot',n>0);
  dock?.classList.toggle('closed',n===0||evHidden);
  if(ic)ic.textContent=evHidden?'▤':'─';
  if(ic)ic.title=evHidden?'展开事件流':'收起事件流';
}
function clearEvents(){
  const el=document.getElementById('ev-list');
  if(el)el.innerHTML='';
  evHidden=false;
  syncEventDock();
}
function toggleEvents(){
  const el=document.getElementById('ev-list');
  if(!el||el.children.length===0){syncEventDock();return}
  evHidden=!evHidden;
  syncEventDock();
}
// 事件流委托：行内操作（撤回等）——按 undo-id 定位，支持无时间限制的多次撤回
let undoStack=[],undoSeq=0;
function pushUndo(label,restoreFn){
  const id='undo-'+(++undoSeq);
  undoStack.push({id,label,restoreFn});
  if(undoStack.length>50)undoStack.shift();
  return id;
}
function undoById(id){
  const i=undoStack.findIndex(r=>r.id===id);
  if(i<0)return;
  const rec=undoStack[i];
  undoStack.splice(i,1);
  rec.restoreFn();
  pushEvent('↩ 已撤回 '+rec.label,'ok');
}
if(!renderOnlyRuntime) document.addEventListener('click',(e)=>{
  const act=e.target.closest('[data-action]');
  if(!act)return;
  if(act.dataset.action==='undo')undoById(act.dataset.undoId);
});
function pushEvent(msg,type='act'){
  const ev=document.getElementById('ev-list');
  const t=new Date().toLocaleTimeString();
  if(ev){
    const cls=type==='ok'?'ok':type==='err'?'err':'act';
    ev.innerHTML=`<div class="ev ${cls}">${t} ${msg}</div>`+ev.innerHTML;
    if(ev.children.length>30)ev.lastChild.remove();
    syncEventDock();
  }
}
let PUNS=[]; // 已确认谐音梗（双关档案，对齐内核 puns.json）
function renderPunsBlock(){
  if(PUNS.length===0)return '';
  return '<div style="margin-top:8px;border-top:1px dashed var(--border);padding-top:6px">'+
    '<div style="font-size:9px;color:var(--purple);font-weight:600;margin-bottom:4px">🎭 双关档案</div>'+
    PUNS.map(p=>`<div style="font-size:10px;color:var(--dim);padding:2px 6px"><span style="color:var(--purple)">${p.ja}</span> → 译「${p.zh}」<span style="font-size:8px;color:var(--dimmer)">（译注: ${p.note??''}）</span></div>`).join('')+
    '</div>';
}
function renderTermList(){
  const terms=currentTerms();
  if(!terms.length)return '<div class="term-empty-mini">暂无已确认术语</div>';
  const visible=terms.slice(0,5);
  const rows=visible.map((t,i)=>`<div class="term-item ${t.st==='✓'?'confirmed':'pending'}">
    <span class="term-state-dot" aria-label="${t.st==='✓'?'已确认':'待确认'}"></span>
    <span class="term-copy"><span class="t-ja">${t.ja}</span><span class="t-zh">${t.zh}</span></span>
    <span class="t-meta"><span class="t-type">${t.type||'术语'}</span>${t.vol?`<span class="vol-chip">${t.vol}</span>`:''}</span>
    <span class="t-ops"><button type="button" title="编辑" aria-label="编辑 ${t.ja}" onclick="beginTermEdit(${i})">✎</button><button type="button" title="删除" aria-label="删除 ${t.ja}" onclick="deleteTerm(${i})">×</button></span>
  </div>`).join('');
  return rows+(terms.length>visible.length?`<button class="term-more" type="button" data-key-action onclick="setTermSurface('directory')">查看其余 ${terms.length-visible.length} 条 · 打开目录 →</button>`:'');
}
// v67: 术语编辑——DOM 局部替换（不重渲染，可靠）
function beginTermEdit(i){
  const item=document.querySelectorAll('#terms-body .term-item')[i];
  if(!item)return;
  const t=currentTerms()[i];
  if(!t)return;
  const zhEl=item.querySelector('.t-zh');
  if(!zhEl)return;
  item.classList.add('editing');
  const inp=document.createElement('input');
  inp.className='ed-sim';inp.style.flex='none';inp.value=t.zh;
  inp.onkeydown=(e)=>{if(e.key==='Enter'){e.preventDefault();saveTermEdit(i,inp)}else if(e.key==='Escape'){cancelTermEdit(i,inp)}};
  inp.onblur=()=>saveTermEdit(i,inp);
  zhEl.replaceWith(inp);
  const ops=item.querySelector('.t-ops');
  if(ops){
    ops.style.opacity=1;
    const editBtn=ops.firstElementChild;
    const delBtn=editBtn?editBtn.nextElementSibling:null;
    if(editBtn&&editBtn.textContent==='✎'){
      editBtn.textContent='✓';editBtn.style.color='var(--green)';
      editBtn.onmousedown=(e)=>e.preventDefault(); // 防 input 失焦先触发 blur 保存
      editBtn.onclick=(e)=>{e.stopPropagation();saveTermEdit(i,inp)};
    }
    if(delBtn&&delBtn.textContent==='✕'){
      delBtn.textContent='✕';delBtn.style.color='var(--dimmer)';
      delBtn.onmousedown=(e)=>e.preventDefault();
      delBtn.onclick=(e)=>{e.stopPropagation();cancelTermEdit(i,inp)};
    }
  }
  inp.focus();inp.select();
}
function saveTermEdit(i,inp){
  if(!inp||inp.dataset.done)return;
  inp.dataset.done='1';
  const terms=currentTerms();
  const t=terms[i];
  const val=inp.value.trim();
  if(t&&val)t.zh=val;
  restoreTermItem(i,inp,val||(t?t.zh:''));
  pushEvent('✓ 已更新 '+t.ja+' → '+val,'ok');
}
function cancelTermEdit(i,inp){
  if(!inp||inp.dataset.done)return;
  inp.dataset.done='1';
  const t=currentTerms()[i];
  restoreTermItem(i,inp,t?t.zh:'');
}
function restoreTermItem(i,inp,text){
  // 先取 ops 引用（replaceWith 后 inp.parentElement 为 null——顺序是关键）
  const host=inp.closest('.term-item');
  const ops=host?.querySelector('.t-ops')??null;
  const t=currentTerms()[i];
  const zhEl=document.createElement('span');
  zhEl.className='t-zh';
  zhEl.textContent=(t?t.st+' ':'')+text;
  inp.replaceWith(zhEl);
  if(host)host.classList.remove('editing');
  if(ops){
    const ok=ops.firstElementChild;
    if(ok&&ok.textContent==='✓'){
      ok.textContent='✎';ok.style.color='var(--accent)';
      ok.onclick=(e)=>{e.stopPropagation();beginTermEdit(i)};
    }
  }
}

let lastDeleted=null,undoTimer=null;
function deleteTerm(i){
  const terms=currentTerms();
  const t=terms[i];
  terms.splice(i,1);
  refreshSide();
  const undoId=pushUndo('删除术语《'+t.ja+'》',()=>{currentTerms().splice(Math.min(i,currentTerms().length),0,t);refreshSide()});
  pushEvent('已删除 <b>'+t.ja+'</b> <span class="ev-undo" data-action="undo" data-undo-id="'+undoId+'">↩ 撤回</span>','act');
  showUndo(t.ja,undoId);
}
// 撤回 toast（3 秒，标题栏中间；作为即时快捷入口；活动流内可随时撤回）
function showUndo(name,undoId){
  showToast('已删除 '+name,{undo:()=>undoById(undoId),duration:3000});
}
function undoDelete(){
  const rec=undoStack[undoStack.length-1];
  if(!rec)return;
  undoById(rec.id);
  const t=document.getElementById('titlebar-toast');
  if(t)t.classList.remove('show');
}
/**
 * 「本章检查」（底栏 / Ctrl+R）。真实工作区走 bridge 的确定性扫描；
 * 原型模式没有真章节，直说，不假装跑过。
 *
 * 这个位置从前是「审校」：onclick 只往事件流写一行字，Ctrl+R 也没有任何处理分支。
 * renderStatList（阅读轮/术语提取/翻译/审校/导出 五行写死的假状态）随侧栏状态段一起删除。
 */
function runChapterCheck(){
  const bridge=window.__lighteeWorkspaceBridge;
  if(bridge&&typeof bridge.runChapterCheck==='function'){bridge.runChapterCheck();return}
  pushEvent('本章检查需要先打开工作区','err');
}
function toggleSec(name){
  const sec=document.getElementById(name+'-sec');
  const body=document.getElementById(name+'-body');
  if(!sec||!body)return;
  sec.classList.toggle('collapsed-sec');
  body.classList.toggle('collapsed');
  sec.querySelector('.sec-head')?.setAttribute('aria-expanded',String(!body.classList.contains('collapsed')));
}
function refreshSide(){
  const pz=document.getElementById('pz-body'); if(pz&&!lighteeReal())pz.innerHTML=renderPendingCards();
  const pc=document.getElementById('pz-count'); if(pc&&!lighteeReal())pc.textContent=PENDING_CARDS.length-pendingIdx;
  const tb=document.getElementById('terms-body'); if(tb&&!lighteeReal())tb.innerHTML=renderTermList()+renderPunsBlock();
  const tc=document.getElementById('terms-count'); if(tc&&!lighteeReal())tc.textContent=currentTerms().length;
  const rc=document.getElementById('terms-ready-count'); if(rc)rc.textContent=currentTerms().length;
  const mini=document.getElementById('terms-pending-mini');if(mini&&!lighteeReal()){const remaining=Math.max(0,PENDING_CARDS.length-pendingIdx);mini.textContent=remaining?`待确认 ${remaining}`:'已确认';mini.classList.toggle('empty',remaining===0)}
}
function renderInlineReview(issue,paraId){
  return `<div class="ce-review" contenteditable="false" data-review-id="${issue.id}">
    <button class="ce-review-toggle" type="button" data-key-action aria-expanded="false" aria-controls="${issue.id}-detail" onclick="toggleInlineReview('${issue.id}','${paraId}',event)">
      <span class="ce-review-marker">!</span><span class="ce-review-label">审校</span><strong>${issue.title}</strong><span class="ce-review-summary">${issue.summary}</span><span class="ce-review-chevron">⌄</span>
    </button>
    <div class="ce-review-detail" id="${issue.id}-detail">
      <div class="ce-review-evidence"><span>证据</span><code>${issue.evidence}</code><span>${issue.detail}</span></div>
      <div class="ce-review-actions"><span>${issue.suggestion}</span><span class="ce-review-controls"><button class="ce-review-process" type="button" data-key-action aria-expanded="false" aria-controls="${issue.id}-action" onclick="openReviewAction('${issue.id}','${paraId}',event)">处理</button><span class="ce-review-return" role="button" tabindex="0" data-key-action onclick="openReviewReport(event)">查看报告</span></span></div>
      <div class="ce-review-action-panel" id="${issue.id}-action" aria-hidden="true">
        <div class="ce-review-action-head"><strong>处理审校问题</strong><span>仅修改当前段落</span></div>
        <div class="ce-review-compare"><div><span>当前译文</span><p>${issue.current}</p></div><div><span>建议修改</span><p>${issue.suggested}</p></div></div>
        <div class="ce-review-action-foot"><span>选择一种处理方式，提示会在完成后消失</span><span class="ce-review-action-buttons"><button class="review-action-button" type="button" data-key-action onclick="closeReviewAction('${paraId}',event)">稍后</button><button class="review-action-button manual" type="button" data-key-action onclick="beginReviewManualEdit('${issue.id}','${paraId}',event)">手动修改</button><button class="review-action-button" type="button" data-key-action onclick="applyManualReviewAction('${issue.id}','${paraId}',event)">保留当前译文</button><button class="review-action-button primary" type="button" data-key-action onclick="prepareReviewAcceptance('${issue.id}','${paraId}',event)">接受建议</button></span></div>
      </div>
    </div>
  </div>`;
}
function renderReviewReportItem(paraId,index){
  if(REVIEW_STATUS[paraId]!=='open'||REVIEW_INVALIDATED[paraId])return '';
  const issue=REVIEW_ISSUES[paraId];
  return `<article class="review-item review-${issue.tag==='语义'?'meaning':'warning'}">
    <span class="review-index">${String(index).padStart(2,'0')}</span>
    <div class="review-item-body">
      <div class="review-item-top"><div><strong>${issue.title}</strong><span>${paraId} · 当前段落</span></div><span class="review-tag">${issue.tag}</span></div>
      <p>${issue.detail}</p>
      <div class="review-evidence"><span>证据</span><code>${issue.evidence}</code><span>${issue.current}</span></div>
      <div class="review-item-foot"><span class="review-suggestion">${issue.suggestion}</span><span class="review-item-actions"><span class="review-return" role="button" tabindex="0" data-key-action onclick="focusReviewParagraph('${paraId}')">定位正文</span><span class="review-return primary" role="button" tabindex="0" data-key-action onclick="focusReviewParagraph('${paraId}',true)">处理</span></span></div>
    </div>
  </article>`;
}
function renderReviewHistoryItem(paraId){
  const issue=REVIEW_ISSUES[paraId];
  if(REVIEW_INVALIDATED[paraId])return `<div class="review-history-row"><span>↻</span><strong>${issue.title}</strong><span>${paraId} · 术语同步后待检查</span></div>`;
  if(REVIEW_STATUS[paraId]==='resolved')return `<div class="review-history-row"><span>✓</span><strong>${issue.title}</strong><span>${paraId} · 已处理</span></div>`;
  return '';
}
function decidePendingWorkspace(i){
  decidePending(i);
  if(current==='main'&&bTab==='terms')renderPanel();
  syncWorkflowUI();
}
function deferPending(){
  pushEvent('术语确认暂缓 · 翻译仍保持锁定','act');
}
function decideCustomWorkspace(){
  const inp=document.getElementById('term-custom-input');
  const value=inp?.value.trim();
  if(!value){pushEvent('请输入自定义译法','err');return}
  const card=PENDING_CARDS[pendingIdx];
  if(!card)return;
  currentTerms().push({ja:card.ja,zh:value,st:'✓',type:'作者指定',vol:'v02'});
  pendingIdx++;
  if(inp)inp.value='';
  pushEvent('✓ 已确认 '+card.ja+' → '+value+'（自定义）','ok');
  refreshSide();
  if(current==='main'&&bTab==='terms')renderPanel();
  syncWorkflowUI();
}
function renderTermsWorkspaceLegacy(){
  const remaining=PENDING_CARDS.length-pendingIdx;
  const card=PENDING_CARDS[pendingIdx];
  const ready=remaining===0;
  const terms=currentTerms();
  const phase=ready?'ready':'terms';
  return `<div class="term-workspace">
    <div class="term-workspace-head">
      <div><span class="term-workspace-kicker">翻译前 · 术语确认</span><h2>先确定术语，再开始整章翻译</h2><p>确认结果会写入本书术语权威，翻译 Agent 只能使用已确认的译法。</p></div>
      <div class="term-workspace-count"><strong>${remaining}</strong><span>个待确认</span><small>${ready?'可以开始整章翻译':'翻译前置条件'}</small></div>
    </div>
    <div class="term-workflow-steps" aria-label="章节工作流">
      <span class="active"><b>1</b>术语确认</span><i>→</i><span class="${ready?'active':''}"><b>2</b>整章翻译</span><i>→</i><span><b>3</b>作者修订</span>
    </div>
    <div class="term-workspace-grid">
      <section class="term-queue" aria-labelledby="term-queue-title">
        <div class="term-section-head"><div><span class="term-section-kicker">本章新增候选</span><h3 id="term-queue-title">${ready?'术语已全部确认':'待确认术语'}</h3></div><span class="term-progress">${ready?PENDING_CARDS.length:pendingIdx+1} / ${PENDING_CARDS.length}</span></div>
        ${card?`<article class="term-candidate">
          <div class="term-candidate-head"><div><strong>${card.ja}</strong>${card.reading?`<span>${card.reading}</span>`:''}</div><span>第 3 章 · ${pendingIdx+1}/${PENDING_CARDS.length}</span></div>
          <p class="term-candidate-context">${card.ctx}</p>
          <div class="term-candidate-label">选择权威译法</div>
          <div class="term-candidate-options">${card.cands.map((candidate,i)=>`<button class="term-candidate-option" type="button" data-key-action onclick="decidePendingWorkspace(${i})"><span><strong>${candidate.zh}</strong><small>${candidate.ev}</small></span><b>${candidate.c*100|0}%</b></button>`).join('')}</div>
          <div class="term-candidate-custom"><label for="term-custom-input">没有合适译法</label><div><input id="term-custom-input" type="text" placeholder="输入作者指定译法" /><button class="term-custom-submit" type="button" data-key-action onclick="decideCustomWorkspace()">确认自定义</button></div></div>
          <div class="term-candidate-foot"><span>确认后进入术语表，不会自动改写已有正文</span><button class="term-defer" type="button" data-key-action onclick="deferPending()">稍后处理</button></div>
        </article>`:`<div class="term-empty"><span class="term-empty-mark">✓</span><strong>本章术语已确认</strong><p>现在可以启动整章翻译。批准后，作者仍可进入正文进行精细修改、局部重译或润色。</p></div>`}
      </section>
      <aside class="term-authority" aria-labelledby="term-authority-title">
        <div class="term-section-head"><div><span class="term-section-kicker">本书权威</span><h3 id="term-authority-title">已确认术语</h3></div><span class="term-progress">${terms.length} 项</span></div>
        <div class="term-authority-list">${terms.slice(0,8).map(term=>`<div class="term-authority-row"><span><strong>${term.ja}</strong><small>${term.type||'术语'}</small></span><b>${term.zh}</b></div>`).join('')||'<div class="term-authority-empty">确认后的术语会出现在这里</div>'}</div>
        <button class="term-open-table" type="button" data-key-action onclick="toggleSec('terms')">打开完整术语表 <span>→</span></button>
      </aside>
    </div>
    <div class="term-workspace-foot"><span><b>${ready?'术语确认完成':'当前阶段不可翻译'}</b><small>${ready?'整章翻译会使用以上权威译法':'处理完全部候选后，整章翻译按钮才会解锁'}</small></span><button class="term-start-button ${ready?'':'disabled'}" type="button" data-key-action ${ready?'':'disabled'} onclick="startTranslate()">${ready?'开始整章翻译':'还剩 '+remaining+' 个待确认'}</button></div>
  </div>`;
}
function renderTermQueueSurface(){
  const remaining=PENDING_CARDS.length-pendingIdx;
  const card=PENDING_CARDS[pendingIdx];
  const terms=currentTerms();
  return `<div class="term-workspace-grid">
    <section class="term-queue" aria-labelledby="term-queue-title">
      <div class="term-section-head"><div><span class="term-section-kicker">本章新增候选</span><h3 id="term-queue-title">${card?'待确认术语':'术语已全部确认'}</h3></div><span class="term-progress">${card?pendingIdx+1:PENDING_CARDS.length} / ${PENDING_CARDS.length}</span></div>
      ${card?`<article class="term-candidate">
        <div class="term-candidate-head"><div><strong>${card.ja}</strong>${card.reading?`<span>${card.reading}</span>`:''}</div><span>第 3 章 · ${pendingIdx+1}/${PENDING_CARDS.length}</span></div>
        <p class="term-candidate-context">${card.ctx}</p>
        <div class="term-candidate-label">选择权威译法</div>
        <div class="term-candidate-options">${card.cands.map((candidate,i)=>`<button class="term-candidate-option" type="button" data-key-action onclick="decidePendingWorkspace(${i})"><span><strong>${candidate.zh}</strong><small>${candidate.ev||candidate.note||'候选译法'}</small></span><b>${candidate.c?candidate.c*100|0:'—'}${candidate.c?'%':''}</b></button>`).join('')}</div>
        <div class="term-candidate-custom"><label for="term-custom-input">没有合适译法</label><div><input id="term-custom-input" type="text" placeholder="输入作者指定译法" /><button class="term-custom-submit" type="button" data-key-action onclick="decideCustomWorkspace()">确认自定义</button></div></div>
        <div class="term-candidate-foot"><span>确认后进入术语表，不会自动改写已有正文</span><button class="term-defer" type="button" data-key-action onclick="deferPending()">稍后处理</button></div>
      </article>`:`<div class="term-empty"><span class="term-empty-mark">✓</span><strong>本章术语已确认</strong><p>现在可以启动整章翻译。批准后，作者仍可进入正文进行精细修改、局部重译或润色。</p></div>`}
    </section>
    <aside class="term-authority" aria-labelledby="term-authority-title">
      <div class="term-section-head"><div><span class="term-section-kicker">本书权威</span><h3 id="term-authority-title">已确认术语</h3></div><span class="term-progress">${terms.length} 项</span></div>
      <div class="term-authority-list">${terms.slice(0,8).map(term=>`<div class="term-authority-row"><span><strong>${term.ja}</strong><small>${term.type||'术语'}</small></span><b>${term.zh}</b></div>`).join('')||'<div class="term-authority-empty">确认后的术语会出现在这里</div>'}</div>
      <button class="term-open-table" type="button" data-key-action onclick="setTermSurface('directory')">打开完整术语表 <span>→</span></button>
    </aside>
  </div>`;
}
function renderTermsWorkspace(){
  const remaining=PENDING_CARDS.length-pendingIdx;
  const surface=remaining===0?'directory':termSurface;
  const phase=remaining===0?'ready':'terms';
  return `<div class="term-workspace">
    <div class="term-workspace-head">
      <div><span class="term-workspace-kicker">翻译前 · 术语确认</span><h2>先确定术语，再开始整章翻译</h2><p>确认结果会写入本书术语权威，翻译 Agent 只能使用已确认的译法。</p></div>
      <div class="term-workspace-count"><strong>${remaining}</strong><span>个待确认</span><small>${remaining?'翻译前置条件':'可以开始整章翻译'}</small></div>
    </div>
    <div class="term-workflow-steps" aria-label="章节工作流"><span class="active"><b>1</b>术语确认</span><i>→</i><span class="${remaining===0?'active':''}"><b>2</b>整章翻译</span><i>→</i><span><b>3</b>作者修订</span></div>
    <div class="term-surface-tabs" role="tablist" aria-label="术语视图"><button type="button" role="tab" class="${surface==='queue'?'active':''}" aria-selected="${surface==='queue'}" data-key-action onclick="setTermSurface('queue')">待处理 <b>${remaining}</b></button><button type="button" role="tab" class="${surface==='directory'?'active':''}" aria-selected="${surface==='directory'}" data-key-action onclick="setTermSurface('directory')">术语目录 <b>${currentTerms().length}</b></button></div>
    ${surface==='directory'?renderTermDirectory():renderTermQueueSurface()}
    <div class="term-workspace-foot"><span><b>${remaining?'当前阶段不可翻译':'术语确认完成'}</b><small>${remaining?'处理完全部候选后，整章翻译按钮才会解锁':'整章翻译会使用以上权威译法；批准后可在正文中继续作者修订'}</small></span><button class="term-start-button ${remaining?'disabled':''}" type="button" data-key-action ${remaining?'disabled':''} onclick="startTranslate()">${remaining?'还剩 '+remaining+' 个待确认':'开始整章翻译'}</button></div>
  </div>`;
}
function authorStateLabel(){
  if(chapterPhase==='approved')return '已批准 · 可开始作者修订';
  if(chapterPhase==='revising')return '作者有未完成修改 · 完成本章后可导出';
  if(chapterPhase==='translating')return '整章翻译进行中';
  return '术语确认完成后开放';
}
function renderAuthorTools(){
  const editable=chapterPhase==='approved'||chapterPhase==='revising';
  if(!editable)return `<div class="author-gate"><span class="author-gate-mark">◇</span><span><strong>作者修订将在批准后开放</strong><small>当前先完成术语确认和整章翻译；批准后可直接改稿，或对选区生成重译 / 润色建议。</small></span><button type="button" data-key-action onclick="selectMainTab('terms')">查看流程</button></div>`;
  return `<div class="author-toolbar" id="author-toolbar">
    <div class="author-toolbar-title"><span class="author-toolbar-mark">✦</span><span><strong>作者修订</strong><small id="author-approval-state">${authorStateLabel()}</small></span></div>
    <div class="author-toolbar-actions"><button type="button" data-key-action onclick="handleAuthorCommand('edit')">精细修改</button><button type="button" data-key-action data-author-command="retranslate" onclick="handleAuthorCommand('retranslate')">局部重译</button><button type="button" data-key-action data-author-command="polish" onclick="handleAuthorCommand('polish')">润色</button></div>
    <div class="author-selection-note" id="author-selection-note">直接编辑译文，或先选中文字再使用局部操作</div>
  </div><div class="author-action-panel" id="author-action-panel" aria-live="polite"></div>`;
}
function bPanelHtml(tab){
  // RH-12 / renderer-dom-ownership §2：设计稿数据（TERMS / PENDING_CARDS / REVIEW_ISSUES /
  // JP*·ZH*）在真实应用里是假内容。文件里其他每一处 demo 写入都带 !lighteeReal() 守卫，
  // 唯独这里没有——于是 bridge 还没接管 bpanel 的那一刻（没有 activeWorkspace、
  // 或 hook 尚未注册），术语页会画出设计稿里的人名和待确认卡，作者在自己的书里
  // 看到别人的角色，还能点。空白比假内容好：真值到了自然会覆盖上来。
  if(lighteeReal())return '';
  if(tab==='terms')return renderTermsWorkspace();
    if(tab==='bi'){
    // 三种对照模式（默认逐段）
    if(viewMode==='split'){
      // 左右分屏：原文列 | 译文列（段落按索引对齐，点击联动）。纯框架：无演示段落。
      const paras=DEMO_ROWS;
      return `<div style="display:flex;gap:14px;height:100%">
        <div class="vB-split-left" style="flex:1;border-right:1px solid var(--border2);padding-right:14px;overflow:auto">
          <div style="font-size:10px;color:var(--accent);letter-spacing:2px;margin-bottom:8px">原文 ja · 只读 · 点击联动</div>
          ${paras.map((p,i)=>`<div data-para="${i}" style="cursor:pointer;color:var(--dimmer);font-size:13px;margin-bottom:14px;padding:6px 8px;border-bottom:1px solid rgba(46,58,82,.3);border-radius:4px">${p[0]}</div>`).join('')}
        </div>
        <div class="vB-split-right" style="flex:1;overflow:auto">
          <div style="font-size:10px;color:var(--accent);letter-spacing:2px;margin-bottom:8px">译文 zh · 可编辑 · 点击联动</div>
          ${paras.map((p,i)=>`<div data-para="${i}" class="bl-zh editable" style="cursor:pointer;font-size:14px;margin-bottom:14px;padding:6px 8px;border-bottom:1px solid rgba(46,58,82,.3);border-radius:4px">${p[1]}</div>`).join('')}
        </div>
      </div>`;
    }
    if(viewMode==='stack'){
      // 整块上下：原文全部在上，译文全部在下。纯框架：无演示段落。
      return `<div style="display:flex;flex-direction:column;gap:14px">
        <div>
          <div style="font-size:10px;color:var(--accent);letter-spacing:2px;margin-bottom:6px">原文 ja · 只读</div>
          <div style="color:var(--dimmer);font-size:13px;line-height:1.9">${DEMO_ROWS.map(row=>row[0]).join('<br><br>')}</div>
        </div>
        <div>
          <div style="font-size:10px;color:var(--accent);letter-spacing:2px;margin-bottom:6px">译文 zh · 可编辑</div>
          <div class="bl-zh editable" style="font-size:14px;line-height:1.9">${DEMO_ROWS.map(row=>row[1]).join('<br><br>')}</div>
        </div>
      </div>`;
    }
    // v80: 连续编辑器——正文只维护一个可持续输入的编辑上下文，原文行保持只读。
    // 纯框架：无演示段落，空编辑器即空状态。
    const rows=DEMO_ROWS;
    return `<div class="continuous-editor-shell">
      ${renderAuthorTools()}
      <div class="continuous-editor" contenteditable="false" tabindex="0" spellcheck="false" data-continuous-editor>${rows.map((row,i)=>{const issue=REVIEW_ISSUES[row[2]],reviewVisible=issue&&REVIEW_STATUS[row[2]]==='open'&&!REVIEW_INVALIDATED[row[2]],draft=TRANSLATION_DRAFTS[row[2]],translation=draft===undefined?row[1]:escapeTermText(draft);return `<article class="ce-block ${reviewVisible?'has-review ':''}" data-para="${row[2]}"><div class="ce-source bl-ja" contenteditable="false">${row[0]}</div><div class="ce-translation bl-zh editable" contenteditable="${translationCanEdit()?'true':'false'}" aria-readonly="${translationCanEdit()?'false':'true'}" tabindex="0" spellcheck="false" data-para="${row[2]}">${translation}${i===0&&draft===undefined?'<span class="type-cursor"></span>':''}</div><div class="ce-meta"><span class="ce-id">${row[2]}</span><span class="ce-term">${row[3]}</span></div>${reviewVisible?renderInlineReview(issue,row[2]):''}</article>`}).join('')}</div>
      <div class="continuous-editor-foot"><span class="editor-foot-meta"><strong>—</strong><span>${rows.length} 段</span></span><span id="save-hint" class="save-hint" style="display:none">✓ 已保存</span><span class="editor-foot-shortcut"><kbd>Ctrl</kbd>+<kbd>S</kbd> 保存</span></div>
    </div>`;
  }
  if(tab==='review'){
    const reviewParagraphs=Object.keys(REVIEW_ISSUES);
    const activeReviewParagraphs=reviewParagraphs.filter(paraId=>REVIEW_STATUS[paraId]==='open'&&!REVIEW_INVALIDATED[paraId]);
    const resolvedReviewParagraphs=reviewParagraphs.filter(paraId=>REVIEW_STATUS[paraId]==='resolved'||REVIEW_INVALIDATED[paraId]);
    const reviewTotal=reviewParagraphs.length;
    const doneCount=resolvedReviewParagraphs.length;
    const activeReviewItems=activeReviewParagraphs.map((paraId,index)=>renderReviewReportItem(paraId,index+1)).join('');
    const historyItems=resolvedReviewParagraphs.map(renderReviewHistoryItem).join('');
    const historyMarkup=historyItems?`<section class="review-history"><button class="review-history-toggle" type="button" data-key-action onclick="this.parentNode.classList.toggle('open')"><span><strong>处理记录</strong><small>${doneCount}</small></span><span class="sec-arrow">▼</span></button><div class="review-history-body">${historyItems}</div></section>`:'';
    return `<div class="review-surface">
    <div class="review-head">
      <div><span class="review-kicker">审校报告</span><h2>第 3 章 · 审校</h2></div>
      <div class="review-head-actions"><div class="review-summary"><strong>${activeReviewParagraphs.length}</strong><span>个待处理</span></div><button class="review-run-button" type="button" data-key-action onclick="requestChapterReview(event)">重新审校本章</button></div>
    </div>
    <div class="review-progress"><span>审校进度</span><span>${doneCount} / ${reviewTotal} 项完成</span><div class="review-track"><span style="width:${reviewTotal?Math.round(doneCount/reviewTotal*100):100}%"></span></div></div>
    <div class="review-list">${activeReviewItems||'<div class="review-empty"><strong>本章没有待处理提示</strong><span>当前正文可以继续编辑。</span></div>'}</div>
    ${historyMarkup}
    <div class="review-passed">
      <div class="review-passed-head" role="button" tabindex="0" data-key-action onclick="this.parentNode.classList.toggle('closed')"><span><strong>已通过检查</strong><small>2 项</small></span><span class="sec-arrow">▼</span></div>
      <div class="review-passed-body"><span>术语一致性</span><span>对话格式 · 「」配对完整</span></div>
    </div>
  </div>`;
  }
  return '';
}
function syncWorkflowUI(){
  // 术语/审校/进度这一簇全部由 PENDING_CARDS、chapterPhase 等 demo 常量推导。
  // 真实应用里它们由 workspace-bridge 从 IPC 填充，这里整段让位（见 lighteeReal 注释）。
  const remaining=Math.max(0,PENDING_CARDS.length-pendingIdx);
  const phaseLabel=document.getElementById('chapter-phase-label');
  const phaseText=chapterPhase==='terms'?'术语确认':chapterPhase==='ready'?'等待翻译':chapterPhase==='translating'?'翻译中':chapterPhase==='approved'?'已批准':'作者修订';
  if(phaseLabel&&!lighteeReal())phaseLabel.textContent=phaseText;
  const count=document.getElementById('tab-term-count');if(count&&!lighteeReal())count.textContent=remaining?String(remaining):'✓';
  const footerTranslate=document.getElementById('footer-translate-status');if(footerTranslate&&!lighteeReal())footerTranslate.textContent=chapterPhase==='translating'?'处理中 · 45%':chapterPhase==='approved'||chapterPhase==='revising'?'已完成':'45%';
  const reviewStatus=chapterPhase==='translating'?'等待译文':chapterPhase==='approved'||chapterPhase==='revising'?(reviewPendingCount()?`待处理 ${reviewPendingCount()}`:Object.keys(REVIEW_INVALIDATED).length?'术语变更待检查':'已完成'):'待命';
  const footerReview=document.getElementById('footer-review-status');if(footerReview&&!lighteeReal())footerReview.textContent=reviewStatus;
  const pz=document.getElementById('pending-zone');
  if(pz&&!lighteeReal()){pz.classList.toggle('complete',remaining===0);const head=pz.querySelector('.pz-head');const summary=pz.querySelector('.pz-summary');if(head)head.innerHTML=`<span><b>下一步</b> · ${remaining===0?'术语已确认':'术语确认'} ${remaining?`<span id="pz-count" style="color:var(--yellow)">${remaining}</span>`:''}</span><span class="pz-enter">${remaining===0?'查看术语表 →':'开始处理 →'}</span>`;if(summary)summary.textContent=remaining===0?'整章翻译可以开始':'整章翻译前必须完成本章候选术语确认'}
  const agent=document.getElementById('term-agent-status');if(agent&&!lighteeReal())agent.textContent=remaining===0?'就绪':'待确认';
  const link=document.getElementById('terms-link');if(link&&!lighteeReal()){link.classList.toggle('warn',remaining>0);link.classList.toggle('ok',remaining===0);link.innerHTML=remaining?`待确认 <b id="terms-link-n">${remaining}</b>`:'术语已确认';}
  const mini=document.getElementById('terms-pending-mini');if(mini&&!lighteeReal()){mini.textContent=remaining?`待确认 ${remaining}`:'已确认';mini.classList.toggle('empty',remaining===0)}
  const mainBtn=document.getElementById('main-act-btn');
  // RH-12 / docs/design/renderer-dom-ownership.md §2：#main-act-btn 归 workspace-bridge 独占。
  // 带 owner=bridge 标记时无条件让位——demo 的 chapterPhase 与真实章节状态无关，
  // 写下去就是错的状态（实测：术语已确认、章节 imported 时被覆盖回「先处理术语」）。
  // 再加 !lighteeReal()：owner 标记只有在 bridge **成功写过一次**之后才在。
  // 在那之前（首屏、或那次更新被竞态丢掉时），这段会照着 demo 的 PENDING_CARDS
  // 把「先处理术语」写进真实应用的按钮里——和 bPanelHtml 是同一类泄漏。
  if(mainBtn&&!lighteeReal()&&mainBtn.dataset.owner!=='bridge'&&!translateTimer){
    const author=chapterPhase==='approved'||chapterPhase==='revising';
    const pendingReviews=reviewPendingCount();
    const needsFinish=chapterPhase==='revising';
    const finishBlocked=needsFinish&&pendingReviews>0;
    mainBtn.textContent=finishBlocked?'先处理审校':needsFinish?'完成本章':author?'作者修订':remaining>0?'先处理术语':chapterPhase==='ready'?'开始翻译':'翻译';
    mainBtn.onclick=needsFinish?finishChapter:author?()=>selectMainTab('bi'):remaining>0?()=>selectMainTab('terms'):startTranslate;
    mainBtn.classList.toggle('blocked',remaining>0||finishBlocked);
    mainBtn.setAttribute('aria-label',finishBlocked?'查看待处理审校':needsFinish?'完成本章':author?'进入作者修订':remaining>0?'进入术语确认':'开始整章翻译');
  }
  updateExportGate();
  const approval=document.getElementById('author-approval-state');if(approval)approval.textContent=authorStateLabel();
  updateAuthorSelectionUI();
}
function selectedTranslationScope(){
  const selection=window.getSelection?.();
  if(!selection||selection.isCollapsed||!selection.rangeCount)return null;
  const anchor=selection.anchorNode?.parentElement?.closest?.('.ce-translation');
  const focus=selection.focusNode?.parentElement?.closest?.('.ce-translation');
  if(!anchor||anchor!==focus)return null;
  const text=selection.toString().trim();
  if(!text)return null;
  return {text,translation:anchor,block:anchor.closest('.ce-block'),paragraphId:anchor.dataset.para||anchor.closest('.ce-block')?.dataset.para};
}
function updateAuthorSelectionUI(){
  const scope=selectedTranslationScope();
  const note=document.getElementById('author-selection-note');
  if(note)note.textContent=scope?`已选择 ${scope.text.length} 字 · ${scope.paragraphId} · 可对选区操作`:'直接编辑译文，或先选中文字再使用局部操作';
  document.querySelectorAll('[data-author-command="retranslate"],[data-author-command="polish"]').forEach(button=>{button.disabled=!scope;button.setAttribute('aria-disabled',String(!scope))});
}
function bindAuthorTools(){
  if(!authorSelectionBound){document.addEventListener('selectionchange',updateAuthorSelectionUI);authorSelectionBound=true}
  if(!authorInputBound){document.addEventListener('input',event=>{const translation=event.target?.closest?.('.ce-translation');if(!translation)return;const block=translation.closest('.ce-block');if(translation.dataset.para)TRANSLATION_DRAFTS[translation.dataset.para]=translation.textContent;if(block?.classList.contains('has-review')&&REVIEW_STATUS[block.dataset.para]==='open'){block.classList.add('review-manual-editing');block.dataset.reviewDirty='true';bindManualReviewEdit(block,translation)}if(chapterPhase==='approved')chapterPhase='revising';syncWorkflowUI()},true);authorInputBound=true}
  updateAuthorSelectionUI();
}
function closeAuthorAction(){
  authorAction=null;
  const panel=document.getElementById('author-action-panel');
  if(panel){panel.classList.remove('open');panel.innerHTML=''}
}
function handleAuthorCommand(type){
  const scope=selectedTranslationScope();
  if(type==='edit'){
    const target=scope?.translation||document.querySelector('.ce-block.is-focused .ce-translation')||document.querySelector('.ce-translation');
    if(target){chapterPhase='revising';target.focus();syncWorkflowUI();pushEvent('进入作者精细修改 · '+(target.dataset.para||''),'act')}
    return;
  }
  if(!scope){pushEvent('请先在译文中选择范围','err');return}
  authorAction={type,...scope};
  const title=type==='retranslate'?'局部重译':'润色';
  const description=type==='retranslate'?'按原文和上下文重新生成选区译文建议':'保持术语和语义不变，优化选区的表达与节奏';
  const panel=document.getElementById('author-action-panel');
  if(!panel)return;
  panel.innerHTML=`<div class="author-action-head"><div><strong>${title}</strong><span>${scope.paragraphId} · 已选 ${scope.text.length} 字</span></div><button type="button" data-key-action onclick="closeAuthorAction()">关闭</button></div><div class="author-action-scope"><span>选区</span><p>${scope.text}</p></div><div class="author-action-options"><span>${description}</span><label><input type="checkbox" checked /> 保持已确认术语</label><label><input type="checkbox" checked /> 参考前后文</label></div><div class="author-action-foot"><span>建议生成后需作者确认，不会直接覆盖正文</span><button type="button" class="author-action-generate" data-key-action onclick="showAuthorPreview()">生成建议</button></div>`;
  panel.classList.add('open');
  panel.scrollIntoView({behavior:'auto',block:'nearest'});
  pushEvent(title+' · 已选 '+scope.text.length+' 字，等待作者确认','act');
}
function showAuthorPreview(){
  const panel=document.getElementById('author-action-panel');
  if(!panel||!authorAction)return;
  const title=authorAction.type==='retranslate'?'局部重译':'润色';
  panel.innerHTML=`<div class="author-action-head"><div><strong>${title}建议</strong><span>${authorAction.paragraphId} · 原文选区未改变</span></div><button type="button" data-key-action onclick="closeAuthorAction()">关闭</button></div><div class="author-action-compare"><div><span>当前译文</span><p>${authorAction.text}</p></div><div><span>建议译文</span><p class="author-preview-placeholder">原型预览：建议结果将在此处与当前译文并列比较</p></div></div><div class="author-action-foot"><span>当前为 UI 原型状态，确认写入仍需接入正式建议与保存协议</span><button type="button" class="author-action-generate" data-key-action onclick="pushEvent('原型：保留当前译文，未写入正文','act');closeAuthorAction()">保留当前译文</button></div>`;
}
function bindTabs(){
  document.querySelectorAll('[data-btab]').forEach(t=>{t.onclick=()=>selectMainTab(t.dataset.btab)});
  // 对照模式切换
  document.querySelectorAll('[data-vm]').forEach(v=>{v.onclick=()=>{
    viewMode=v.dataset.vm;
    document.querySelectorAll('[data-vm]').forEach(x=>x.classList.remove('hot'));
    v.classList.add('hot');
    renderPanel();
  }});
  renderPanel();
}
function selectMainTab(tab){
  completePendingManualReviews();
  bTab=tab;
  document.querySelectorAll('[data-btab]').forEach(t=>{
    const active=t.dataset.btab===tab;
    t.classList.toggle('on',active);
    t.setAttribute('aria-selected',String(active));
  });
  renderPanel();
}
function renderPanel(){
  completePendingManualReviews();
  // bridge 接管：真实章节编辑模式下由 bridge 渲染 bpanel（返回 true 表示已处理）
  const hook=window.__lighteeRenderPanelHook;
  if(typeof hook==='function'){try{if(hook())return}catch{/* fallback */}}
  const p=document.getElementById('bpanel');if(p)p.innerHTML=bPanelHtml(bTab);
  // 重新绑定可编辑；术语未完成或翻译运行时保持正文只读。
  const editable=translationCanEdit();
  document.querySelectorAll('.bl-zh.editable').forEach(el=>{el.setAttribute('contenteditable',String(editable));el.setAttribute('aria-readonly',String(!editable))});
  bindParagraphFocus();
  bindReviewHints();
  bindAuthorTools();
  if(viewMode==='split')bindAnchor();
  syncWorkflowUI();
}
function bindParagraphFocus(){
  document.querySelectorAll('.ce-translation').forEach(el=>{
    if(el.dataset.focusBound)return;
    el.dataset.focusBound='1';
    const block=el.closest('.ce-block');
    el.addEventListener('pointerdown',()=>setParagraphFocus(block));
    el.addEventListener('click',()=>setParagraphFocus(block));
    el.addEventListener('focus',()=>setParagraphFocus(block));
  });
}
function bindReviewHints(){
  document.querySelectorAll('.ce-block.has-review').forEach(block=>{
    if(block.dataset.reviewBound)return;
    block.dataset.reviewBound='1';
    block.addEventListener('mouseenter',()=>setReviewNear(block,true));
    block.addEventListener('mouseleave',()=>setTimeout(()=>syncReviewVisibility(block),0));
    block.addEventListener('focusin',()=>setReviewNear(block,true));
    block.addEventListener('focusout',()=>setTimeout(()=>syncReviewVisibility(block),0));
  });
}
function setReviewNear(block,open){
  if(!block)return;
  if(open)block.classList.add('review-near');
  else if(!block.classList.contains('review-pinned'))block.classList.remove('review-near');
  const toggle=block.querySelector('.ce-review-toggle');
  if(toggle)toggle.setAttribute('aria-expanded',String(block.classList.contains('review-near')||block.classList.contains('review-pinned')));
}
function syncReviewVisibility(block){
  if(!block)return;
  const active=block.contains(document.activeElement);
  const hovered=block.matches(':hover');
  if(!active&&!hovered&&!block.classList.contains('review-pinned'))setReviewNear(block,false);
  else setReviewNear(block,true);
}
function clearPinnedReviews(except){
  document.querySelectorAll('.ce-block.review-pinned').forEach(item=>{
    if(item===except)return;
    item.classList.remove('review-pinned');
    syncReviewVisibility(item);
  });
}
function toggleInlineReview(issueId,paraId,event){
  event?.stopPropagation();
  const block=document.querySelector('.ce-block[data-para="'+paraId+'"]');
  if(!block)return;
  const pinned=block.classList.toggle('review-pinned');
  if(pinned)clearPinnedReviews(block);
  setReviewNear(block,pinned||block.matches(':hover')||block.contains(document.activeElement));
  pushEvent((pinned?'展开':'收起')+'审校问题 · '+issueId,'act');
}
function setReviewActionState(block,open){
  if(!block)return;
  block.classList.toggle('review-action-open',open);
  const trigger=block.querySelector('.ce-review-process');
  const panel=block.querySelector('.ce-review-action-panel');
  trigger?.setAttribute('aria-expanded',String(open));
  panel?.setAttribute('aria-hidden',String(!open));
}
function openReviewAction(issueId,paraId,event){
  event?.stopPropagation();
  if(REVIEW_STATUS[paraId]==='resolved')return;
  const block=document.querySelector('.ce-block[data-para="'+paraId+'"]');
  if(!block)return;
  document.querySelectorAll('.ce-block.review-action-open').forEach(item=>{if(item!==block)setReviewActionState(item,false)});
  clearPinnedReviews(block);
  block.classList.add('review-pinned');
  setReviewNear(block,true);
  setReviewActionState(block,true);
  pushEvent('打开处理面板 · '+issueId,'act');
  const reveal=()=>block.querySelector('.ce-review-action-panel')?.scrollIntoView({behavior:'auto',block:'end'});
  requestAnimationFrame(reveal);
  setTimeout(reveal,300);
}
function closeReviewAction(paraId,event){
  event?.stopPropagation();
  const block=document.querySelector('.ce-block[data-para="'+paraId+'"]');
  if(!block)return;
  setReviewActionState(block,false);
  pushEvent('稍后处理审校问题 · '+paraId,'act');
}
function bindManualReviewEdit(block,translation){
  if(!block||!translation||translation.dataset.reviewManualBound==='true')return;
  translation.dataset.reviewManualBound='true';
  translation.addEventListener('input',()=>{block.dataset.reviewDirty='true'});
  translation.addEventListener('blur',()=>setTimeout(()=>completeManualReview(block),0));
}
function resolveReviewBlock(block,eventLabel){
  if(!block)return false;
  const paraId=block.dataset.para;
  REVIEW_STATUS[paraId]='resolved';
  block.classList.remove('review-manual-editing','review-action-open','review-pinned','has-review','review-resolved');
  block.querySelector('.ce-review')?.remove();
  syncWorkflowUI();
  if(eventLabel)pushEvent(eventLabel+' · '+paraId,'ok');
  return true;
}
function completeManualReview(block){
  if(!block||!block.classList.contains('review-manual-editing')||block.dataset.reviewDirty!=='true')return false;
  const paraId=block.dataset.para;
  const translation=block.querySelector('.ce-translation');
  if(translation)TRANSLATION_DRAFTS[paraId]=translation.textContent;
  return resolveReviewBlock(block,'完成手动修改');
}
function completePendingManualReviews(){
  document.querySelectorAll('.ce-block.review-manual-editing').forEach(completeManualReview);
}
function beginReviewManualEdit(issueId,paraId,event){
  event?.stopPropagation();
  const block=document.querySelector('.ce-block[data-para="'+paraId+'"]');
  const translation=block?.querySelector('.ce-translation');
  if(!block||!translation)return;
  chapterPhase='revising';
  block.dataset.reviewDirty='false';
  bindManualReviewEdit(block,translation);
  block.classList.add('review-manual-editing','review-pinned');
  setReviewActionState(block,false);
  const process=block.querySelector('.ce-review-process');
  const label=block.querySelector('.ce-review-label');
  if(process){process.textContent='完成修改';process.classList.add('manual-complete');process.onclick=(nextEvent)=>applyManualReviewAction(issueId,paraId,nextEvent);process.setAttribute('aria-label','完成手动修改')}
  if(label)label.textContent='手动修改中';
  setParagraphFocus(block);
  translation.focus();
  const selection=window.getSelection?.();
  if(selection){selection.removeAllRanges();const range=document.createRange();range.selectNodeContents(translation);range.collapse(false);selection.addRange(range)}
  block.scrollIntoView({behavior:'smooth',block:'center'});
  pushEvent('进入手动修改 · '+issueId,'act');
}
function applyManualReviewAction(issueId,paraId,event){
  event?.stopPropagation();
  const block=document.querySelector('.ce-block[data-para="'+paraId+'"]');
  const translation=block?.querySelector('.ce-translation');
  if(!block)return;
  if(translation)TRANSLATION_DRAFTS[paraId]=translation.textContent;
  resolveReviewBlock(block,'已保留当前译文');
}
function requestChapterReview(event){
  event?.stopPropagation();
  Object.keys(REVIEW_ISSUES).forEach(paraId=>{REVIEW_STATUS[paraId]='open';delete REVIEW_INVALIDATED[paraId]});
  chapterPhase='revising';
  selectMainTab('review');
  pushEvent('作者主动请求重新审校本章','act');
}
function setReviewAcceptanceState(issueId,paraId,confirming){
  const block=document.querySelector('.ce-block[data-para="'+paraId+'"]');
  const panel=block?.querySelector('.ce-review-action-panel');
  const head=panel?.querySelector('.ce-review-action-head strong');
  const note=panel?.querySelector('.ce-review-action-foot>span:first-child');
  const buttons=panel?.querySelector('.ce-review-action-buttons');
  if(!panel||!head||!note||!buttons)return;
  panel.classList.toggle('review-accept-confirm',confirming);
  if(confirming){
    head.textContent='确认替换建议';
    note.textContent='只替换当前问题文本，正文其他部分不变';
    buttons.innerHTML=`<button class="review-action-button" type="button" data-key-action onclick="cancelReviewAcceptance('${issueId}','${paraId}',event)">取消</button><button class="review-action-button primary" type="button" data-key-action onclick="applyReviewAction('${issueId}','${paraId}',event)">确认替换</button>`;
  }else{
    head.textContent='处理审校问题';
    note.textContent='选择一种处理方式，提示会在完成后消失';
    buttons.innerHTML=`<button class="review-action-button" type="button" data-key-action onclick="closeReviewAction('${paraId}',event)">稍后</button><button class="review-action-button manual" type="button" data-key-action onclick="beginReviewManualEdit('${issueId}','${paraId}',event)">手动修改</button><button class="review-action-button" type="button" data-key-action onclick="applyManualReviewAction('${issueId}','${paraId}',event)">保留当前译文</button><button class="review-action-button primary" type="button" data-key-action onclick="prepareReviewAcceptance('${issueId}','${paraId}',event)">接受建议</button>`;
  }
}
function prepareReviewAcceptance(issueId,paraId,event){
  event?.stopPropagation();
  if(REVIEW_STATUS[paraId]==='resolved')return;
  setReviewAcceptanceState(issueId,paraId,true);
  pushEvent('查看建议替换范围 · '+issueId,'act');
  const panel=document.querySelector('.ce-block[data-para="'+paraId+'"] .ce-review-action-panel');
  const reveal=()=>panel?.scrollIntoView({behavior:'auto',block:'end'});
  requestAnimationFrame(reveal);
  setTimeout(reveal,120);
}
function cancelReviewAcceptance(issueId,paraId,event){
  event?.stopPropagation();
  setReviewAcceptanceState(issueId,paraId,false);
  pushEvent('取消建议替换 · '+issueId,'act');
}
function applyReviewAction(issueId,paraId,event){
  event?.stopPropagation();
  const issue=Object.values(REVIEW_ISSUES).find(item=>item.id===issueId);
  const block=document.querySelector('.ce-block[data-para="'+paraId+'"]');
  const translation=block?.querySelector('.ce-translation');
  const panel=block?.querySelector('.ce-review-action-panel');
  if(!issue||!block||!translation||!panel?.classList.contains('review-accept-confirm'))return;
  const currentText=translation.textContent;
  if(!currentText.includes(issue.current)){
    const note=panel.querySelector('.ce-review-action-foot>span:first-child');
    if(note)note.textContent='当前译文已变化，请改用手动修改';
    pushEvent('建议未写入：当前译文已变化 · '+issueId,'err');
    return;
  }
  const nextText=currentText.replace(issue.current,issue.suggested);
  translation.textContent=nextText;
  TRANSLATION_DRAFTS[paraId]=nextText;
  resolveReviewBlock(block,'已接受审校建议');
}
function openReviewReport(event){
  event?.stopPropagation();
  selectMainTab('review');
  pushEvent('打开本章审校报告','act');
}
function focusReviewParagraph(paraId,openAction=false){
  if(openAction&&REVIEW_STATUS[paraId]==='resolved')return;
  selectMainTab('bi');
  requestAnimationFrame(()=>{
    const block=document.querySelector('.ce-block[data-para="'+paraId+'"]');
    if(!block)return;
    clearPinnedReviews(block);
    block.classList.add('review-pinned');
    setParagraphFocus(block);
    block.scrollIntoView({behavior:'smooth',block:'center'});
    block.querySelector('.ce-review-toggle')?.focus({preventScroll:true});
    if(openAction){
      const issue=REVIEW_ISSUES[paraId];
      if(issue)openReviewAction(issue.id,paraId);
    }
    pushEvent((openAction?'打开处理面板 → ':'定位审校问题 → ')+paraId,'act');
  });
}
function setParagraphFocus(block){
  if(!block)return;
  document.querySelectorAll('.ce-block.is-focused').forEach(item=>{if(item!==block)item.classList.remove('is-focused')});
  block.classList.add('is-focused');
  if(block.classList.contains('has-review'))setReviewNear(block,true);
}
function syncActiveParagraph(){
  const block=document.activeElement?.closest?.('.ce-block');
  if(block){setParagraphFocus(block);return}
  document.querySelectorAll('.ce-block.is-focused').forEach(item=>{
    item.classList.remove('is-focused');
    syncReviewVisibility(item);
  });
}
function syncParagraphFocus(event){
  if(event.type==='focusin'||event.type==='focus'){
    syncActiveParagraph();
    setTimeout(syncActiveParagraph,0);
    return;
  }
  const block=event.target?.closest?.('.ce-block');
  if(!block)return;
  setTimeout(()=>{if(!block.contains(document.activeElement)){block.classList.remove('is-focused');completeManualReview(block)}},0);
}
document.addEventListener('focusin',syncParagraphFocus);
document.addEventListener('focusout',syncParagraphFocus);
document.addEventListener('focus',syncParagraphFocus,true);
document.addEventListener('blur',syncParagraphFocus,true);
document.addEventListener('pointerdown',event=>setParagraphFocus(event.target?.closest?.('.ce-block')));
// 原型使用嵌套编辑节点；轮询只负责补齐浏览器未派发的焦点事件，生产 CodeMirror 不需要这层兼容。
setInterval(()=>{if(document.querySelector('.continuous-editor'))syncActiveParagraph()},120);

// ===== 变体 2：启动欢迎屏（CC 极简 + 上次编辑位置）=====
function renderDash(){
  const logo=LOGO.join('\n');
  // 上次编辑位置（工作区 state 真实数据形态）
  const lastEdit={chapter:'',title:'',time:'',ja:'',zh:'',percent:0};
  return `<div class="main" style="background:var(--bg);overflow:auto;height:100%;box-sizing:border-box">
    <div style="min-height:100%;width:100%;display:flex;padding:24px 24px 40px;box-sizing:border-box">
    <div style="margin:auto;width:min(760px,100%)">
      <div class="ascii-logo" style="font-size:15px;color:var(--accent)">${logo}</div>

      <!-- ◈ 上次编辑 -->
      <div class="wc-card" id="wc-last">
        <div class="wc-head"><span>${icon('edit')}上次编辑</span><span style="color:var(--dimmer)">${lastEdit.chapter} ${lastEdit.title} · ${lastEdit.time} · ${lastEdit.percent}% 已译</span></div>
        <div class="wc-body">
          <div style="display:flex;gap:14px;align-items:flex-start">
            <div style="flex:1">
              <div style="font-size:11px;color:var(--dimmer);margin-bottom:4px">原文 ja</div>
              <div style="color:var(--dimmer);font-size:13px">${lastEdit.ja}</div>
            </div>
            <div style="flex:1">
              <div style="font-size:11px;color:var(--accent);margin-bottom:4px">译文 zh · 可编辑</div>
              <div style="color:var(--text);font-size:14px">${lastEdit.zh}<span class="type-cursor"></span></div>
            </div>
          </div>
          <div style="margin-top:10px;display:flex;gap:8px">
            <span class="wc-btn primary" onclick="enterWorkbench()">↩ 从这句继续</span>
            <span class="wc-btn" onclick="enterWorkbench()">进入工作台</span>
          </div>
        </div>
      </div>

      <!-- 🗂 工作区 -->
      <div class="wc-card" id="wc-workspace-card">
        <div class="wc-head"><span>${icon('folder')}工作区</span></div>
        <div class="wc-body">
          <div class="wc-row"><span class="wc-k">当前</span><span class="wc-v">尚未打开工作区</span></div>
          <div class="wc-row"><span class="wc-k">最近</span><span class="wc-v">—</span></div>
          <div data-wc-quick-list hidden style="margin-top:8px;border-top:1px solid var(--border);padding-top:4px"></div>
          <div data-wc-actions style="margin-top:8px;display:flex;gap:8px">
            <span class="wc-btn" onclick="pushEvent('打开工作区选择器','act')">打开</span>
            <span class="wc-btn" onclick="pushEvent('新建工作区','act')">＋ 新建</span>
          </div>
        </div>
      </div>

      <!-- ⚙ 设置（四象限仪表盘：全展开可见） -->
      <div class="wc-card" id="wc-settings-card">
        <div class="wc-head"><span>${icon('sliders')}设置</span></div>
        <div class="wc-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px" id="wc-quad">
            <div class="quad">
              <div class="quad-head"><span>${icon('translate')}翻译偏好</span></div>
              <div class="quad-body">
                <!-- 翻译偏好：由 workspace-bridge 的 renderTranslationPrefs 按真实 config.json 渲染。
                     此前四行里三行是假的——引号策略与并发数只改文本从不落盘；翻译指南更糟，
                     推一条「✓ 翻译指南已保存（translation.guide）」然后把内容丢进内存变量。
                     并发数已整行删除：translation.concurrency 早已移出白名单（桌面端恒为 1）。 -->
                <div id="tp-rows">${lighteeReal()?'':'<div class="wc-kv"><span class="k">引号策略</span><span class="v">zh “” ▸</span></div><div class="wc-kv"><span class="k">翻译指南</span><span class="v" style="cursor:pointer;color:var(--accent)" onclick="editGuide()">✎ 编辑</span></div>'}</div>
                <!-- v44: 翻译指南编辑区 -->
                <div id="guide-area" class="api-area" style="margin-top:6px">
                  <textarea id="guide-text" rows="7" style="width:100%;box-sizing:border-box;background:var(--panel2);border:1px solid var(--border2);border-radius:6px;padding:6px 8px;font-size:11px;color:var(--text);line-height:1.6;outline:none;resize:vertical">${escapeTermText(GUIDE_TEXT)}</textarea>
                  <div style="display:flex;gap:6px;margin-top:5px">
                    <span class="wc-btn primary" style="flex:1;justify-content:center" onclick="saveGuide()">保存</span>
                    <span class="wc-btn" onclick="resetGuide()">恢复默认</span>
                  </div>
                  <div style="font-size:10px;color:var(--dimmer);margin-top:4px">指南注入每次翻译的系统提示（目标读者水平 + 语言风格）</div>
                </div>
                <!-- v44 的审校规则管理区已删除：唯一的消费点是被关掉的全书通读
                     （BOOK_AI_REVIEW_ENABLED=false），规则写下去谁也不读。 -->
              </div>
            </div>
            <div class="quad">
              <div class="quad-head"><span>${icon('appearance')}外观 · 编辑器</span></div>
              <div class="quad-body">
                <div class="wc-kv"><span class="k">字号</span><span class="v" data-editor-setting="fontSize" onclick="wcEditorSetting(this,'fontSize')">— ▸</span></div>
                <div class="wc-kv"><span class="k">原文色</span><span class="v" data-editor-setting="sourceColor" onclick="wcEditorSetting(this,'sourceColor')">— ▸</span></div>
                <div class="wc-kv"><span class="k">段落间距</span><span class="v" data-editor-setting="paragraphGap" onclick="wcEditorSetting(this,'paragraphGap')">— ▸</span></div>
                <div class="wc-kv"><span class="k">术语提示</span><span class="v" data-editor-setting="termHighlight" onclick="wcEditorSetting(this,'termHighlight')">— ▸</span></div>
                <div class="wc-kv"><span class="k">原文联动微亮</span><span class="v" data-editor-setting="sourceLink" onclick="wcEditorSetting(this,'sourceLink')">— ▸</span></div>
                <div class="wc-kv"><span class="k">打字机居中</span><span class="v" data-editor-setting="focusCenter" onclick="wcEditorSetting(this,'focusCenter')">— ▸</span></div>
                <div class="wc-kv"><span class="k">光标动画</span><span class="v" data-editor-setting="cursorAnimate" onclick="wcEditorSetting(this,'cursorAnimate')">— ▸</span></div>
                <div class="wc-kv"><span class="k">光标闪烁</span><span class="v" data-editor-setting="cursorBlink" onclick="wcEditorSetting(this,'cursorBlink')">— ▸</span></div>
                <div class="wc-kv"><span class="k">光标形状</span><span class="v" data-editor-setting="cursorShape" onclick="wcEditorSetting(this,'cursorShape')">— ▸</span></div>
              </div>
            </div>
            <div class="quad" id="wc-ai-quad" style="grid-column:1/-1">
              <div class="quad-head"><span>${icon('chip')}模型 · 服务商</span></div>
              <div class="quad-body">
                <!-- 服务商与模型的唯一编辑面（master-detail）。整块由 workspace-bridge 的
                     renderAiSettings() 用真实 ~/.lightee/models.json 渲染——包括新增、修改、删除。
                     此前这里是「只读展示 + 只能新增」，所有「改」的需求都溢出到手改 JSON。
                     下面的骨架只在**独立打开设计稿**时出现，真实应用里由 bridge 整体替换。 -->
                <!-- 默认是**快捷设置**：服务商/模型/密钥/思考强度/测试连接，四行搞定。
                     完整的服务商与模型管理（API 类型、上下文窗口、思考档位映射、逐档探测）
                     放进下面的详细面板，按需展开——把管理面当默认设置面，对普通使用是负担。 -->
                <div id="ai-quick">${lighteeReal()?'':'<div class="ai-md-empty">设计稿骨架：真实应用中此处为快捷设置</div>'}</div>
                <div class="ai-md" id="ai-advanced" hidden>
                  <div class="ai-md-list" id="ai-provider-list"></div>
                  <div class="ai-md-detail" id="ai-provider-detail"></div>
                </div>
              </div>
            </div>
            </div>
            <div class="quad" style="margin-top:12px">
              <div class="quad-head"><span>${icon('toggle')}行为</span></div>
              <div class="quad-body">
                <!-- 自动保存是既定行为、不是开关：做成可点的切换等于承诺一个不存在的能力。
                     「译注方式」「翻译后自动对照」原本也只是改文本，引擎没有对应设置，整行删除。 -->
                <div class="wc-kv"><span class="k">自动保存</span><span class="v" style="cursor:default;color:var(--dim)" title="编辑期自动保存草稿，不可关闭">始终开启</span></div>
                <div class="wc-kv"><span class="k">原文可编辑</span><span class="v" data-editor-setting="sourceEditable" onclick="wcEditorSetting(this,'sourceEditable')">— ▸</span></div>
              </div>
            </div>
          </div>        </div>
      </div>

    </div>
    </div>
  </div>`;
}
// 启动中心交互（v23: 分类设置）

let cycleDir=1;
function wcCycle(el,opts){
  const cur=el.textContent.replace(' ▸','');
  const i=opts.findIndex(o=>o===cur||o.startsWith(cur));
  const next=(i+cycleDir+opts.length)%opts.length;
  el.textContent=opts[next]+' ▸';
  el.classList.remove('v-anim','r');void el.offsetWidth;
  el.classList.add(cycleDir>0?'v-anim':'v-anim r');
  pushEvent('设置 → '+el.textContent.replace(' ▸',''),'act');
}

// v25: Provider 体系 + 开关（v29: 下拉切换）
const PROVIDERS={
  deepseek:{name:'deepseek',base:'https://api.deepseek.com',models:['deepseek-v4-flash','deepseek-v4-pro']},
  openai:{name:'openai',base:'https://api.openai.com/v1',models:['gpt-5.6-sol','gpt-5.6']},
  anthropic:{name:'anthropic',base:'https://api.anthropic.com/v1',models:['claude-opus-5','claude-sonnet-5']},
  google:{name:'google',base:'https://generativelanguage.googleapis.com/v1beta',models:['gemini-3-pro','gemini-3-flash']},
  qwen:{name:'qwen',base:'https://dashscope.aliyuncs.com/compatible-mode/v1',models:['qwen3.5-397b','qwen3.5-turbo']},
  zhipu:{name:'zhipu',base:'https://open.bigmodel.cn/api/paas/v4',models:['glm-5','glm-5-flash']},
  moonshot:{name:'moonshot',base:'https://api.moonshot.cn/v1',models:['kimi-k3','moonshot-v1-128k']},
  ollama:{name:'ollama',base:'http://localhost:11434/v1',models:['llama3','qwen3']},
  openrouter:{name:'openrouter',base:'https://openrouter.ai/api/v1',models:['openrouter/auto','anthropic/claude-sonnet-5','openai/gpt-5.6']},
  custom:{name:'自定义',base:'',models:[]},
};
let providerSelectCur='deepseek';
// —— 自定义下拉组件（统一风格）——
let csOpen=null;
function renderCs(box,opts,value,onChange,trigHtml){
  const cur=opts.find(o=>o.v===value)||opts[0];
  box.innerHTML=`<span class="cs-trig">${trigHtml||(cur?cur.label:'—')}<span class="arr">▼</span></span>`;
  box.classList.remove('open');
  const trig=box.querySelector('.cs-trig');
  trig.onclick=(e)=>{e.stopPropagation();const wasOpen=box.classList.contains('open');closeAllCs();if(!wasOpen){box.classList.add('open');renderCsPanel(box,opts,value,onChange);}};
}
function renderCsPanel(box,opts,value,onChange){
  let old=box.querySelector('.cs-panel');if(old)old.remove();
  const panel=document.createElement('div');panel.className='cs-panel';
  panel.innerHTML=opts.map(o=>`<div class="cs-item ${o.v===value?'sel':''}" data-v="${o.v}">${o.label}${o.sub?`<span class="sub">${o.sub}</span>`:''}</div>`).join('');
  // fixed 定位：相对触发位置
  const r=box.querySelector('.cs-trig').getBoundingClientRect();
  panel.style.top=(r.bottom+4)+'px';
  panel.style.left=r.left+'px';
  document.body.appendChild(panel);
  panel.querySelectorAll('.cs-item').forEach(it=>{
    it.onclick=(e)=>{e.stopPropagation();const v=it.dataset.v;try{onChange(v)}finally{closeAllCs()}};
  });
}
function closeAllCs(){
  document.querySelectorAll('.cs-panel').forEach(p=>p.remove());
  document.querySelectorAll('.cs.open').forEach(b=>b.classList.remove('open'));
}
if(!renderOnlyRuntime) document.addEventListener('click',()=>closeAllCs());

function providerSelect(el){
  providerSelectCur=el.value;
  const p=PROVIDERS[providerSelectCur];
  const mSel=document.getElementById('model-select');
  if(mSel&&p){mSel.innerHTML=(p.models??[]).map(m=>`<option>${m}</option>`).join('');}
  pushEvent('服务商 → '+p.name+'（'+p.base+'）','act');
}
function openAiLogin(){
  // OpenAI 登录模态（浏览器授权 / API Key 两种方式）
  let ov=document.getElementById('login-modal');
  if(!ov){ov=document.createElement('div');ov.id='login-modal';stage.appendChild(ov)}
  ov.style.cssText='position:absolute;inset:0;z-index:40;background:rgba(5,8,12,.75);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px)';
  ov.classList.remove('modal-out');void ov.offsetWidth;ov.classList.add('modal-back');
  ov.innerHTML=`<div class="modal-pop" style="width:min(420px,90%);background:var(--panel);border:1px solid rgba(125,211,252,.5);border-radius:10px;padding:16px;box-shadow:0 8px 40px rgba(0,0,0,.6)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <b style="font-size:13px;color:var(--accent)">OpenAI 登录</b>
      <span style="cursor:pointer;color:var(--dim);font-size:13px" onclick="closeLoginModal()">✕</span>
    </div>
    <div style="font-size:10px;color:var(--dim);margin-bottom:12px">两种方式任选 · 登录后自动切换为 openai</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <div style="border:1px solid var(--border2);border-radius:8px;padding:10px;cursor:pointer;transition:border-color .15s" onmouseover="this.style.borderColor='rgba(125,211,252,.5)'" onmouseout="this.style.borderColor='var(--border2)'" onclick="pushEvent('已打开浏览器授权页（真实: OAuth 回调 → 写入 auth.json）','act')">
        <div style="font-size:12px;color:var(--text)">🌐 浏览器授权登录</div>
        <div style="font-size:10px;color:var(--dimmer);margin-top:3px">打开浏览器完成 OpenAI 登录，自动回填凭证（ChatGPT 账号）</div>
      </div>
      <div style="border:1px solid var(--border2);border-radius:8px;padding:10px">
        <div style="font-size:12px;color:var(--text)">🔑 粘贴密钥</div>
        <div style="display:flex;gap:6px;margin-top:6px">
          <input id="login-key" placeholder="sk-…" style="flex:1;background:var(--panel2);border:1px solid var(--border2);border-radius:6px;padding:6px 8px;font-size:11px;color:var(--text);outline:none" />
          <span class="wc-btn primary" onclick="saveLoginKey()">保存</span>
        </div>
      </div>
    </div>
  </div>`;
}
function closeLoginModal(){
  const ov=document.getElementById('login-modal');
  if(!ov)return;
  const box=ov.querySelector('.modal-pop');
  if(box)box.classList.add('modal-out');
  setTimeout(()=>{ov.style.display='none'},160);
}
function saveLoginKey(){
  const k=document.getElementById('login-key')?.value.trim();
  if(!k){pushEvent('密钥不能为空','err');return}
  pushEvent('✓ OpenAI 密钥已保存（服务商已切换 openai）','ok');
  closeLoginModal();
}
function closeProviderModal(){
  const ov=document.getElementById('provider-modal');
  if(!ov)return;
  const box=ov.querySelector('.modal-pop');
  if(box)box.classList.add('modal-out');
  setTimeout(()=>{ov.style.display='none'},160); // 缩回完成后隐藏
}
function saveProvider(){
  const name=document.getElementById('pf-name')?.value.trim();
  const base=document.getElementById('pf-base')?.value.trim();
  const key=document.getElementById('pf-key')?.value.trim();
  const model=document.getElementById('pf-model')?.value.trim();
  if(!name||!base){pushEvent('名称与 Base URL 必填','err');return}
  PROVIDERS[name]=PROVIDERS[name]||{name,base,models:model?[model]:[]};
  if(model&&!PROVIDERS[name].models.includes(model))PROVIDERS[name].models.push(model);
  // 真实实现: IPC → main 写 models.json（llm-runtime 直接读取生效）
  pushEvent('✓ Provider 已保存: '+name+'（写入 models.json，重启生效）','ok');
  closeProviderModal();
}

function wcTheme(el,opts){
  wcCycle(el,opts);
  const t=el.textContent.replace(' ▸','');
  const themes={cyber:null,sakura:{accent:'#f9a8d4',accent2:'#c4b5fd',border:'#4c3a52',panel:'#1a1018',panel2:'#150d13',bg:'#0d070b'},forest:{accent:'#86efac',accent2:'#a7f3d0',border:'#2f4a3a',panel:'#0e1a14',panel2:'#0b1510',bg:'#060d09'}};
  const th=themes[t];
  if(th)for(const k in th)document.documentElement.style.setProperty('--'+k,th[k]);
  else for(const k of ['accent','accent2','border','panel','panel2','bg'])document.documentElement.style.removeProperty('--'+k);
}
// ===== 编辑器外观设置（真实 settings IPC，bridge 提供 window.__lighteeEditorSettings） =====
const EDITOR_SETTING_OPTIONS={
  fontSize:{opts:['小','中','大'],value:{小:16,中:18,大:20},label:{16:'小',18:'中',20:'大'},default:18},
  sourceColor:{opts:['暗','灰','亮灰'],value:{暗:'faint',灰:'dim',亮灰:'soft'},label:{faint:'暗',dim:'灰',soft:'亮灰'},default:'faint'},
  paragraphGap:{opts:['紧凑','自然','宽松'],value:{紧凑:'tight',自然:'natural',宽松:'loose'},label:{tight:'紧凑',natural:'自然',loose:'宽松'},default:'natural'},
  termHighlight:{opts:['高亮','下划线','无'],value:{高亮:'highlight',下划线:'underline',无:'none'},label:{highlight:'高亮',underline:'下划线',none:'无'},default:'highlight'},
  sourceLink:{opts:['开','关'],value:{开:true,关:false},label:{true:'开',false:'关'},default:true},
  focusCenter:{opts:['开','关'],value:{开:true,关:false},label:{true:'开',false:'关'},default:true},
  cursorAnimate:{opts:['开','关'],value:{开:true,关:false},label:{true:'开',false:'关'},default:true},
  cursorBlink:{opts:['开','关'],value:{开:true,关:false},label:{true:'开',false:'关'},default:true},
  cursorShape:{opts:['方块','竖条','下划线'],value:{方块:'block',竖条:'beam',下划线:'underline'},label:{block:'方块',beam:'竖条',underline:'下划线'},default:'block'},
  sourceEditable:{opts:['开','关'],value:{开:true,关:false},label:{true:'开',false:'关'},default:false},
};
function toggleQuad(head){
  head.parentNode.classList.toggle('collapsed');
}
function wcEditorSetting(el,key){
  const spec=EDITOR_SETTING_OPTIONS[key];
  if(!spec)return;
  const cur=el.textContent.replace(' ▸','');
  const i=spec.opts.indexOf(cur);
  const next=spec.opts[(i+1+spec.opts.length)%spec.opts.length];
  const patch={[key]:spec.value[next]};
  const api=window.__lighteeEditorSettings;
  if(typeof api==='function'){
    api(patch).then(ok=>{
      if(ok){el.textContent=next+' ▸';pushEvent(key+' → '+next,'act')}
    });
  }else{
    el.textContent=next+' ▸';
  }
}

// v44: 翻译指南编辑（对齐内核 DEFAULT_GUIDE）
let GUIDE_TEXT = `【翻译指南】
目标读者: 中文轻小说读者——熟悉日式题材，但要求中文表达自然流畅，不保留日文语序的生硬感。
语言风格:
- 口语自然、角色语气鲜明（每个角色说话方式可辨识）、内心独白流畅
- 对话符合中文口语习惯，长度适中不啰嗦
- 拟声词/感叹词中文化（如「えっ」→「诶？」），不硬译
- 保持轻小说节奏感：场景切换干净、段落衔接自然`;
const GUIDE_DEFAULT = GUIDE_TEXT;
// 翻译指南：真实模式下读写全部委托给 bridge（window.__lighteeTranslationGuide）。
// 此前这三个函数只操作内存变量 GUIDE_TEXT，saveGuide 还推一条「✓ 已保存（translation.guide）」——
// 而 translation.guide 注入每次翻译的系统提示。宣称保存却丢弃，比没有这个控件更坏。
function guideBridge(){return window.__lighteeTranslationGuide||null}
function editGuide(){
  const a=document.getElementById('guide-area');
  if(!a)return;
  a.classList.toggle('open');
  if(!a.classList.contains('open'))return;
  const t=document.getElementById('guide-text');
  if(!t)return;
  const api=guideBridge();
  if(!api){t.value=GUIDE_TEXT;return}
  t.value='读取中…';
  api.load().then((text)=>{t.value=text||GUIDE_DEFAULT});
}
function saveGuide(){
  const t=document.getElementById('guide-text');
  if(!t)return;
  const api=guideBridge();
  if(api){api.save(t.value);return}
  GUIDE_TEXT=t.value;
  pushEvent('（设计稿）翻译指南仅存于内存','act');
}
function resetGuide(){
  const t=document.getElementById('guide-text');
  if(t)t.value=GUIDE_DEFAULT;
  const api=guideBridge();
  if(api){api.reset();return}
  GUIDE_TEXT=GUIDE_DEFAULT;
  pushEvent('（设计稿）已恢复默认','act');
}

// 审校规则（v44）整段删除：它的唯一消费点是全书 AI 通读，而通读已被关掉
// （BOOK_AI_REVIEW_ENABLED=false）。留着的话界面上是个能写能存、但永远不生效的开关。

// v26: 导入预览确认（真实: 解析分章 → 用户确认落盘）
function importPreview(initialTab='file'){
  // 导入界面：文本粘贴走真实 IPC；文件入口保留独立流程。
  importTab=initialTab==='paste'?'paste':'file';
  importDraftText='';
  importSourcePath='';
  let ov=document.getElementById('import-modal');
  if(!ov){ov=document.createElement('div');ov.id='import-modal';stage.appendChild(ov)}
  ov.style.cssText='position:absolute;inset:0;z-index:40;background:rgba(5,8,12,.75);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px)';
  ov.classList.remove('modal-out');void ov.offsetWidth;ov.classList.add('modal-back');
  ov.innerHTML=`<div class="modal-pop" style="width:min(640px,92%);max-height:82%;background:var(--panel);border:1px solid rgba(125,211,252,.5);border-radius:10px;padding:16px;box-shadow:0 8px 40px rgba(0,0,0,.6);display:flex;flex-direction:column">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <b style="font-size:13px;color:var(--accent)">📥 导入</b>
      <span style="cursor:pointer;color:var(--dim);font-size:13px" onclick="closeImportModal()">✕</span>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:10px">
      ${['file','paste'].map((k,i)=>`<span class="chip icon-chip ${importTab===k?'hot':''}" data-imp="${k}" style="${importTab===k?'':'opacity:.6'}" onclick="switchImportTab('${k}')">${icon(['file','clipboard'][i])}${['打开文件','粘贴文本'][i]}</span>`).join('')}
    </div>
    <div id="import-tab-body" style="flex:1;overflow:auto"></div>
    <div data-import-scope-hint hidden style="margin-top:8px;padding:8px 10px;border:1px solid rgba(250,204,21,.35);border-radius:8px;background:rgba(250,204,21,.08);color:var(--dim);font-size:11px;line-height:1.6"></div>
    <div data-import-status role="status" aria-live="polite" style="min-height:16px;margin-top:8px;color:var(--dim);font-size:11px"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
      <div style="display:flex;gap:8px;align-items:center;font-size:12px;flex-wrap:wrap">
        <span style="color:var(--dim)">导入到</span>
        <select id="import-vol" style="background:var(--panel2);border:1px solid var(--border2);border-radius:6px;padding:4px 8px;font-size:12px;color:var(--text);outline:none"><option value="">自动选择卷</option></select>
        <select id="import-position" style="background:var(--panel2);border:1px solid var(--border2);border-radius:6px;padding:4px 8px;font-size:12px;color:var(--text);outline:none"><option value="new">新建章节</option><option value="end">卷末追加</option><option value="after">指定章节后</option></select>
        <select id="import-after" hidden style="background:var(--panel2);border:1px solid var(--border2);border-radius:6px;padding:4px 8px;font-size:12px;color:var(--text);outline:none"></select>
        <span style="font-size:10px;color:var(--dimmer)">按标题自动分章 · 落到所选卷/位置</span>
      </div>
      <div style="display:flex;gap:8px">
        <span class="wc-btn" onclick="closeImportModal()">取消</span>
        <span class="wc-btn primary" data-import-confirm onclick="confirmImport()">确认导入</span>
      </div>
    </div>
  </div>`;
  renderImportTab();
  renderImportTargets();
  bindImportPosition();
}

function renderImportTargets(){
  const vol=document.getElementById('import-vol');
  const after=document.getElementById('import-after');
  if(!vol)return;
  const bridge=window.__lighteeWorkspaceBridge;
  const volumes=(bridge?.getVolumes?.() ?? []);
  // 工作区已有正文时提醒边界：同一部小说续卷是正当用法，混入另一部才是事故。
  // 术语提取、全书通读、冻结前缀、全书审校都按"一个工作区 = 一部作品"设计。
  // 只提示不拦截——追加导入本身是合法功能，判断这是不是同一部书只有作者知道。
  const scopeHint=document.querySelector('#import-modal [data-import-scope-hint]');
  if(scopeHint){
    const chapterCount=volumes.reduce((sum,v)=>sum+(v.chapters?.length ?? 0),0);
    scopeHint.hidden=chapterCount===0;
    if(chapterCount>0){
      scopeHint.innerHTML='<b style="color:var(--text)">这个工作区已有 '+chapterCount+' 章。</b>同一部小说的后续卷可以继续导入；<b style="color:var(--text)">不同的小说请新建工作区</b>——术语表、全书通读与缓存前缀都按一部作品建立，混在一起会互相污染。';
    }
  }
  vol.innerHTML='<option value="">自动选择卷</option>'+volumes.map(v=>`<option value="${v.id}">${v.name} (${v.id})</option>`).join('')+'<option value="__new">＋ 新卷</option>';
  if(after){
    const all=volumes.flatMap(v=>v.chapters.map(c=>({chapterId:c.id,title:c.title})));
    after.innerHTML=all.map(c=>`<option value="${c.chapterId}">${c.title}</option>`).join('');
  }
}

function bindImportPosition(){
  const pos=document.getElementById('import-position');
  const after=document.getElementById('import-after');
  if(!pos||!after)return;
  pos.onchange=()=>{ after.hidden=pos.value!=='after'; };
}
function closeImportModal(){
  const ov=document.getElementById('import-modal');
  if(!ov)return;
  const box=ov.querySelector('.modal-pop');
  if(box)box.classList.add('modal-out');
  setTimeout(()=>{ov.style.display='none'},160);
}
let importTab='file';
let importDraftText='';
let importSourcePath='';
function switchImportTab(next){
  importTab=next==='paste'?'paste':'file';
  if(importTab==='paste')importSourcePath='';
  else importDraftText='';
  renderImportTab();
}
function renderImportTab(){
  const body=document.getElementById('import-tab-body');
  if(!body)return;
  document.querySelectorAll('[data-imp]').forEach(x=>x.classList.toggle('hot',x.dataset.imp===importTab));
  if(importTab==='file'){
    body.innerHTML=`<div id="import-dropzone" style="border:2px dashed var(--border2);border-radius:10px;padding:26px;text-align:center;cursor:pointer;transition:border-color .2s" onmouseover="this.style.borderColor='rgba(125,211,252,.5)'" onmouseout="this.style.borderColor='var(--border2)'" onclick="importPickFile()" ondragover="event.preventDefault();event.dataTransfer.dropEffect='copy';this.style.borderColor='var(--accent)'" ondragleave="this.style.borderColor='var(--border2)'" ondrop="event.preventDefault();handleImportDrop(event)">
      <div style="font-size:22px;color:var(--dim)">📄</div>
      <div style="font-size:13px;margin-top:6px">点击选择或拖拽文件到这里</div>
      <div style="font-size:10px;color:var(--dimmer);margin-top:4px">支持 .epub（含插图/注音）· .txt/.md（自动分章）</div>
    </div>
    <div id="import-preview" style="margin-top:10px"></div>`;
  } else if(importTab==='paste'){
    body.innerHTML=`<textarea id="paste-area" placeholder="粘贴小说文本…（「第1章」等标题自动识别分章）" style="width:100%;box-sizing:border-box;height:180px;background:var(--panel2);border:1px solid var(--border2);border-radius:8px;padding:10px;font-size:12px;color:var(--text);resize:vertical"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px"><span class="wc-btn primary" onclick="importFromPaste()">解析预览</span><span class="wc-btn" onclick="document.getElementById('paste-area').value=''">清空</span></div>
      <div id="import-preview" style="margin-top:10px"></div>`;
  }
}
function getImportPreview(){
  return document.querySelector('#import-modal #import-preview');
}
function setImportStatus(message, tone='dim'){
  const status=document.querySelector('#import-modal [data-import-status]');
  if(!status)return;
  status.textContent=message;
  status.style.color=tone==='error'?'var(--red)':tone==='ok'?'var(--green)':'var(--dim)';
}
function renderImportFilePreview(preview){
  const pv=getImportPreview();
  if(!pv)return;
  const chapters=Array.isArray(preview?.chapters)?preview.chapters:[];
  const volumes=Array.isArray(preview?.volumes)?preview.volumes:[];
  const source=String(preview?.sourcePath||'').split(/[\\\\/]/).pop()||'导入文件';
  const format=String(preview?.format||'unknown').toUpperCase();
  const chapterRow=(chapter,index)=>`<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-top:${index?'1px solid var(--border)':'0'}"><span>${escapeTermText(chapter.title||'本文')}${chapter.needsManualConfirm?' <span style="color:var(--yellow);font-size:10px">⚠ 需要确认</span>':''}</span><span style="color:var(--dim);white-space:nowrap">${Number(chapter.charCount||0).toLocaleString()} 字</span></div>`;
  // EV-01 合本分卷：按原书分节分组展示——卷头行 + 卷内章节，让「会分成几卷、每卷进什么」在确认前就看得见。
  // 匹配用 volumeIndex（对齐 volumes 下标）而非标题——连载书的「幕間」会出现多次，按标题过滤会把几段幕間混在一起
  let body;
  if(volumes.length>=2){
    body=volumes.map((volume,volumePosition)=>{
      const own=chapters.filter(chapter=>chapter.volumeIndex===volumePosition);
      return `<div style="margin-top:8px;padding:2px 0 2px 8px;border-left:2px solid var(--accent);color:var(--accent);font-size:11px;display:flex;justify-content:space-between;gap:12px"><span>📚 ${escapeTermText(volume.title)}</span><span style="color:var(--dim)">${own.length} 章</span></div>`
        + own.map((chapter,index)=>`<div style="padding-left:10px">${chapterRow(chapter,index)}</div>`).join('');
    }).join('');
  }else{
    body=chapters.length?chapters.map(chapterRow).join(''):'<div style="color:var(--dim)">未解析出章节，请使用分步导入。</div>';
  }
  pv.innerHTML=`<div style="border:1px solid rgba(125,211,252,.4);border-radius:8px;padding:10px;background:rgba(125,211,252,.05);font-size:12px">
    <div style="color:var(--accent);font-size:11px;margin-bottom:6px">已选择 ${escapeTermText(source)} · ${format}${volumes.length>=2?` · 识别到 ${volumes.length} 卷`:''} · 自动分章预览</div>
    ${body}
    ${volumes.length>=2?'<div style="font-size:10px;color:var(--dim);margin-top:8px">目标卷保持「自动选择卷」即按原书分卷导入；指定某一卷则整本并入该卷。</div>':''}
    ${chapters.some(chapter=>chapter.needsManualConfirm)?'<div style="font-size:10px;color:var(--yellow);margin-top:6px">⚠ 存在需要人工确认的章节标题</div>':''}
  </div>`;
}
async function handleImportDrop(event){
  const file=event.dataTransfer?.files?.[0];
  if(!file){setImportStatus('未读取到文件','error');return}
  importSourcePath='';
  const pending=typeof window.lightee?.getPendingDrop==='function'?window.lightee.getPendingDrop():null;
  const path=pending?.path||file.path||file.name;
  setImportStatus('已接收 '+(pending?.name||path)+' · 正在解析预览…','ok');
  pushEvent('📥 已接收文件 · 正在解析预览…','act');
  if(window.lightee){
    try{
      const preview=await window.lightee.invoke('import.preview',{sourcePath:path});
      if(preview?.ok){importSourcePath=path;renderImportFilePreview(preview.value);setImportStatus('预览完成，可以确认导入','ok')}
      else setImportStatus(preview?.error?.message||'文件预览失败','error');
    }catch(cause){setImportStatus(cause instanceof Error?cause.message:String(cause),'error')}
  }else{
    importSourcePath=path;
    renderImportFilePreview({sourcePath:path,format:'txt',chapters:[{title:'第1話 出会い',charCount:1234}]});
    setImportStatus('预览完成（原型模拟）','ok');
  }
}
async function importPickFile(){
  if(window.lightee){
    const picked=await window.lightee.invoke('dialog.pickFile',{title:'选择要导入的小说文件'});
    if(!picked?.ok){setImportStatus(picked?.error?.message||'选择文件失败','error');pushEvent('选择导入文件失败','err');return}
    const sourcePath=picked.value?.path;
    if(!sourcePath){setImportStatus('已取消选择文件');return}
    importSourcePath=sourcePath;
    const preview=await window.lightee.invoke('import.preview',{sourcePath});
    if(!preview?.ok){importSourcePath='';setImportStatus(preview?.error?.message||'文件预览失败','error');pushEvent('导入预览失败','err');return}
    renderImportFilePreview(preview.value);
    setImportStatus('预览完成，可以确认导入','ok');
    pushEvent('已读取 '+sourcePath.split(/[\\\\/]/).pop()+' · 可以确认导入','act');
    return;
  }
  // 原型模拟文件选择；生产路径由 Electron 文件选择器提供内容。
  importDraftText='__prototype_file__SSR26.txt';
  renderImportFilePreview({sourcePath:'SSR26.txt',format:'txt',chapters:[
    {title:'第1話 出会い',charCount:1234},
    {title:'第2話 約束',charCount:987},
    {title:'第3話 傘',charCount:5432,needsManualConfirm:true},
  ]});
  setImportStatus('已选择文件，可以确认导入','ok');
  pushEvent('已选择 SSR26.txt · 可以确认导入','act');
}
function importFromPaste(){
  const t=document.getElementById('paste-area')?.value||'';
  if(!t.trim()){
    setImportStatus('请先粘贴文本','error');
    pushEvent('粘贴内容为空','err');
    return;
  }
  importDraftText=t;
  importSourcePath='';
  const chapterRe=/^(第[一二三四五六七八九十百千万0-9０-９]+[章話话]|プロローグ|エピローグ|幕間|間章|序章|終章|终章|番外編|短編)/;
  const chapters=[];
  let current={title:'本文',charCount:0,manual:true};
  const flush=()=>{
    if(current.title!=='本文'||current.charCount>0)chapters.push(current);
  };
  for(const line of t.replace(/\r/g,'').split('\n')){
    const title=line.trim();
    if(title&&chapterRe.test(title)){
      flush();
      current={title,charCount:0,manual:false};
    }else{
      current.charCount+=line.length;
    }
  }
  flush();
  const pv=getImportPreview();
  if(pv)pv.innerHTML=`<div style="border:1px solid rgba(125,211,252,.4);border-radius:8px;padding:10px;background:rgba(125,211,252,.05);font-size:12px">
    <div style="color:var(--accent);font-size:11px;margin-bottom:6px">文本导入预览 · ${chapters.length} 章 · ${t.length.toLocaleString()} 字符</div>
    ${chapters.map((chapter,index)=>`<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-top:${index?'1px solid var(--border)':'0'}"><span>${chapter.title}${chapter.manual?' <span style="color:var(--yellow);font-size:10px">⚠ 未识别标题</span>':''}</span><span style="color:var(--dim);white-space:nowrap">${chapter.charCount.toLocaleString()} 字</span></div>`).join('')}
    <div style="font-size:10px;color:var(--dim);margin-top:6px">确认后写入当前工作区。</div>
  </div>`;
  setImportStatus('已解析，可以确认导入','ok');
  pushEvent('✓ 已解析 '+t.length+' 字符 — 可以确认导入','ok');
}
async function confirmImport(){
  const button=document.querySelector('#import-modal [data-import-confirm]');
  // 粘贴模式：若未点「解析预览」也自动读取当前粘贴内容
  if(!importSourcePath&&importTab==='paste'&&!importDraftText.trim()){
    const area=document.getElementById('paste-area');
    if(area?.value.trim())importDraftText=area.value;
  }
  if(!importSourcePath&&!importDraftText.trim()){
    setImportStatus('请先选择文件，或粘贴文本并点击解析预览','error');
    pushEvent('请先选择导入内容','err');
    return;
  }
  const handle=window.__lighteeWorkspaceBridge;
  const workspaceCurrent=handle?.getCurrentWorkspace?.();
  if(!window.lightee){
    importDraftText='';
    pendingIdx=0;
    chapterPhase='terms';
    termSurface='queue';
    termSync=null;
    bTab='terms';
    closeImportModal();
    current='main';
    show();
    pushEvent('✓ 原型导入完成 · 已进入术语确认','ok');
    return;
  }
  const wsId=workspaceCurrent?.id||workspaceCurrent?.workspaceId;
  if(!wsId){
    setImportStatus('请先打开或新建工作区','error');
    pushEvent('请先打开或新建工作区','err');
    return;
  }
  const volumeRaw=document.getElementById('import-vol')?.value.trim()||'';
  const volumeId=volumeRaw==='__new'?undefined:(volumeRaw||undefined);
  const target=volumeRaw==='__new'?{volume:'new'}:undefined;
  if(button){button.textContent='导入中…';button.setAttribute('aria-busy','true');button.style.pointerEvents='none'}
  setImportStatus('正在写入工作区并刷新章节列表…');
  try{
    const result=importSourcePath
      ? await window.lightee.invoke('import.run',{workspaceId:wsId,sourcePath:importSourcePath,volumeId,target})
      : await window.lightee.invoke('import.text',{workspaceId:wsId,text:importDraftText,volumeId,target});
    if(!result?.ok){
      const message=result?.error?.message||'导入失败';
      setImportStatus(message,'error');
      pushEvent('导入失败：'+message,'err');
      return;
    }
    pushEvent('✓ 导入完成 — '+result.value.chapters+' 章，章节列表已刷新','ok');
    importDraftText='';
    importSourcePath='';
    closeImportModal();
    // 刷新真实文件树（bridge）
    if(handle?.adapter){await handle.adapter.list();await handle.enterWorkbench(wsId)}
  }catch(cause){
    const message=cause instanceof Error?cause.message:String(cause);
    setImportStatus(message,'error');
    pushEvent('导入失败：'+message,'err');
  }finally{
    if(button){button.textContent='确认导入';button.removeAttribute('aria-busy');button.style.pointerEvents=''}
  }
}
function enterWorkbench(){current='main';show();pushEvent('进入工作台','act')}
// ===== 切换（v22 恢复）=====
const VARIANTS=[
  {key:'dash',name:'启动中心',render:renderDash},
  {key:'main',name:'工作台',render:renderMain},
];
let current=new URLSearchParams(location.search).get('variant')||'dash';
function show(){
  const v=VARIANTS.find(x=>x.key===current)??VARIANTS[0];
  stage.innerHTML=v.render();
  label.textContent=v.key+' — '+v.name;
  if(window.__lighteeLegacyVariantRoute) history.replaceState(null,'','?variant='+v.key);
  if(current==='main'){bindTabs();bindEditable();setTimeout(()=>{refreshBookCs();requestAnimationFrame(()=>moveCursor())},0);bindSideDrop();bindChapterDrag()}
  if(current==='dash'){
    // bridge 刷新：上次编辑/工作区卡真实数据（每次 dash 渲染后）
    const bridge=window.__lighteeWorkspaceBridge;
    if(bridge&&typeof bridge.refreshDashboard==='function'){setTimeout(()=>bridge.refreshDashboard(),30)}
  }
}
// 侧栏拖拽导入：悬停高亮 + 覆盖提示 + 松手进入导入（真实文件读取走 IPC，后续接线）
let sideDropCount=0;
function bindSideDrop(){
  const side=document.querySelector('.side');
  if(!side)return;
  side.addEventListener('dragenter',(e)=>{e.preventDefault();sideDropCount++;side.classList.add('drag-over')});
  side.addEventListener('dragover',(e)=>{e.preventDefault();e.dataTransfer.dropEffect='copy'});
  side.addEventListener('dragleave',()=>{sideDropCount--;if(sideDropCount<=0){sideDropCount=0;side.classList.remove('drag-over')}});
  side.addEventListener('drop',(e)=>{e.preventDefault();sideDropCount=0;side.classList.remove('drag-over');showToast('📥 已接收文件 · 正在准备导入…',{duration:2600});const file=e.dataTransfer?.files?.[0];if(file&&typeof importPreview==='function'){importPreview('file');const pending=typeof window.lightee?.getPendingDrop==='function'?window.lightee.getPendingDrop():null;const path=pending?.path||file.path||file.name;setTimeout(()=>{setImportStatus('已接收 '+(pending?.name||path)+' · 正在解析预览…','ok');if(typeof window.lightee==='function'||window.lightee){window.lightee.invoke('import.preview',{sourcePath:path}).then(r=>{if(r?.ok){importSourcePath=path;renderImportFilePreview(r.value);setImportStatus('预览完成，可以确认导入','ok')}else setImportStatus(r?.error?.message||'文件预览失败','error')}).catch(()=>{})}else{importSourcePath=path;renderImportFilePreview({sourcePath:path,format:'txt',chapters:[{title:'第1話 出会い',charCount:1234}]});setImportStatus('预览完成（原型模拟）','ok')}},160)}else{setTimeout(()=>{if(typeof importPreview==='function')importPreview('file');pushEvent('松手导入 · 已打开导入确认','ok')},220)}});
  if(document.querySelector('.side-drop-hint'))showToast('可拖入 TXT / MD / EPUB 文件到侧栏导入',{duration:2600});
}
// 文件树拖拽排序（Pointer Events 自定义拖拽，不依赖浏览器 DnD 链）：同卷排序 + 跨卷移动
// 视觉：跟随鼠标的标题浮层 + 目标位置插入线 + 卷高亮；松手执行排序/移动
// 状态为全局（document 级监听跨 DOM 重建保留）；pointerdown 绑定在 list 上
let dragState=null;
let dragGhost=null,dragLine=null;
let dragPointerDown=false,dragStartY=0,dragStartX=0,dragMoved=false;
function findChapterRef(id){
  const book=BOOKS[currentBook];
  for(const vol of book.vols){
    const idx=vol.chapters.findIndex(c=>c.id===id);
    if(idx>=0)return {vol,idx,chapter:vol.chapters[idx]};
  }
  return null;
}
function ensureDragGhost(){
  if(!dragGhost){dragGhost=document.createElement('div');dragGhost.className='drag-ghost';document.body.appendChild(dragGhost)}
  return dragGhost;
}
function ensureDragLine(){
  if(!dragLine){dragLine=document.createElement('div');dragLine.className='drag-line';document.body.appendChild(dragLine)}
  return dragLine;
}
function hideDragGhost(){if(dragGhost){dragGhost.classList.remove('show')}}
function hideDragLine(){if(dragLine){dragLine.classList.remove('show')}}
function resolveDragDrop(clientX,clientY){
  const el=document.elementFromPoint(clientX,clientY);
  const item=el?.closest?.('.item[data-cid]');
  const volHead=el?.closest?.('.vol-head');
  const volBody=el?.closest?.('.vol-body');
  if(item&&item.dataset.cid!==dragState.chapterId){
    const rect=item.getBoundingClientRect();
    const before=(clientY-rect.top)<rect.height/2;
    const targetRef=findChapterRef(item.dataset.cid);
    const afterId=before?(targetRef.idx>0?targetRef.vol.chapters[targetRef.idx-1].id:null):item.dataset.cid;
    return {volId:targetRef.vol.v,afterId,itemEl:item,before};
  }
  if(volHead||volBody){
    const targetVol=(volHead||volBody)?.dataset.vol;
    if(targetVol&&targetVol!==dragState.fromVol)return {volId:targetVol,afterId:null,volEl:(volHead||volBody)};
  }
  return null;
}
function onChapterPointerDown(e){
  const item=e.target.closest?.('.item[data-cid]');
  if(!item)return;
  if(e.target.closest?.('.ch-edit,.ch-del,.vol-edit'))return; // 不劫持编辑/删除按钮
  if(e.button!==0)return;
  dragPointerDown=true;dragMoved=false;dragStartY=e.clientY;dragStartX=e.clientX;
  dragState={chapterId:item.dataset.cid,fromVol:item.dataset.vol};
}
function onChapterPointerMove(e){
  if(!dragPointerDown||!dragState)return;
  const dy=e.clientY-dragStartY,dx=e.clientX-dragStartX;
  if(!dragMoved&&Math.hypot(dx,dy)<6)return; // 阈值内视为点击
  if(!dragMoved){dragMoved=true;ensureDragGhost();ensureDragLine();dragGhost.textContent='⠿ '+dragState.chapterId;dragGhost.classList.add('show');}
  e.preventDefault();
  dragGhost.style.left=(e.clientX+14)+'px';
  dragGhost.style.top=(e.clientY-12)+'px';
  clearDragInsertion();
  const drop=resolveDragDrop(e.clientX,e.clientY);
  if(drop){
    if(drop.itemEl){dragLine.style.left=drop.itemEl.getBoundingClientRect().left+'px';dragLine.style.width=drop.itemEl.getBoundingClientRect().width+'px';dragLine.style.top=(drop.before?drop.itemEl.getBoundingClientRect().top:drop.itemEl.getBoundingClientRect().bottom)+'px';dragLine.classList.add('show');}
    else if(drop.volEl){drop.volEl.classList.add('drop-target-vol')}
  }
}
function onChapterPointerUp(e){
  if(!dragPointerDown)return;
  dragPointerDown=false;
  if(!dragMoved){hideDragGhost();hideDragLine();dragState=null;return}
  e.preventDefault();
  const drop=resolveDragDrop(e.clientX,e.clientY);
  const chapterId=dragState.chapterId,fromVol=dragState.fromVol;
  const ref=findChapterRef(chapterId);
  if(drop&&ref){
    const targetVol=drop.volId||fromVol;
    const afterId=drop.afterId;
    // 无操作判断
    const noop=targetVol===fromVol&&(afterId===null?ref.idx===ref.vol.chapters.length-1:ref.idx===ref.vol.chapters.findIndex(c=>c.id===afterId));
    if(!noop){
      ref.vol.chapters.splice(ref.idx,1);
      const targetBookVol=BOOKS[currentBook].vols.find(v=>v.v===targetVol);
      if(targetBookVol){
        const afterRef=afterId?findChapterRef(afterId):null;
        const insertAt=afterRef&&afterRef.vol.v===targetVol?afterRef.idx+1:targetBookVol.chapters.length;
        targetBookVol.chapters.splice(insertAt,0,ref.chapter);
      }
      const label=ref.chapter.title||chapterId;
      rerenderChapterList();
      pushEvent('已移动章节《'+label+'》'+(targetVol===fromVol?' · 排序':' · 移至 '+targetVol),'ok');
    }
  }
  hideDragGhost();hideDragLine();clearDragInsertion();
  dragState=null;
}
function onChapterPointerCancel(){
  dragPointerDown=false;hideDragGhost();hideDragLine();clearDragInsertion();dragState=null;
}
function bindChapterDrag(){
  const list=document.getElementById('chapter-list');
  if(!list||list.dataset.dragBound)return;
  list.dataset.dragBound='1';
  // pointerdown 绑定在 list 上；pointermove/up/cancel 用 document 委托（不用 setPointerCapture，避免破坏点击）
  list.addEventListener('pointerdown',onChapterPointerDown);
  if(!window.__chapterDragBound){
    window.__chapterDragBound=true;
    document.addEventListener('pointermove',onChapterPointerMove);
    document.addEventListener('pointerup',onChapterPointerUp);
    document.addEventListener('pointercancel',onChapterPointerCancel);
  }
}
function clearDragInsertion(){
  document.querySelectorAll('.drop-before,.drop-after,.drop-target-vol').forEach(x=>x.classList.remove('drop-before','drop-after','drop-target-vol'));
  document.querySelectorAll('.drag-line.show').forEach(x=>x.classList.remove('show'));
}
if(!renderOnlyRuntime){
document.getElementById('prev').onclick=()=>{if(window.__lighteeLegacyVariantRoute===false)return;const i=VARIANTS.findIndex(x=>x.key===current);current=VARIANTS[(i-1+VARIANTS.length)%VARIANTS.length].key;show()};
document.getElementById('next').onclick=()=>{if(window.__lighteeLegacyVariantRoute===false)return;const i=VARIANTS.findIndex(x=>x.key===current);current=VARIANTS[(i+1)%VARIANTS.length].key;show()};
document.addEventListener('keydown',e=>{
  if(window.__lighteeLegacyVariantRoute===false)return;
  if((e.key==='Enter'||e.key===' ')&&e.target instanceof HTMLElement&&e.target.matches('[data-key-action]')){e.preventDefault();e.target.click();return}
  if(e.target instanceof Element && e.target.matches('input,textarea,select'))return;
  if(e.key==='ArrowLeft'){const i=VARIANTS.findIndex(x=>x.key===current);current=VARIANTS[(i-1+VARIANTS.length)%VARIANTS.length].key;show()}
  if(e.key==='ArrowRight'){const i=VARIANTS.findIndex(x=>x.key===current);current=VARIANTS[(i+1)%VARIANTS.length].key;show()}
  if((e.ctrlKey||e.metaKey)&&e.key==='x'){e.preventDefault();toggleExport()}
  if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key==='O'){e.preventDefault();toggleJaEdit()}
  // 设置早已不是独立浮层，而是启动中心里的一张卡（openSettings 跳过去并滚到它）——
  // 没有「关」这个动作，closeSettings 也从来没被定义过。settingsOpen 恒为 false，
  // 这两行的另一半一直是死路，跟着一起清掉。
  if((e.ctrlKey||e.metaKey)&&e.key===','){e.preventDefault();openSettings()}
  if(e.key==='Escape'&&exportOpen){exportOpen=false;const ep=document.getElementById('export-panel');if(ep)ep.innerHTML=''}
  if((e.ctrlKey||e.metaKey)&&e.key==='b'){e.preventDefault();viewMode='continuous';if(current==='main'){bindTabs()}pushEvent('连续编辑模式保持开启','act')}
  // 键盘完整导航
  if((e.ctrlKey||e.metaKey)&&e.key==='1'){if(current!=='main'){current='main';show()}bTab='bi';bindTabs()}
  if((e.ctrlKey||e.metaKey)&&e.key==='2'){if(current!=='main'){current='main';show()}bTab='terms';bindTabs()}
  if((e.ctrlKey||e.metaKey)&&e.key==='3'){if(current!=='main'){current='main';show()}bTab='review';bindTabs()}
  if((e.ctrlKey||e.metaKey)&&e.key==='n'){e.preventDefault();const items=[...document.querySelectorAll('.item[data-cid]')];const idx=items.findIndex(x=>x.classList.contains('sel'));const next=(idx+1)%items.length;items.forEach(x=>x.classList.remove('sel'));items[next].classList.add('sel')}
  if((e.ctrlKey||e.metaKey)&&e.key==='p'){e.preventDefault();const items=[...document.querySelectorAll('.item[data-cid]')];const idx=items.findIndex(x=>x.classList.contains('sel'));const next=(idx-1+items.length)%items.length;items.forEach(x=>x.classList.remove('sel'));items[next].classList.add('sel')}
});

// ===== 模拟 =====
setInterval(()=>{
  // 真实应用里这些数字来自 agent.log.list / 章节状态，绝不能由模拟器伪造
  if(lighteeReal())return;
  if(SIM.t2<100)SIM.t2=Math.min(100,SIM.t2+2+Math.random()*4);
  if(SIM.t3<100&&SIM.t2>40)SIM.t3=Math.min(100,SIM.t3+1+Math.random()*3);
  SIM.token+=Math.floor(60+Math.random()*200);
  SIM.cost+=(Math.random()<.2?0.02:0);

  const ids=['m-token','m-cache','m-cost','m-cache2','m-cost2'];
  ids.forEach(id=>{const el=document.getElementById(id);if(!el)return;
    if(id.includes('token'))el.textContent=SIM.token.toLocaleString();

    if(id.includes('cost'))el.textContent='¥'+SIM.cost.toFixed(2);
  });
  const fills=stage.querySelectorAll('.afill');
  if(fills.length>=3){fills[1].style.width=SIM.t2+'%';fills[2].style.width=SIM.t3+'%'}
  const pcts=stage.querySelectorAll('.agent-row .apct');
  if(pcts.length>=3){pcts[1].textContent=SIM.t2+'%';pcts[2].textContent=SIM.t3+'%'}
  const sfs=stage.querySelectorAll('.sfill');
  if(sfs.length>=2){sfs[0].style.width=SIM.t2+'%';sfs[1].style.width=SIM.t3+'%'}
  // 底部系统栏
  const st1=document.getElementById('sys-t1');if(st1)st1.textContent=Math.round(SIM.t1)+'%';
  const st2=document.getElementById('sys-t2');if(st2)st2.textContent=Math.round(SIM.t2)+'%';
  const st3=document.getElementById('sys-t3');if(st3)st3.textContent=Math.round(SIM.t3)+'%';
  // 累计节省增长（每次调用后累加 usage.cacheRead）
  if(Math.random()<.5){
    SIM.savedTokens+=Math.floor(200+Math.random()*500);
    SIM.savedCost=0.31+SIM.savedTokens*0.0028/1000;
    const stk=document.getElementById('saved-tok');if(stk)stk.textContent=(SIM.savedTokens/1000).toFixed(1)+'k tok';
    const sc2=document.getElementById('saved-cost');if(sc2)sc2.textContent='¥'+SIM.savedCost.toFixed(2);
  }
  const stk=document.getElementById('sys-token');if(stk&&!lighteeReal())stk.textContent=SIM.token.toLocaleString();
  const de=document.getElementById('dash-events');
  if(de){const t=new Date().toLocaleTimeString();de.innerHTML=`<div class="ev act">${t} 翻译 Agent → ch003 ${SIM.t2.toFixed(0)}%</div>`+de.innerHTML;if(de.children.length>5)de.lastChild.remove()}
  // 时钟
  const dc=document.getElementById('dash-clock');
  if(dc){const n=new Date();dc.textContent=n.toTimeString().slice(0,8)}
  const dd=document.getElementById('dash-date');
  if(dd){const n=new Date();dd.textContent=n.toLocaleDateString('zh-CN')+' '+['日','一','二','三','四','五','六'][n.getDay()]}
  // 网络/延迟/速率假数据
  const tx=document.getElementById('net-tx');
  if(tx)tx.textContent=(0.8+Math.random()*0.8).toFixed(1)+' MB/s';
  const rx=document.getElementById('net-rx');
  if(rx)rx.textContent=(0.5+Math.random()*0.6).toFixed(1)+' MB/s';
  const lat=document.getElementById('net-lat');
  if(lat){SIM.lat=30+Math.floor(Math.random()*40);lat.textContent=SIM.lat+' ms'}
  const rate=document.getElementById('m-rate');
  if(rate){SIM.rate=80+Math.floor(Math.random()*160);rate.textContent=SIM.rate+' tok/s'}
  // spinner
  const sp=document.getElementById('dash-spinner');
  if(sp){const sps=['◐','◓','◑','◒'];sp.textContent=sps[Math.floor(Date.now()/200)%4]+' Agent 活动 '+SIM.t2.toFixed(0)+'%'}
},900);
}


// ===== 导出面板 =====
let exportOpen=false;
let exportFormat='TXT';
let exportScope='current';
// 双语对照从「第四种格式」改成一个开关：它和 TXT/Markdown/EPUB 不是同一维度的选择，
// 排成一排等于逼作者在「要 EPUB」和「要对照」之间二选一——而两者本来可以同时要。
let exportBilingual=false;
/** 产物文件名里代表范围的那一段，与 engine 的 targetSuffix 同一套写法 */
function exportScopeSuffix(){
  if(exportScope==='book')return '全卷';
  if(exportScope==='pick'){
    const n=document.querySelectorAll('#exp-chapter-list input[type=checkbox]:checked').length;
    return n===1?(document.querySelector('#exp-chapter-list input[type=checkbox]:checked')?.value||'章节'):'选'+n+'章';
  }
  return (typeof curChapter!=='undefined'&&curChapter)||'章节';
}
function exportBlockReason(){
  if(pendingIdx<PENDING_CARDS.length)return '先完成术语确认';
  if(translateTimer||chapterPhase==='translating')return '翻译仍在运行';
  if(chapterPhase==='ready')return '先开始并完成整章翻译';
  if(reviewPendingCount()>0)return '还有 '+reviewPendingCount()+' 个审校提示待处理';
  if(chapterPhase==='revising')return '先点击“完成本章”';
  return '';
}
function updateExportGate(){
  const reason=exportBlockReason();
  const status=document.getElementById('exp-gate');
  const button=document.getElementById('exp-run');
  if(status){status.textContent=reason?'暂不可导出 · '+reason:'已保存，可以导出';status.style.color=reason?'var(--yellow)':'var(--green)'}
  if(button){button.disabled=Boolean(reason);button.setAttribute('aria-disabled',String(Boolean(reason)))}
}
function setExportChoice(kind,value){
  if(kind==='format')exportFormat=value;
  if(kind==='scope')exportScope=value;
  document.querySelectorAll('[data-export-'+kind+']').forEach(button=>button.classList.toggle('hot',button.dataset['export'+kind[0].toUpperCase()+kind.slice(1)]===value));
  syncExportPreview();
  updateExportGate();
}
function toggleExportBilingual(){
  exportBilingual=!exportBilingual;
  const chip=document.querySelector('[data-export-bilingual]');
  if(chip){chip.classList.toggle('hot',exportBilingual);chip.setAttribute('aria-pressed',String(exportBilingual))}
  syncExportPreview();
}
/** 作者一旦自己动过文件名，就不再被范围/格式的变化覆盖——那是他打的字 */
function markExportNameTouched(){
  const el=document.getElementById('exp-file-name');
  if(el)el.dataset.touched='1';
}
/** 面板下方那两行要说的是**这次点下去会得到什么**，不是一个写死的示例名 */
function syncExportPreview(){
  const picker=document.getElementById('exp-chapter-picker');
  if(picker)picker.hidden=exportScope!=='pick';
  const ext=exportFormat==='Markdown'?'md':exportFormat==='EPUB'?'epub':'txt';
  const extEl=document.getElementById('exp-file-ext');
  if(extEl&&extEl.textContent!=='.'+ext)extEl.textContent='.'+ext;
  const nameEl=document.getElementById('exp-file-name');
  if(nameEl&&nameEl.dataset.touched!=='1'){
    const stem='书名_'+exportScopeSuffix()+(exportBilingual?'_双语':'');
    if(nameEl.value!==stem)nameEl.value=stem;
  }
}
function runPrototypeExport(){
  const reason=exportBlockReason();
  const status=document.getElementById('exp-status');
  if(reason){if(status)status.textContent=reason;return}
  const button=document.getElementById('exp-run');
  if(button){button.disabled=true;button.textContent='导出中…'}
  const label=exportFormat+(exportBilingual?' 双语对照':'');
  const scopeLabel=exportScope==='current'?'当前章节':exportScope==='pick'?exportScopeSuffix():'全书';
  if(status)status.textContent='正在生成 '+label+'…';
  setTimeout(()=>{if(status)status.textContent='✓ 已导出 · '+label+' · '+scopeLabel;if(button){button.disabled=false;button.textContent='导出译文'};pushEvent('✓ 导出完成 · '+label,'ok')},420);
}
function finishChapter(){
  const pending=reviewPendingCount();
  if(pending){selectMainTab('review');pushEvent('本章还有 '+pending+' 个审校提示，请先处理','err');return}
  if(chapterPhase!=='revising'&&chapterPhase!=='approved'){pushEvent('当前章节还未完成翻译','err');return}
  Object.keys(REVIEW_INVALIDATED).forEach(paraId=>delete REVIEW_INVALIDATED[paraId]);
  chapterPhase='approved';
  const activeBook=BOOKS[currentBook];
  const activeChapter=activeBook?.vols.flatMap(volume=>volume.chapters).find(chapter=>chapter.id===curChapter);
  if(activeChapter){activeChapter.state='approved';activeChapter.icon='✔';rerenderChapterList();refreshBookCs()}
  selectMainTab('bi');
  pushEvent('✓ 作者已完成本章确认 · 可以导出','ok');
}
// 编辑器外观设置填充：bridge 提供读取能力时把当前值填入设置面板（主页/工作台共用）
function fillEditorSettings(){
  const card=document.getElementById('wc-settings-card');
  if(!card)return;
  const read=window.__lighteeReadEditorSettings;
  if(typeof read!=='function')return;
  read().then(r=>{
    if(!r||!r.ok)return;
    const s=r.settings;
    for(const key of Object.keys(EDITOR_SETTING_OPTIONS)){
      const el=card.querySelector('[data-editor-setting="'+key+'"]');
      if(el)el.textContent=(EDITOR_SETTING_OPTIONS[key].label[s[key]]||s[key])+' ▸';
    }
  });
}
// 标题栏右上角「AI 服务商设置…」的落点：直接停在模型/服务商那一格，
// 而不是把用户丢到设置卡顶部再让他自己找。
function openAiSettings(){
  current='dash';
  show();
  setTimeout(()=>{
    const quad=document.getElementById('wc-ai-quad')||document.getElementById('wc-settings-card');
    if(quad)quad.scrollIntoView({behavior:'smooth',block:'center'});
    fillEditorSettings();
  },60);
  pushEvent('设置 · 模型与服务商','act');
}
function openSettings(){
  // 设置统一入口：跳转欢迎屏（启动中心）设置卡——不另做独立设置界面
  current='dash';
  show();
  setTimeout(()=>{
    const card=document.getElementById('wc-settings-card');
    if(card)card.scrollIntoView({behavior:'smooth',block:'center'});
    fillEditorSettings();
    // show() 刚把主页整块重绘过，桥先前填进「翻译偏好 / 模型·服务商」的真实内容随之被冲掉。
    // 不叫回来的话这两格就是空的——设计稿骨架文案曾经恰好盖住这个空，
    // 骨架一撤，空框就露了出来。
    window.__lighteeWorkspaceBridge?.refreshDashboard?.();
  },60);
  pushEvent('设置（启动中心）','act');
}
let translateTimer=null,translateStep=0,translateTimeout=null;
function restoreActBtn(){
  const btn=document.getElementById('main-act-btn');
  if(btn){btn.textContent='翻译';btn.onclick=startTranslate;btn.style.borderColor='';btn.style.color='';}
}
function stopTranslate(){
  if(!translateTimer)return;
  clearInterval(translateTimer);translateTimer=null;
  if(translateTimeout){clearTimeout(translateTimeout);translateTimeout=null;}
  translateStep=0;
  // Agent 状态重置
  const agents=document.querySelectorAll('.sys-agent');
  const setTxt=(i,t)=>{const el=agents[i]?.querySelector('span:last-child');if(el)el.textContent=t;};
  setTxt(1,'待命');setTxt(2,'待命');
  restoreActBtn();
  const t=new Date().toLocaleTimeString();
  const ev=document.getElementById('ev-list');
  if(ev)ev.innerHTML=`<div class="ev act">${t} ⏹ 已停止 ch003 翻译（Manager: 保存进度，可稍后继续）</div>`+ev.innerHTML;
  pushEvent('已停止翻译','act');
}
function startTranslate(){
  if(pendingIdx<PENDING_CARDS.length){
    chapterPhase='terms';
    selectMainTab('terms');
    pushEvent('整章翻译暂缓 · 先完成 '+(PENDING_CARDS.length-pendingIdx)+' 个术语确认','err');
    return;
  }
  if(translateTimer)return;
  chapterPhase='translating';
  selectMainTab('bi');
  syncWorkflowUI();
  // v46: 运行中按钮变"停止"
  const btn=document.getElementById('main-act-btn');
  if(btn){btn.textContent='⏹ 停止';btn.onclick=stopTranslate;btn.style.borderColor='rgba(248,113,113,.6)';btn.style.color='var(--red)';}
  pushEvent('Manager: 开始 ch003 — 术语表就绪，指派翻译 Agent','act');
  // 阶段: 0 翻译中 → 1 审校 → 2 修订 → 3 完成
  translateStep=0;
  const agents=document.querySelectorAll('.sys-agent');
  const agentText=(i)=>agents[i]?.querySelector('span:last-child');
  translateTimer=setInterval(()=>{
    const cur=document.querySelector('.wc-kv .v')?.textContent||'';
    const pct=Math.min(100,SIM.t2+6+Math.random()*14);
    SIM.t2=pct;
    const ev=document.getElementById('ev-list');
    const t=new Date().toLocaleTimeString();
    if(ev){
      if(translateStep===0){
        if(ev)ev.innerHTML=`<div class="ev act">${t} 翻译 Agent → ch003 ${pct.toFixed(0)}%</div>`+ev.innerHTML;
        if(agentText(1))agentText(1).textContent=`ch003 ⏳ ${pct.toFixed(0)}%`;
        if(pct>=100){translateStep=1;SIM.t2=100;
          pushEvent('翻译 Agent: ch003 初稿完成，交审校','act');
          if(ev)ev.innerHTML=`<div class="ev act">${t} 审校 Agent → 自动审校 ch003（术语/语气/对话格式）</div>`+ev.innerHTML;
          if(agentText(1))agentText(1).textContent='✓ 完成';
          if(agentText(2))agentText(2).textContent='ch003 ⏳ 审校中';
        }
      }else if(translateStep===1){
        translateTimeout=setTimeout(()=>{translateStep=2;
          if(agentText(2))agentText(2).textContent='✓ 通过';
          pushEvent('Manager: 审校发现 1 处语气漂移 → 指挥修订','act');
          if(ev)ev.innerHTML=`<div class="ev act">${t} Manager 反馈 → 翻译 Agent 修订 ch003</div>`+ev.innerHTML;
          if(agentText(1))agentText(1).textContent='修订 ⏳';
        },1200);
        translateStep=3;
      }else if(translateStep===3){
        clearInterval(translateTimer);translateTimer=null;
        restoreActBtn();
        if(agentText(1))agentText(1).textContent='✓ 完成';
        if(agentText(2))agentText(2).textContent='✓ 就绪';
        if(ev)ev.innerHTML=`<div class="ev act">${t} ✓ ch003 翻译完成 — 双语对照就绪（审校自动执行）</div>`+ev.innerHTML;
        // v47: Manager 记录浓缩提示（对齐内核 maybeCompact——超阈值才触发）
        if(ev)ev.innerHTML=`<div class="ev act">${t} Manager: 调用记录已累积 ${SIM.t1+1} 行（< 窗口−16k，未触发浓缩）</div>`+ev.innerHTML;
        chapterPhase='approved';
        const activeBook=BOOKS[currentBook];
        const activeChapter=activeBook?.vols.flatMap(volume=>volume.chapters).find(chapter=>chapter.id===curChapter);
        if(activeChapter){activeChapter.state='approved';activeChapter.icon='✔';rerenderChapterList();refreshBookCs()}
        selectMainTab('bi');
        pushEvent('✓ ch003 完成：术语 ✓ 翻译 ✓ 审校 ✓ · 作者可开始修订','ok');
        if(document.getElementById('save-hint'))document.getElementById('save-hint').style.display='inline';
      }
    }
  },420);
}
function cycleViewMode(){
  const modes=['paras','split','stack'];
  viewMode=modes[(modes.indexOf(viewMode)+1)%modes.length];
  if(current==='main'){bindTabs()}
  pushEvent('对照模式 → '+viewMode,'act');
}
function toggleExport(){
  exportOpen=!exportOpen;
  let ep=document.getElementById('export-panel');
  if(!ep){
    ep=document.createElement('div');
    ep.id='export-panel';
    ep.style.cssText='position:absolute;bottom:40px;right:14px;z-index:20;background:var(--panel2);border:1px solid var(--border2);border-radius:8px;padding:12px 16px;font-size:12px;box-shadow:0 4px 20px rgba(0,0,0,.6);width:340px';
    stage.appendChild(ep);
  }
  if(exportOpen){
    ep.innerHTML=`<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--accent);margin-bottom:10px"><strong>导出译文</strong><span style="color:var(--dimmer);font-size:10px">有译文就能导</span></div>
      <div class="export-choice-group"><div class="export-choice-label">格式</div><div class="export-choice-buttons"><button type="button" class="chip${exportFormat==='TXT'?' hot':''}" data-key-action data-export-format="TXT" onclick="setExportChoice('format','TXT')">TXT</button><button type="button" class="chip${exportFormat==='Markdown'?' hot':''}" data-key-action data-export-format="Markdown" onclick="setExportChoice('format','Markdown')">Markdown</button><button type="button" class="chip${exportFormat==='EPUB'?' hot':''}" data-key-action data-export-format="EPUB" onclick="setExportChoice('format','EPUB')">EPUB</button><span class="export-choice-sep" aria-hidden="true"></span><button type="button" class="chip${exportBilingual?' hot':''}" data-key-action data-export-bilingual aria-pressed="${exportBilingual}" title="原文与译文逐段相邻，三种格式都能出" onclick="toggleExportBilingual()">双语对照</button></div></div>
      <div class="export-choice-group"><div class="export-choice-label">范围</div><div class="export-choice-buttons"><button type="button" class="chip${exportScope==='current'?' hot':''}" data-key-action data-export-scope="current" onclick="setExportChoice('scope','current')">当前章节</button><button type="button" class="chip${exportScope==='pick'?' hot':''}" data-key-action data-export-scope="pick" onclick="setExportChoice('scope','pick')">挑选章节</button><button type="button" class="chip${exportScope==='book'?' hot':''}" data-key-action data-export-scope="book" onclick="setExportChoice('scope','book')">全书</button></div>
        <div id="exp-chapter-picker" class="export-picker"${exportScope==='pick'?'':' hidden'}>
          <div class="export-picker-head"><span id="exp-pick-count">未选择章节</span><span><button type="button" class="chip quiet" data-export-pick-all>全选</button><button type="button" class="chip quiet" data-export-pick-none>清空</button></span></div>
          <div class="export-picker-list" id="exp-chapter-list">${lighteeReal()?'':'<div class="export-picker-empty">真实应用中此处列出本书章节</div>'}</div>
        </div>
      </div>
      <div id="exp-composition" style="color:var(--dimmer);font-size:10px;margin:6px 0 2px"></div>
      <div class="export-output">
        <!-- 位置留空，真实路径由 bridge 的 exportOutDir 写入——写死一个演示路径，bridge 刷新前作者会看到一个不存在的目录 -->
        <div class="export-out-row"><span class="export-out-k">位置</span><strong id="exp-out-dir"></strong><button type="button" class="chip quiet" data-key-action data-export-pick-dir>更改…</button></div>
        <div class="export-out-row"><span class="export-out-k">文件名</span><input id="exp-file-name" type="text" spellcheck="false" autocomplete="off" oninput="markExportNameTouched()" placeholder="书名_范围"><code id="exp-file-ext">.${exportFormat==='Markdown'?'md':exportFormat==='EPUB'?'epub':'txt'}</code></div>
      </div>
      <div id="exp-gate" class="export-gate"></div>
      <div class="export-panel-foot"><span id="exp-status"></span><button id="exp-run" class="chip main-act" type="button" data-key-action onclick="runPrototypeExport()">导出译文</button></div>`;
    ep.classList.add('fx-fade');
    // 面板刚建出来时文件名是空的——默认名由 syncExportPreview 填，
    // 而它从前只在点了格式/范围之后才跑，于是一打开看到的是个空输入框。
    syncExportPreview();
    updateExportGate();
  }else{ep.innerHTML=''}
}
// ===== 原文只读切换 =====
let jaReadonly=true;
function toggleJaEdit(){
  jaReadonly=!jaReadonly;
  document.querySelectorAll('.bl-ja').forEach(el=>{
    if(jaReadonly){el.removeAttribute('contenteditable');el.style.border='none';el.style.opacity='0.55'}
    else{el.setAttribute('contenteditable','true');el.style.border='1px dashed var(--yellow)';el.style.opacity='1'}
  });
  pushEvent(jaReadonly?'原文恢复只读':'原文编辑已开启（改动会写回原文文件）','warn');
}
// ===== 译文编辑保存 =====
function bindEditable(){
  const editable=translationCanEdit();
  document.querySelectorAll('.bl-zh.editable').forEach(el=>{
    el.setAttribute('contenteditable',String(editable));
    el.setAttribute('aria-readonly',String(!editable));
  });
  document.addEventListener('keydown',e=>{
    if(e.target.closest && e.target.closest('.editable') && (e.ctrlKey||e.metaKey) && e.key==='s'){
      e.preventDefault();
      const manualBlock=e.target.closest('.ce-block.review-manual-editing');
      if(manualBlock){manualBlock.dataset.reviewDirty='true';completeManualReview(manualBlock)}
      const h=document.getElementById('save-hint');
      if(h){h.style.display='inline';setTimeout(()=>h.style.display='none',3000)}
      pushEvent('译文已保存 → translations/ch003_zh.md','ok');
    }
  });
}


// ===== 焦点指示 =====
let focusZone='list';
function setFocus(zone){
  focusZone=zone;
  const list=document.querySelector('.side .list');
  const content=document.getElementById('bpanel');
  if(list)list.style.outline=zone==='list'?'1px solid var(--accent)':'none';
  if(content)content.style.outline=zone==='content'?'1px solid var(--accent)':'none';
  pushEvent('焦点 → '+(zone==='list'?'章节列表':'内容区'),'act');
}


// ===== 翻译失败反馈 =====
function simFail(){
  const item=document.querySelector('.item[data-cid="ch005"]');
  if(item){item.classList.add('fail-blink');item.querySelector('.st').textContent='failed';item.querySelector('.st').style.color='var(--red)'}
  pushEvent('✖ ch005 翻译失败 — 重试中(2/3)','warn');
  setTimeout(()=>{if(item){item.classList.remove('fail-blink');item.querySelector('.st').textContent='ready';item.querySelector('.st').style.color='#718096'}},4000);
}


// ===== 待审术语入口 =====


// ===== 空状态 =====
function emptyState(){
  const c=document.getElementById('bpanel');
  if(c)c.innerHTML=`<div class="empty-state"><div class="big">◌</div>
    当前章节还没有译文<br><br>
    <kbd>Ctrl</kbd>+<kbd>T</kbd> 翻译本章 · 或点击上方「翻译」</div>`;
}


// ===== 进度完成动画 =====
function progressDone(){
  const fill=document.querySelector('.side .mini-fill');
  if(fill){fill.style.width='100%';fill.classList.add('done-anim');setTimeout(()=>fill.classList.remove('done-anim'),500)}
}


// ===== 左右分屏锚点联动 =====
function bindAnchor(){
  const lefts=document.querySelectorAll('.vB-split-left [data-para]');
  const rights=document.querySelectorAll('.vB-split-right [data-para]');
  const clear=()=>{document.querySelectorAll('.anchor-hl').forEach(e=>e.classList.remove('anchor-hl'))};
  lefts.forEach(l=>{l.onclick=()=>{clear();l.classList.add('anchor-hl');const r=document.querySelector('.vB-split-right [data-para="'+l.dataset.para+'"]');if(r){r.classList.add('anchor-hl');r.scrollIntoView({block:'center'})}}});
  rights.forEach(r=>{r.onclick=()=>{clear();r.classList.add('anchor-hl');const l=document.querySelector('.vB-split-left [data-para="'+r.dataset.para+'"]');if(l){l.classList.add('anchor-hl');l.scrollIntoView({block:'center'})}}});
}


// ===== 设置面板 =====
const SETTINGS_THINKING=['off','minimal','low','medium','high','xhigh','max'];
const SETTINGS_MODES=['parallel','balanced','quality'];
let setCat='模型配置';
const settingsState={
  agents:{terminologist:{model:'deepseek-v4-flash',thinking:'max'},translator:{model:'deepseek-v4-flash',thinking:'high'},reviewer:{model:'deepseek-v4-flash',thinking:'max'},orchestrator:{model:'deepseek-v4-flash',thinking:'high'}},
  mode:'balanced',concurrency:3,batchChars:2000,
  jaEditable:false,autoSave:true,typewriter:true,theme:'cyber',
};

function cycle(list,cur,dir){const i=list.indexOf(cur);return list[(i+dir+list.length)%list.length]}

if(renderOnlyRuntime){
  // 生产 render-only：隐藏变体切换器（main — 工作台 ◀▶）
  const sw=document.getElementById('switcher');
  if(sw)sw.style.display='none';
}

if(!renderOnlyRuntime){try{show()}catch(err){stage.innerHTML='<pre style="color:var(--red);padding:20px">ERROR: '+err.message+'</pre>'}
}
