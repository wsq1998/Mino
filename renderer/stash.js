'use strict';
// Mio · 中转站浮窗渲染逻辑（v2.1 → v2.11 模块化重构）
// ============================================================
// 职责：胶囊/抽屉两态切换、列表渲染、HTML5 拖入（webUtils.getPathForFile）、
//       拖出（dragstart → 主进程 startDrag）、项操作菜单（显示/打开/复制路径/移除）、pin。
// 安全：凡涉及「已存条目路径」的操作，渲染层只传节点 id，主进程查表还原真实路径。
// 依赖：window.mio.v2（preload 暴露）、window.getPathForFile（preload 暴露）。
//
// 组织结构（v2.11 按职责拆分为独立模块，每个模块一个 IIFE 命名空间）：
//   [1] utils   —— esc / fmtSize / flash 通用工具
//   [2] state   —— 全部共享可变状态（mode/pinned/items/listExpanded/...）
//   [3] cat     —— 类型分组（CATS 表 / catOf / badgeFor）
//   [4] panel   —— 胶囊⇄抽屉形态控制（setPanelMode / 收起动画 / applyMode）
//   [5] list    —— 列表渲染（renderList / 展开收起 / 分组卡片）
//   [6] drag    —— 拖入（onDragOver/drop）与拖出（dragstart/dragend）
//   [7] ctx     —— 右键菜单（AirDrop / 显示 / 打开 / 复制 / 移除）
//   [8] head    —— 头部按钮（钉住 / 选择 / 展开 / 收起）
//   [9] init    —— 初始化（读设置 / 订阅主进程事件 / 首屏加载）
// 各模块通过 state 对象共享数据，通过 v2 桥接主进程。
// ============================================================

(function () {
  const bridge = window.mio || null;
  const v2 = (bridge && bridge.v2) || null;
  const getPathForFile = typeof window.getPathForFile === 'function' ? window.getPathForFile : null;

  // ============================================================
  // [1] 工具模块
  // ============================================================
  const util = (() => {
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
    }
    function fmtSize(n) {
      const b = Number(n) || 0;
      if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
      if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
      if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
      return b + ' B';
    }
    let toastTimer = null;
    function flash(text) {
      const toastEl = document.getElementById('stToast');
      if (!toastEl) return;
      toastEl.textContent = String(text || '');
      toastEl.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1600);
    }
    return { esc, fmtSize, flash };
  })();

  // ============================================================
  // [2] 状态模块 —— 全部共享可变状态集中在这里
  // ============================================================
  const state = {
    root: document.getElementById('stRoot'),
    listEl: document.getElementById('stList'),
    emptyEl: document.getElementById('stEmpty'),
    capCountEl: document.getElementById('stCapCount'),
    countEl: document.getElementById('stCount'),
    pinBtn: document.getElementById('stPinBtn'),
    addBtn: document.getElementById('stAddBtn'),
    collapseBtn: document.getElementById('stCollapseBtn'),
    expandBtn: document.getElementById('stExpandBtn'),
    capsuleEl: document.getElementById('stCapsule'),
    dropHintEl: document.getElementById('stDropHint'),
    ctxEl: document.getElementById('stCtx'),
    mode: 'capsule',
    pinned: false,
    items: [],
    allowDragAutoShow: true, // 华为式触发开关（设置 stash.dragAutoShow，缺省开）
    listExpanded: false,     // 列表展开态（展开后 3 行可滚动）
    // 收起动画状态
    closing: false,
    closingTimer: null,
    closingEndFn: null,
    // 拖拽
    dragExpandRequested: false,
    warmSentId: null,
    ctxId: null,
  };

  // ============================================================
  // [3] 类型分组模块 —— 分类表 + 归类 + 图标
  // ============================================================
  const cat = (() => {
    // 分组顺序与图标（保持此顺序，空组自动跳过）
    const CATS = [
      { key: 'image', name: '图片', ico: '🖼️', ext: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'tiff', 'tif', 'svg', 'raw', 'avif', 'cr2', 'nef'] },
      { key: 'video', name: '视频', ico: '🎬', ext: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg'] },
      { key: 'audio', name: '音频', ico: '🎵', ext: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'aiff', 'opus'] },
      { key: 'doc', name: '文档', ico: '📄', ext: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'rtf', 'csv', 'html', 'css', 'js', 'ts', 'json', 'py', 'zip', 'rar', '7z', 'pages', 'key', 'numbers', 'code'] },
      { key: 'folder', name: '文件夹', ico: '📁', ext: [] },
      { key: 'other', name: '其他', ico: '📦', ext: [] },
    ];
    function catOf(it) {
      if (it.isDir) return 'folder';
      const ext = (String(it.name || it.path || '').split('.').pop() || '').toLowerCase();
      for (const c of CATS) {
        if (c.key !== 'folder' && c.key !== 'other' && c.ext.includes(ext)) return c.key;
      }
      return 'other';
    }
    function badgeFor(c) {
      return c === 'image' ? '🖼️' : c === 'video' ? '🎬' : c === 'audio' ? '🎵' : c === 'folder' ? '📁' : '📄';
    }
    // 把 items 按 CATS 顺序分组，过滤空组
    function groupBy(items) {
      return CATS
        .map((c) => ({ ...c, list: items.filter((it) => catOf(it) === c.key) }))
        .filter((g) => g.list.length);
    }
    return { CATS, catOf, badgeFor, groupBy };
  })();

  // ============================================================
  // [4] 面板形态模块 —— 胶囊⇄抽屉切换 + 打开/收起动画
  // ============================================================
  const panel = (() => {
    const { root, pinBtn } = state;

    // 真正切换形态（同步，无动画）
    function setPanelMode(nextMode, payload) {
      state.mode = nextMode;
      root.classList.toggle('st--capsule', nextMode === 'capsule');
      root.classList.toggle('st--open', nextMode === 'open');
      root.classList.toggle('st--hidden', nextMode === 'hidden');
      root.classList.toggle('st--pinned', state.pinned);
      root.setAttribute('data-mode', nextMode);
      if (typeof payload.opacity === 'number') {
        root.style.setProperty('--st-capsule-opacity', String(payload.opacity));
      }
      // 触发边四向：移除旧方向类再加当前方向（top/bottom/left/right）
      root.classList.remove('st--top', 'st--bottom', 'st--left', 'st--right');
      root.classList.add('st--' + (payload.side || 'right'));
      if (pinBtn) {
        pinBtn.classList.toggle('on', state.pinned);
        pinBtn.setAttribute('title', state.pinned ? '取消钉住' : '钉住（展开后不自动收起）');
      }
    }

    // 打断进行中的收起动画（例如收起中途又收到 open）
    function cancelClosing() {
      if (state.closingTimer) { clearTimeout(state.closingTimer); state.closingTimer = null; }
      if (state.closingEndFn) {
        const panelEl = root.querySelector('.st-panel');
        if (panelEl) panelEl.removeEventListener('animationend', state.closingEndFn);
        state.closingEndFn = null;
      }
      if (state.closing) {
        state.closing = false;
        root.classList.remove('st--closing');
      }
    }

    // 收起动画：先加 .st--closing 播 0.16s 收起动画，animationend（或 170ms 兜底）后再真正收起，
    // 否则 display:none 会瞬间吞掉动画。prefers-reduced-motion 时跳过动画直接收起。
    function closeWithAnimation(payload) {
      state.closing = true;
      root.classList.add('st--closing');
      const panelEl = root.querySelector('.st-panel');
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (state.closingTimer) { clearTimeout(state.closingTimer); state.closingTimer = null; }
        if (state.closingEndFn && panelEl) panelEl.removeEventListener('animationend', state.closingEndFn);
        state.closingEndFn = null;
        root.classList.remove('st--closing');
        state.closing = false;
        setPanelMode(payload.mode, payload);
      };
      // 只认抽屉自身的收起动画名，忽略子项动画冒泡（stItemOut 等）
      state.closingEndFn = (e) => {
        if (e.animationName !== 'stDrawerOut' && e.animationName !== 'stDrawerOutH') return;
        finish();
      };
      if (panelEl) panelEl.addEventListener('animationend', state.closingEndFn);
      state.closingTimer = setTimeout(finish, 170); // 兜底：动画 0.16s，多留 10ms 余量
    }

    function applyMode(payload) {
      if (!payload) return;
      if (typeof payload.mode === 'string') state.mode = payload.mode; // 供 willClose 判断当前态
      state.pinned = !!payload.pinned;
      const nextMode = typeof payload.mode === 'string' ? payload.mode : state.mode;
      const willClose = root.classList.contains('st--open') && nextMode !== 'open';
      const reduceMotion = root.classList.contains('st--reduce-motion');

      // 收起：若非减弱动效且当前正开着，走动画收起（幂等：已有 closing 进行中则忽略重复触发）
      if (willClose && !reduceMotion) {
        if (!state.closing) closeWithAnimation({ ...payload, mode: nextMode });
        return;
      }
      // 收起动画中途又切回打开：立即打断，走正常打开
      if (state.closing) cancelClosing();
      setPanelMode(nextMode, payload);
    }

    return { applyMode, cancelClosing };
  })();

  // ============================================================
  // [5] 列表模块 —— 分组渲染 + 展开/收起 + 行数限制
  // ============================================================
  const list = (() => {
    const { listEl, countEl, capCountEl, emptyEl, expandBtn, root } = state;
    const { esc, fmtSize } = util;
    const LIST_ROW_H = 60; // 与 stash.css --st-list-row-h 保持一致（紧凑横排条目估算高度）
    const LIST_MAX_H = LIST_ROW_H * 2 + 12; // 默认 2 行（含 padding 余量）

    // 展开/收起：只改 class，不重渲染；货架态需同步主进程让面板高度跟随 2行⇄3行
    function setListExpanded(next) {
      state.listExpanded = !!next;
      root.classList.toggle('st--expanded', state.listExpanded);
      if (expandBtn) {
        expandBtn.textContent = state.listExpanded ? '▴' : '▾';
        expandBtn.setAttribute('title', state.listExpanded ? '收起列表' : '展开更多');
        expandBtn.setAttribute('aria-label', state.listExpanded ? '收起列表' : '展开更多');
      }
      // 货架态（top/bottom）面板高度固定由主进程 setBounds 决定：展开/收起必须同步主进程
      if (root.classList.contains('st--top') || root.classList.contains('st--bottom')) {
        if (v2 && v2.stashShelfExpand) v2.stashShelfExpand(state.listExpanded);
      }
    }

    function syncExpandBtn() {
      if (!expandBtn) return;
      const overflows = !!listEl && listEl.scrollHeight > listEl.clientHeight + 2;
      const meaningful = listEl && listEl.scrollHeight > LIST_MAX_H;
      expandBtn.hidden = !(overflows || meaningful);
    }

    // 渲染分组列表（v2.4 类型分组 + v2.11 紧凑横排条目）
    function renderList(nextItems) {
      const prevIds = new Set(state.items.map((i) => i.id)); // 用于「存入」入场动画，仅新条目播放
      if (Array.isArray(nextItems)) state.items = nextItems;
      const n = state.items.length;
      if (capCountEl) {
        capCountEl.textContent = String(n);
        capCountEl.hidden = n === 0;
      }
      if (countEl) countEl.textContent = `${n} 项`;
      if (emptyEl) emptyEl.hidden = n > 0;
      if (!listEl) return;
      if (n === 0) { listEl.innerHTML = ''; setListExpanded(false); if (expandBtn) expandBtn.hidden = true; return; }

      // 分组（保持 CATS 顺序，过滤空组）
      const groups = cat.groupBy(state.items);

      listEl.innerHTML = groups.map((g) => {
        const cards = g.list.map((it) => {
          const missing = it.exists === false;
          const draggable = missing ? 'false' : 'true';
          // 仅当该条目不在上一次渲染中（确有新增）时加 st-item--new，触发存入动画
          const isNew = prevIds.size > 0 && !prevIds.has(it.id);
          return `<div class="st-item${missing ? ' st-item--missing' : ''}${isNew ? ' st-item--new' : ''}" role="listitem" draggable="${draggable}" data-sid="${esc(it.id)}" title="${esc(it.srcPath || it.path || '')}">
            <span class="st-item-badge" aria-hidden="true">${cat.badgeFor(g.key)}</span>
            <span class="st-item-main">
              <span class="st-item-name">${esc(it.name || it.path)}</span>
              <span class="st-item-sub">${missing ? '文件不存在' : esc(fmtSize(it.size))}</span>
            </span>
            <span class="st-item-acts">
              <button class="st-mini" type="button" data-act="reveal" title="在访达中显示">⤢</button>
              <button class="st-mini" type="button" data-act="open" title="打开">↗</button>
              <button class="st-mini" type="button" data-act="copy" title="复制路径">⧉</button>
              <button class="st-mini st-mini--del" type="button" data-act="remove" title="移除（只删引用，不删文件）">✕</button>
            </span>
          </div>`;
        }).join('');
        return `<section class="st-group" data-cat="${g.key}">
          <header class="st-group-head"><span class="st-group-ico" aria-hidden="true">${g.ico}</span><span class="st-group-name">${g.name}</span><span class="st-group-n">${g.list.length}</span></header>
          <div class="st-group-items">${cards}</div>
        </section>`;
      }).join('');

      // 渲染后刷新「展开」按钮可见性（仅当内容超过 2 行阈值才显示）
      setListExpanded(state.listExpanded); // 保持当前展开态（root class + 按钮图标）
      syncExpandBtn();
    }

    return { renderList, setListExpanded, syncExpandBtn };
  })();

  // ============================================================
  // [6] 拖拽模块 —— 拖入（HTML5 drop）+ 拖出（dragstart → startDrag）
  // ============================================================
  const drag = (() => {
    const { root, listEl } = state;
    const { flash } = util;

    function bind() {
      // ---- 拖入（HTML5）----
      function onDragOver(e) {
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'copy'; } catch (_e) {}
        root.classList.add('st--dropping');
        // 悬停即展开（capsule + DRAG_ENTER → open），仅请求一次
        // 受 dragAutoShow 开关约束 —— 关掉后，仅手动打开的抽屉可接住拖入，拖到浮窗不再自动弹
        if (state.allowDragAutoShow && state.mode !== 'open' && !state.dragExpandRequested) {
          state.dragExpandRequested = true;
          if (v2 && v2.stashPanelShow) v2.stashPanelShow();
        }
      }
      root.addEventListener('dragenter', onDragOver);
      root.addEventListener('dragover', onDragOver);
      root.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && root.contains(e.relatedTarget)) return;
        root.classList.remove('st--dropping');
        state.dragExpandRequested = false;
      });
      root.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        root.classList.remove('st--dropping');
        state.dragExpandRequested = false;
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
        const paths = files.map((f) => {
          try {
            // Electron 33：File.path 已废弃，用 webUtils.getPathForFile；旧版回退 file.path
            return (getPathForFile ? getPathForFile(f) : (f && f.path)) || '';
          } catch (_e) { return ''; }
        }).filter(Boolean);
        if (!paths.length) { flash('无法读取文件路径'); return; }
        if (!v2) { flash('中转站不可用'); return; }
        const r = await v2.stashAdd({ paths });
        if (r && r.items) list.renderList(r.items);
        // 主进程 v2-stash-add 返回体没有 error 字段，真实原因在 failed[0].error
        // （'路径为空' / '文件不存在' / '已在暂存区' / '最多 100 项' / '复制失败：…'）—— 必须透出，不能再吞成「加入失败」。
        const failedList = (r && Array.isArray(r.failed)) ? r.failed : [];
        const addedN = (r && typeof r.added === 'number') ? r.added : 0;
        const reason = failedList.length ? (failedList[0].error || '') : '';
        if (failedList.length) {
          // 部分成功：同时报告成功与失败数量（例：已加入 1 项，另有 1 项未加入：已在暂存区）
          flash(addedN > 0
            ? (`已加入 ${addedN} 项，另有 ${failedList.length} 项未加入：${reason || '未知原因'}`)
            : (reason || '加入失败'));
        } else if (!r || !r.ok) {
          // 仅在确实没有任何原因可用时才落回笼统文案
          flash((r && r.error) || '加入失败');
        }
      });

      // ---- 拖出（dragstart → 主进程 startDrag）----
      if (listEl) {
        listEl.addEventListener('dragstart', (e) => {
          const item = e.target.closest('.st-item');
          if (!item || item.getAttribute('draggable') !== 'true') return;
          const id = item.dataset.sid;
          if (!id) return;
          // 诊断：证明 dragstart 确实派发（写主进程 trace）
          if (v2 && v2.stashTrace) v2.stashTrace('dragstart id=' + id);
          // 阻止默认 HTML5 拖拽，改由主进程 webContents.startDrag 发起原生拖拽
          // （这是 Electron 自定义原生拖出的标准做法，能让 startDrag 落在 dragstart 的同步窗口内）
          e.preventDefault();
          try {
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('text/plain', id);
          } catch (_e) {}
          // 移出动画：提起/离场（拖出到访达/其他 App）
          item.classList.remove('st-item--new');
          item.classList.add('st-item--leaving');
          if (v2) v2.stashDragOut([id]);
        });
        listEl.addEventListener('dragend', (e) => {
          const item = e.target.closest && e.target.closest('.st-item');
          if (item) item.classList.remove('st-item--leaving');
          if (v2) v2.stashDragEnd();
        });

        // 列表项悬停即预热该项真实拖影图标（事件委托；innerHTML 重渲染后仍有效）。
        // 仅在 id 变化时发一次，避免鼠标在项内移动时重复触发。
        listEl.addEventListener('mouseover', (e) => {
          const item = e.target && e.target.closest ? e.target.closest('.st-item') : null;
          if (!item) return;
          const id = item.dataset.sid;
          if (!id || id === state.warmSentId) return;
          state.warmSentId = id;
          if (v2 && v2.stashWarmIcon) v2.stashWarmIcon(id);
        });

        // 项操作（事件委托）：显示 / 打开 / 复制路径 / 移除
        listEl.addEventListener('click', async (e) => {
          const btn = e.target.closest('[data-act]');
          if (!btn) return;
          e.stopPropagation();
          const item = btn.closest('.st-item');
          const id = item && item.dataset.sid;
          if (!id || !v2) return;
          const act = btn.dataset.act;
          if (act === 'reveal') {
            const r = await v2.stashReveal(id);
            if (r && !r.ok) flash(r.error || '无法显示');
          } else if (act === 'open') {
            const r = await v2.stashOpen(id);
            if (r && !r.ok) flash(r.error || '打开失败');
          } else if (act === 'copy') {
            const r = await v2.stashCopyPath(id);
            flash(r && r.ok ? '已复制路径' : '复制失败');
          } else if (act === 'remove') {
            // 离场动画后再移除（只删引用，文件本身不动）
            const el = btn.closest('.st-item');
            if (el) el.classList.add('st-item--leaving');
            setTimeout(async () => {
              const r = await v2.stashRemove(id);
              if (r && r.items) list.renderList(r.items);
            }, 180);
          }
        });
      }
    }

    return { bind };
  })();

  // ============================================================
  // [7] 右键菜单模块 —— AirDrop / 显示 / 打开 / 复制 / 移除
  // ============================================================
  const ctx = (() => {
    const { listEl, ctxEl } = state;
    const { flash } = util;

    function hide() { if (ctxEl) { ctxEl.hidden = true; state.ctxId = null; } }

    function bind() {
      if (!listEl || !ctxEl) return;
      listEl.addEventListener('contextmenu', (e) => {
        const item = e.target.closest ? e.target.closest('.st-item') : null;
        if (!item) return; // 空白处不拦截系统菜单
        e.preventDefault();
        // 诊断：证明 contextmenu 确实派发
        if (v2 && v2.stashTrace) v2.stashTrace('contextmenu id=' + item.dataset.sid);
        state.ctxId = item.dataset.sid;
        ctxEl.innerHTML = [
          '<button class="st-ctx-item st-ctx-air" type="button" data-act="airdrop">📡 AirDrop 投送</button>',
          '<button class="st-ctx-item" type="button" data-act="reveal">⤢ 在访达中显示</button>',
          '<button class="st-ctx-item" type="button" data-act="open">↗ 打开</button>',
          '<button class="st-ctx-item" type="button" data-act="copy">⧉ 复制路径</button>',
          '<button class="st-ctx-item st-ctx-del" type="button" data-act="remove">✕ 移除</button>',
        ].join('');
        ctxEl.hidden = false;
        // 定位（避免越出浮窗可视区）
        const vw = window.innerWidth || 320;
        const vh = window.innerHeight || 200;
        const cw = ctxEl.offsetWidth || 150;
        const ch = ctxEl.offsetHeight || 160;
        const x = Math.min(e.clientX, vw - cw - 4);
        const y = Math.min(e.clientY, vh - ch - 4);
        ctxEl.style.left = Math.max(4, x) + 'px';
        ctxEl.style.top = Math.max(4, y) + 'px';
      });
      ctxEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || !state.ctxId || !v2) return;
        const id = state.ctxId;
        const act = btn.dataset.act;
        // 诊断：证明右键菜单项点击确实派发
        if (v2 && v2.stashTrace) v2.stashTrace('ctx-click act=' + act);
        hide();
        if (act === 'airdrop') {
          v2.stashAirdrop(id);
          flash('正在唤起 AirDrop 投送…');
        } else if (act === 'reveal') {
          const r = await v2.stashReveal(id);
          if (r && !r.ok) flash(r.error || '无法显示');
        } else if (act === 'open') {
          const r = await v2.stashOpen(id);
          if (r && !r.ok) flash(r.error || '打开失败');
        } else if (act === 'copy') {
          const r = await v2.stashCopyPath(id);
          flash(r && r.ok ? '已复制路径' : '复制失败');
        } else if (act === 'remove') {
          let el = null;
          listEl.querySelectorAll('.st-item').forEach((n) => { if (n.dataset.sid === id) el = n; });
          if (el) el.classList.add('st-item--leaving');
          setTimeout(async () => {
            const r = await v2.stashRemove(id);
            if (r && r.items) list.renderList(r.items);
          }, 180);
        }
      });
      // 点击别处 / Esc / 失焦 关闭
      document.addEventListener('click', (e) => { if (ctxEl && !ctxEl.contains(e.target)) hide(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
      window.addEventListener('blur', hide);
    }

    return { bind };
  })();

  // ============================================================
  // [8] 头部按钮模块 —— 钉住 / 选择 / 展开 / 收起
  // ============================================================
  const head = (() => {
    const { capsuleEl, collapseBtn, expandBtn, addBtn, pinBtn } = state;
    const { flash } = util;

    function openPanel() { if (v2 && v2.stashPanelShow) v2.stashPanelShow(); }

    function bind() {
      if (capsuleEl) {
        capsuleEl.addEventListener('click', openPanel);
        capsuleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel(); } });
      }
      // 抽屉「收起」应回到胶囊态（贴边细条仍在），而不是整个隐藏。
      // 走 toggle（open→capsule）；「彻底隐藏」只由设置里关掉常驻胶囊触发。
      if (collapseBtn) collapseBtn.addEventListener('click', (e) => { e.stopPropagation(); if (v2 && v2.stashPanelToggle) v2.stashPanelToggle(); });
      // 展开/收起列表（仅切 class，不重渲染；展开后 3 行可滚动）
      if (expandBtn) expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        list.setListExpanded(!state.listExpanded);
      });
      if (addBtn) addBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!v2) return;
        const r = await v2.stashPick();
        if (r && r.items) list.renderList(r.items);
      });
      if (pinBtn) pinBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!v2) return;
        const r = await v2.stashPanelPin(!state.pinned);
        if (r) { panel.applyMode({ mode: r.pinned ? 'open' : state.mode, pinned: !!r.pinned }); }
      });
    }

    return { bind };
  })();

  // ============================================================
  // [9] 初始化模块 —— 读设置 / 订阅主进程 / 首屏加载
  // ============================================================
  const init = (() => {
    const { root, dropHintEl } = state;

    async function boot() {
      // 跟随主窗口主题（浅色 / 深色）
      if (bridge && bridge.getSettings) {
        try {
          const s = await bridge.getSettings();
          if (s && s.appearance && s.appearance.theme === 'light') document.body.classList.add('theme-light');
          if (s && s.appearance && s.appearance.reduceMotion) root.classList.add('st--reduce-motion');
          // 读取华为式触发开关
          if (s && s.stash && s.stash.dragAutoShow === false) state.allowDragAutoShow = false;
        } catch (_e) {}
      }
      if (v2 && v2.stashPanelState) { try { panel.applyMode(await v2.stashPanelState()); } catch (_e) {} }
      if (v2 && v2.stashList) { try { const r = await v2.stashList(); if (r && r.items) list.renderList(r.items); } catch (_e) {} }
    }

    function bind() {
      // 订阅主进程事件
      if (v2 && v2.onStashPanelMode) v2.onStashPanelMode(panel.applyMode);
      if (v2 && v2.onStashChanged) v2.onStashChanged((d) => list.renderList(d && d.items));

      // hover 心跳（可选；主进程光标轮询仍是权威来源）
      root.addEventListener('mouseenter', () => { if (v2 && v2.stashPanelHover) v2.stashPanelHover(true); });
      root.addEventListener('mouseleave', () => { if (v2 && v2.stashPanelHover) v2.stashPanelHover(false); });

      // dropHint 仅作视觉提示层，不拦截事件
      if (dropHintEl) dropHintEl.style.pointerEvents = 'none';
    }

    return { boot, bind };
  })();

  // ============================================================
  // 启动：绑定各模块事件 + 初始化
  // ============================================================
  drag.bind();
  ctx.bind();
  head.bind();
  init.bind();
  init.boot();
})();