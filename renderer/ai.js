/* Mio · AI 助手窗口逻辑（v2.16）
 *
 * 这个文件只干三件事：
 *   1. 形态：把主进程算好的 mode/side 映射成 class（几何由主进程 setBounds 负责，见 main/ai/state.js）
 *   2. 执行流：消费主进程转发的 opencode SSE 事件，增量渲染「turn → 工具卡/正文/思维链」树
 *   3. 输入：Enter 执行 / ⇧Enter 换行 / Esc 收起 / ↑↓ 历史 / ⌘. 中止 / 运行时排队
 *
 * ⚠️ 渲染层永远拿不到引擎端口与密码 —— 一切走 window.mio.ai.* 的 IPC（docs/16 §7.3 安全铁律）。
 * ⚠️ 运行态（状态点）由主进程权威计算后推送，本文件不重复实现事件→状态的映射。
 */
(function () {
  'use strict';

  const api = (window.mio && window.mio.ai) || {};
  // 引擎事件载荷 → 语义 的纯映射层（见 renderer/aiEventMap.js，带单测）。
  // 这里绝不能就地写内联三元表达式猜字段名：形状读错不报错，只会静默退化成兜底文案。
  // 下面的兜底只为「资源漏注入时窗口别整个炸掉」；正常构建永远走不到，
  // 注入完整性由 test/aiCss.test.js 的 pack.sh / <script> 顺序两条守卫负责。
  const evmap = window.MioAiEventMap || (function () {
    console.error('[Mio] aiEventMap.js 未加载 —— ai.html 的 <script> 顺序或 pack.sh 注入有问题');
    return {
      sessionErrorMessage: (e) => (e && (e.message || (e.data && e.data.message))) || '',
      toolErrorMessage: (e, fb) => (e && e.message) || fb || '执行失败',
      engineStatusOf: (r) => ((r && r.status) ? r.status : (r || null)),
      contentText: (c) => (Array.isArray(c)
        ? c.map((x) => (x && (x.text || x.output)) || '').filter(Boolean).join('\n')
        : ''),
    };
  })();

  // ── DOM ────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const root = $('aiRoot');
  const elCapsule = $('aiCapsule');
  const elHead = $('aiHead');
  const elDot = $('aiDot');
  const elEngine = $('aiEngine');
  const elEngineText = $('aiEngineText');
  const elStream = $('aiStream');
  const elEmpty = $('aiEmpty');
  const elQueue = $('aiQueue');
  const elInput = $('aiInput');
  const elSend = $('aiSendBtn');
  const elStop = $('aiStopBtn');
  const elExpand = $('aiCollapseBtn');
  const elHide = $('aiHideBtn');
  const elNew = $('aiNewBtn');
  const elToast = $('aiToast');
  const elDrop = $('aiDropHint');

  // ── 状态 ───────────────────────────────────────────────────
  const S = {
    mode: 'capsule',
    side: 'right',
    run: 'idle',
    sessionID: '',
    turns: [],          // 已完成的 turn 模型
    cur: null,          // 当前进行中的 turn
    queue: [],          // 待发文本
    recent: [],         // 最近提交（↑↓ 浏览）
    histIdx: -1,
    draft: '',
    pinnedBottom: true, // 是否自动滚到底
    reduceMotion: false,
    // 会话闸门诊断（P2 加固）：把「静默丢弃事件」变成可观测数据。
    //   dropped          被闸门丢弃的事件总数
    //   lastDropType     最后一次被丢弃事件的 type（现场保留一条）
    //   lastDropSessionID 最后一次被丢弃事件携带的会话 id
    //   warned           是否已告警过（只 warn 一次，避免同一异常每帧刷屏）
    diag: { dropped: 0, lastDropType: '', lastDropSessionID: '', warned: false },
  };

  const MAX_TURNS = 40;   // 只在 DOM 里保留最近 40 轮，防长会话拖慢渲染

  // ══════════════════════════════════════════════════════════
  // 工具函数
  // ══════════════════════════════════════════════════════════
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /** 极简 Markdown 渲染（零依赖）。先抽围栏代码块 → 转义 → 行内 → 块级。 */
  function renderMarkdown(raw) {
    const text = String(raw == null ? '' : raw);
    const blocks = [];
    let s = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_, code) => {
      blocks.push('<pre><code>' + esc(code.replace(/\n+$/, '')) + '</code></pre>');
      return '\u0000' + (blocks.length - 1) + '\u0000';
    });
    s = esc(s);
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

    const out = [];
    let list = null;
    const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
    for (const line of s.split('\n')) {
      const t = line.trim();
      const ph = /^\u0000(\d+)\u0000$/.exec(t);
      if (ph) { closeList(); out.push(blocks[Number(ph[1])] || ''); continue; }
      if (!t) { closeList(); continue; }
      const h = /^(#{1,3})\s+(.*)$/.exec(t);
      if (h) { closeList(); out.push('<h' + h[1].length + '>' + h[2] + '</h' + h[1].length + '>'); continue; }
      const ul = /^[-*+]\s+(.*)$/.exec(t);
      if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + ul[1] + '</li>'); continue; }
      const ol = /^\d+[.)]\s+(.*)$/.exec(t);
      if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + ol[1] + '</li>'); continue; }
      closeList();
      out.push('<p>' + t + '</p>');
    }
    closeList();
    return out.join('');
  }

  function fmtDur(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return m + 'm' + String(s).padStart(2, '0') + 's';
  }

  function fmtTokens(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return '';
    return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v);
  }

  let toastTimer = 0;
  function toast(msg, ms) {
    if (!msg) return;
    elToast.textContent = msg;
    elToast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { elToast.hidden = true; }, ms || 2200);
  }

  // ══════════════════════════════════════════════════════════
  // 形态（几何由主进程负责，这里只管 class）
  // ══════════════════════════════════════════════════════════
  function setMode(mode, side) {
    const m = ['capsule', 'bar', 'open'].includes(mode) ? mode : 'capsule';
    S.mode = m;
    if (side) S.side = side;
    root.className = 'ai ai--' + m + (S.reduceMotion ? ' ai--reduce-motion' : '');
    root.dataset.mode = m;
    root.dataset.side = S.side;
    if (m === 'capsule') {
      elDrop.classList.remove('is-on');
      return;
    }
    // 从胶囊态出来时 shell 才刚变可见 —— 重算一次高度，别用隐藏期量到的值
    requestAnimationFrame(autoGrow);
    if (m === 'open') {
      updateEmpty();
      requestAnimationFrame(() => { if (S.pinnedBottom) scrollToBottom(); });
    }
  }

  function setRun(run) {
    const r = ['idle', 'running', 'waiting', 'error'].includes(run) ? run : 'idle';
    S.run = r;
    root.dataset.run = r;
    elStop.hidden = r !== 'running' && r !== 'waiting';
    elSend.disabled = r === 'running' && !elInput.value.trim();
    updateEmpty();
  }

  function updateEmpty() {
    elEmpty.classList.toggle('is-on', S.turns.length === 0 && !S.cur);
  }

  function scrollToBottom() {
    elStream.scrollTop = elStream.scrollHeight;
  }

  elStream.addEventListener('scroll', () => {
    const gap = elStream.scrollHeight - elStream.scrollTop - elStream.clientHeight;
    S.pinnedBottom = gap < 40;
  }, { passive: true });

  // ══════════════════════════════════════════════════════════
  // turn 模型
  // ══════════════════════════════════════════════════════════
  let turnSeq = 0;
  function makeTurn(intent) {
    turnSeq += 1;
    return {
      uid: 'turn-' + turnSeq,
      intent: String(intent || '').slice(0, 120),
      startedAt: Date.now(),
      endedAt: 0,
      state: 'running',   // running | done | error
      usage: null,        // { input, output, reasoning }
      error: '',
      order: [],          // part key 顺序
      parts: new Map(),   // key → { kind, data, el }
    };
  }

  /** 建立当前 turn 的 DOM 骨架（turn 头 + 体）。 */
  function mountTurn(turn) {
    const wrap = document.createElement('div');
    wrap.className = 'ai-turn';
    wrap.dataset.uid = turn.uid;

    const head = document.createElement('div');
    head.className = 'ai-turn-head';
    head.innerHTML =
      '<span class="ai-turn-intent"></span>' +
      '<span class="ai-turn-meta"></span>';
    head.querySelector('.ai-turn-intent').textContent = turn.intent || '（无标题）';
    wrap.appendChild(head);

    const body = document.createElement('div');
    body.className = 'ai-turn-body';
    wrap.appendChild(body);

    turn.el = wrap;
    turn.elHead = head;
    turn.elBody = body;
    turn.elMeta = head.querySelector('.ai-turn-meta');
    elStream.appendChild(wrap);
    updateEmpty();
    if (S.pinnedBottom) scrollToBottom();
    return wrap;
  }

  function patchTurnMeta(turn) {
    if (!turn.elMeta) return;
    const end = turn.endedAt || Date.now();
    const parts = [];
    if (turn.state !== 'running') parts.push(fmtDur(end - turn.startedAt));
    if (turn.usage) {
      const up = fmtTokens(turn.usage.input);
      const dn = fmtTokens(turn.usage.output);
      if (up) parts.push('↑' + up);
      if (dn) parts.push('↓' + dn);
    }
    turn.elMeta.textContent = parts.join(' · ');
  }

  /** 取（或建）某个 part 的容器节点，按到达顺序插入。 */
  function ensurePart(turn, key, kind) {
    let p = turn.parts.get(key);
    if (p) return p;
    const el = document.createElement('div');
    el.className = 'ai-part';
    p = { kind, data: {}, el };
    turn.parts.set(key, p);
    turn.order.push(key);
    turn.elBody.appendChild(el);
    return p;
  }

  // ── part：正文 ─────────────────────────────────────────────
  // ⚠️ 累积一律走 evmap.mergeTextDelta（快照 vs 增量），绝不就地做字符串拼接：
  //    真引擎会交错发 message.part.updated（全量快照）与 message.part.delta（增量），
  //    自己拼极易「快照落后于 delta → 丢字」或「快照 + delta 叠加 → 重复」（规则见 aiEventMap.js）。
  function accumulatePartText(turn, id, snapshotText, delta) {
    const p = ensurePart(turn, 'text:' + id, 'text');
    // ⚠️ p.data.id 是光标（.ai-caret）的判据（见 scheduleTextFlush）。
    //    原先只在 session.next.text.started 里赋值，而那个事件真机永不触发 → 光标永远不显示。
    p.data.id = id;
    const el = p.el;
    if (!el.classList.contains('ai-text')) { el.className = 'ai-part ai-text'; el.innerHTML = '<p></p>'; }
    p.data.buf = evmap.mergeTextDelta(p.data.buf, snapshotText, delta);
    p.data.dirty = true;
    scheduleTextFlush(turn, p);
  }
  /** 增量文本（message.part.delta / session.next.text.delta）。 */
  function partTextDelta(turn, id, delta) { accumulatePartText(turn, id, '', delta); }
  /** 全量快照文本（message.part.updated 的 text part）。 */
  function partTextSnapshot(turn, id, text) { accumulatePartText(turn, id, text, ''); }

  const flushQueueLocal = new Map();
  function scheduleTextFlush(turn, p) {
    if (flushQueueLocal.has(p)) return;
    const h = requestAnimationFrame(() => {
      flushQueueLocal.delete(p);
      if (!p.el.isConnected) return;
      p.data.dirty = false;
      p.el.innerHTML = renderMarkdown(p.data.buf);
      const caret = document.createElement('span');
      caret.className = 'ai-caret';
      if (turn.state === 'running' && turn.order[turn.order.length - 1] === 'text:' + p.data.id) {
        p.el.appendChild(caret);
      }
      if (S.pinnedBottom) scrollToBottom();
    });
    flushQueueLocal.set(p, h);
  }

  // ── part：思维链（默认收起） ────────────────────────────────
  // 真机上思维链也走 message.part.updated/reasoning + message.part.delta（field 仍是 'text'），
  // 所以这里的累积同样走 mergeTextDelta；调用方靠 partID→kind 映射把增量路由到这里。
  function accumulatePartReasoning(turn, id, snapshotText, delta) {
    const p = ensurePart(turn, 'rsn:' + id, 'reasoning');
    if (!p.el.classList.contains('ai-reasoning')) {
      p.el.className = 'ai-part ai-reasoning';
      p.el.innerHTML = '<div class="ai-reasoning-row"><span>▸</span><span>思考过程</span></div><div class="ai-reasoning-body"></div>';
      p.el.querySelector('.ai-reasoning-row').addEventListener('click', () => {
        p.el.classList.toggle('is-open');
        p.el.querySelector('.ai-reasoning-row span').textContent = p.el.classList.contains('is-open') ? '▾' : '▸';
      });
    }
    p.data.buf = evmap.mergeTextDelta(p.data.buf, snapshotText, delta);
    const body = p.el.querySelector('.ai-reasoning-body');
    if (body) body.textContent = p.data.buf;
  }
  /** 增量思维链（message.part.delta / session.next.reasoning.delta）。 */
  function reasoningDelta(turn, id, delta) { accumulatePartReasoning(turn, id, '', delta); }
  /** 全量快照思维链（message.part.updated 的 reasoning part）。 */
  function reasoningSnapshot(turn, id, text) { accumulatePartReasoning(turn, id, text, ''); }

  /** 把 token 用量写进 turn 并刷新头部 meta（session.next.step.ended 与 message.part.updated/step-finish 共用）。 */
  function applyTurnUsage(turn, usage) {
    const u = (usage && typeof usage === 'object') ? usage : {};
    const num = (v) => (Number(v) > 0 ? Number(v) : 0);
    turn.usage = { input: num(u.input), output: num(u.output), reasoning: num(u.reasoning) };
    patchTurnMeta(turn);
  }

  // ── part：工具卡（四态） ───────────────────────────────────
  const TOOL_ICON = { pending: '◌', running: '◌', ok: '✓', fail: '✕' };
  // 常见工具 → 中文动作（引擎给的是工具名，这里只做展示层翻译，未命中原样显示）
  const TOOL_LABEL = {
    bash: '执行命令', read: '读取', write: '写入', edit: '修改',
    glob: '查找文件', grep: '搜索内容', list: '列目录',
    webfetch: '抓取网页', websearch: '联网搜索', task: '子任务', todowrite: '更新任务',
  };

  function toolNode(turn, callID) {
    const p = ensurePart(turn, 'tool:' + callID, 'tool');
    if (!p.el.classList.contains('ai-tool')) {
      p.el.className = 'ai-part ai-tool is-pending';
      p.el.innerHTML =
        '<div class="ai-tool-row">' +
        '<span class="ai-tool-icon"></span>' +
        '<span class="ai-tool-name"></span>' +
        '<span class="ai-tool-flag"></span>' +
        '</div>' +
        '<div class="ai-tool-detail"></div>';
      p.el.querySelector('.ai-tool-row').addEventListener('click', () => p.el.classList.toggle('is-open'));
    }
    return p;
  }

  function toolSetState(p, state) {
    const cls = { pending: 'is-pending', running: 'is-running', ok: 'is-ok', fail: 'is-fail' }[state] || 'is-pending';
    p.el.classList.remove('is-pending', 'is-running', 'is-ok', 'is-fail');
    p.el.classList.add(cls);
    p.el.querySelector('.ai-tool-icon').textContent = TOOL_ICON[state] || '◌';
  }

  function toolSetName(p, toolName) {
    p.data.tool = toolName;
    const label = TOOL_LABEL[toolName] || toolName || '工具';
    p.el.querySelector('.ai-tool-name').textContent = label;
  }

  /** 用输入参数给工具卡补一句可读副标题（如 bash 的命令、read 的路径）。 */
  function toolDescribe(input) {
    if (!input || typeof input !== 'object') return '';
    const keys = ['command', 'filePath', 'path', 'pattern', 'query', 'url', 'description', 'prompt'];
    for (const k of keys) {
      const v = input[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  }

  function toolSetDetail(p, extra) {
    const detail = p.el.querySelector('.ai-tool-detail');
    if (!detail) return;
    const chunks = [];
    const desc = toolDescribe(p.data.input);
    if (desc) chunks.push('$ ' + desc);
    if (extra) chunks.push(extra);
    detail.textContent = chunks.join('\n\n');
  }

  function toolStarted(turn, callID, name) {
    const p = toolNode(turn, callID);
    toolSetName(p, name);
    toolSetState(p, 'running'); // 已经知道要调用 → 直接进入运行态（省掉一次无信息的 pending 闪烁）
    if (S.pinnedBottom) scrollToBottom();
  }

  function toolCalled(turn, callID, tool, input) {
    const p = toolNode(turn, callID);
    if (tool) toolSetName(p, tool);
    if (input && typeof input === 'object') p.data.input = input;
    toolSetState(p, 'running');
    p.data.startedAt = p.data.startedAt || Date.now();
    toolSetDetail(p, '');
    if (S.pinnedBottom) scrollToBottom();
  }

  function toolFinished(turn, callID, ok, payload) {
    const p = toolNode(turn, callID);
    toolSetState(p, ok ? 'ok' : 'fail');
    const ms = p.data.startedAt ? Date.now() - p.data.startedAt : 0;
    if (ms) p.el.querySelector('.ai-tool-flag').textContent = fmtDur(ms);
    let extra = '';
    if (ok) {
      const out = payload && (payload.output || payload.structured);
      if (typeof out === 'string') extra = out.slice(0, 4000);
      else if (out) extra = JSON.stringify(out, null, 2).slice(0, 4000);
    } else {
      let errText = (payload && (payload.error || payload.message)) || '执行失败';
      if (typeof errText !== 'string') errText = JSON.stringify(errText).slice(0, 2000);
      // ⚠️ 失败命令的 stdout/stderr 往往才是唯一有用的信息（为什么失败）—— 不能因为判定为失败就把它藏起来。
      const rawOut = payload && payload.output;
      let outText = '';
      if (typeof rawOut === 'string') outText = rawOut.slice(0, 4000);
      else if (rawOut) outText = JSON.stringify(rawOut, null, 2).slice(0, 4000);
      extra = outText ? (errText + '\n\n' + outText) : errText;
    }
    toolSetDetail(p, extra);
    if (S.pinnedBottom) scrollToBottom();
  }

  // ── part：卡（权限 / 提问） ────────────────────────────────
  function addPermissionCard(props) {
    const turn = S.cur || mountLooseTurn();
    const key = 'perm:' + (props.id || String(Date.now()));
    const p = ensurePart(turn, key, 'perm');
    const el = p.el;
    el.className = 'ai-part ai-perm ai-card';
    const cmd = String(props.metadata && (props.metadata.command || props.metadata.pattern) || props.permission || '');
    const pats = Array.isArray(props.patterns) ? props.patterns.join(' ') : '';
    el.innerHTML =
      '<div class="ai-card-head"><span>⚠</span><span>Mio 需要你确认一步操作</span></div>' +
      '<div class="ai-card-body">' +
      '<div class="ai-card-cmd"></div>' +
      '<div class="ai-card-note"></div>' +
      '</div>' +
      '<div class="ai-card-acts">' +
      '<button class="ai-btn ai-btn--primary" data-reply="once">允许一次</button>' +
      '<button class="ai-btn" data-reply="always">本会话总是允许</button>' +
      '<button class="ai-btn ai-btn--danger" data-reply="reject">拒绝</button>' +
      '</div>';
    el.querySelector('.ai-card-cmd').textContent = cmd || pats || String(props.permission || '');
    el.querySelector('.ai-card-note').textContent =
      '权限类型：' + String(props.permission || '未知') + (pats ? ' · 匹配：' + pats : '');
    el.querySelectorAll('[data-reply]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const reply = btn.dataset.reply;
        const r = await (api.permissionReply ? api.permissionReply({ requestID: props.id, reply }) : Promise.resolve({ ok: false }));
        if (!r || !r.ok) toast('回写失败，请重试');
        el.classList.add('is-answered');
        el.querySelector('.ai-card-head span:last-child').textContent = '已' + (reply === 'reject' ? '拒绝' : '允许');
      });
    });
    if (S.pinnedBottom) scrollToBottom();
  }

  function mountLooseTurn() {
    const t = makeTurn('（继续上一步）');
    S.cur = t;
    mountTurn(t);
    return t;
  }

  // ══════════════════════════════════════════════════════════
  // SSE 事件 → 执行流
  // ══════════════════════════════════════════════════════════
  function ensureCur() {
    if (!S.cur) S.cur = mountLooseTurn();
    return S.cur;
  }

  // message.part.delta 只带 partID、不带 kind —— 靠 message.part.updated 建立的映射回查。
  // ⚠️ 陷阱：delta 的 field 恒为 'text'（指「该 part 的 text 字段」），思维链 part 的增量
  //    也走 field:'text'，所以绝不能用 field 判断是不是正文，必须回查 partID → kind。
  const partKindById = new Map();
  function rememberPartKind(id, kind) {
    if (!id) return;
    if (partKindById.size > 500) partKindById.clear(); // 兜底：防长会话无界增长
    partKindById.set(id, kind);
  }

  // ⚠️ 用户自己那条消息也会以 message.part.updated/text 回推（真机实测，见报告），
  //    它的 messageID 就是 message.updated 里 role:'user' 的 info.id。
  //    用户消息在 submit() 时本地已画过（turn 头就是意图），这里必须按 messageID 跳过，
  //    否则正文区会把用户的提问再渲染一遍。
  const userMsgIDs = new Set();
  function rememberUserMsg(id) {
    if (!id) return;
    if (userMsgIDs.size > 200) userMsgIDs.clear();
    userMsgIDs.add(id);
  }

  /** message.part.updated 的单个全量快照 → 按 part.type 分派渲染。 */
  function handlePartUpdated(turn, part) {
    if (!part || typeof part !== 'object') return;
    if (part.messageID && userMsgIDs.has(part.messageID)) return; // 用户消息的 part，跳过
    const kind = evmap.partKindOf(part);
    rememberPartKind(part.id, kind); // 无论哪种 kind 都登记，供 delta 回查

    if (kind === 'text') {
      partTextSnapshot(turn, part.id, typeof part.text === 'string' ? part.text : '');
      return;
    }
    if (kind === 'reasoning') {
      reasoningSnapshot(turn, part.id, typeof part.text === 'string' ? part.text : '');
      return;
    }
    if (kind === 'tool') {
      const st = evmap.toolStateOf(part);
      const key = st.callID || part.id; // 真机 part.callID 稳定；兜底用 part.id
      if (!key) return;
      // 同一个 part.id/callID 会来多次（status 递进）→ 原地更新同一张卡，不新建
      if (st.status === 'pending') toolStarted(turn, key, st.tool);
      else if (st.status === 'running') toolCalled(turn, key, st.tool, st.input);
      else if (st.status === 'completed') {
        // ⚠️ 不能直接认为 completed == 成功：真机实测非 0 退出时 status 仍是 'completed'，
        //    唯一失败信号是 metadata.exit（见 aiEventMap.toolStateOf 的 ok / 注释）。
        // ⚠️ 失败文案刻意写「命令退出码 N」而非「执行失败」：grep 无匹配会 exit 1、diff 有差异也会
        //    exit 1 —— Agent 正常探索时天天产生非 0 退出，把它们一律喊成「失败/崩溃」会制造假警报，
        //    让人不再信任红灯。如实报退出码，既不把失败画成成功，也不狼来了。
        toolFinished(turn, key, st.ok, {
          output: st.output,
          structured: st.title,
          error: st.ok ? '' : ('命令退出码 ' + st.exit),
        });
      } else if (st.status === 'error') {
        toolFinished(turn, key, false, { error: st.error || '执行失败', output: st.output });
      }
      return;
    }
    if (kind === 'step') {
      if (part.type === 'step-finish') applyTurnUsage(turn, evmap.stepUsageOf(part));
      // step-start：仅标记本步开始，当前 UI 无对应节点 → 忽略
    }
  }

  // ⚠️ 事件族（真机实测 opencode serve 1.17.9，GET /global/event，2026-09）：
  //   本机引擎**只**用 message.part.* 发正文 / 思维链 / 工具 / 用量：
  //     · message.part.updated  全量快照（part.type ∈ text | reasoning | tool | step-start | step-finish）
  //     · message.part.delta    { partID, field:'text', delta }（field 恒为 text，但可能是思维链）
  //     · message.updated       含 role:'user' 的回显（本地已画 → 必须忽略）
  //     · session.status / session.idle / session.diff
  //   session.next.* 家族**只**出现 agent.switched / model.switched，session.next.text.delta
  //   一次都没出现 —— 渲染层若只认它，正文区会永远空白（这就是 P1 那个「只转圈、不出字」的 bug）。
  //   下面保留 session.next.* 分支（引擎在演进，成本为零），但真机主路径是 message.part.*。
  function onEvent(evt) {
    if (!evt || typeof evt.type !== 'string') return;
    const type = evt.type;
    const p = evt.properties || {};

    // 会话过滤：只渲染当前会话，但权限/提问是「必须让我看到」的，任何会话都放行。
    // 判断逻辑抽到 aiEventMap.sessionGate（纯函数、可单测）；这里只做「副作用」：
    //   'global' / 'pass' → 继续处理
    //   'adopt'           → 锚定当前会话
    //   'discard'         → 计数 + 首次告警后丢弃（静默丢弃最坑，留一条可观测线索）
    const gate = evmap.sessionGate(type, p.sessionID, S.sessionID);
    if (gate === 'discard') {
      S.diag.dropped += 1;
      S.diag.lastDropType = type;
      S.diag.lastDropSessionID = p.sessionID;
      if (!S.diag.warned) {
        S.diag.warned = true;
        console.warn('[mio-ai] 会话闸门丢弃了非当前会话的事件', {
          type,
          eventSessionID: p.sessionID,
          curSessionID: S.sessionID,
        });
      }
      return;
    }
    if (gate === 'adopt') S.sessionID = p.sessionID;

    switch (type) {
      // ── 真机主路径：message.part.* ──────────────────────────
      case 'message.part.updated':
        handlePartUpdated(ensureCur(), p.part);
        break;

      case 'message.part.delta': {
        if (p.field !== 'text') break;        // 只处理 text 字段的增量
        const id = p.partID;
        if (!id) break;
        if (p.messageID && userMsgIDs.has(p.messageID)) break; // 用户消息的增量，跳过
        const turn = ensureCur();
        // 回查 kind：思维链 part 的增量也标 field:'text'，必须靠映射表区分（见 partKindById 注释）
        const kind = partKindById.get(id) || 'text'; // 未登记则按正文兜底（宁可显示也别静默吞掉）
        if (kind === 'reasoning') reasoningDelta(turn, id, String(p.delta || ''));
        else partTextDelta(turn, id, String(p.delta || ''));
        break;
      }

      case 'message.updated': {
        // 记下用户消息 id —— 它的 text part 也会经 message.part.updated 回推，必须据此跳过，
        // 否则用户提问会被重复渲染一遍（本地 submit() 时已画过）。
        const info = p.info;
        if (info && typeof info === 'object' && info.role === 'user') rememberUserMsg(info.id);
        // assistant 的增量正文走 message.part.*，这里无需额外渲染。
        break;
      }

      case 'session.status':
        // 运行态由主进程权威计算后经 ai-run 推送，渲染层不重复实现（见 state.js deriveRunState）。
        break;

      case 'session.diff':
        // diff 目前无对应 UI 节点，保留分支以备后用。
        break;

      // ── 兼容分支：session.next.*（真机 1.17.9 不发文本，仅在引擎演进时兜底）──
      case 'session.next.text.delta':
        partTextDelta(ensureCur(), p.textID || 't0', String(p.delta || ''));
        break;

      case 'session.next.text.started': {
        const turn = ensureCur();
        const key = 'text:' + (p.textID || 't0');
        const part = ensurePart(turn, key, 'text');
        part.data.id = p.textID || 't0';
        break;
      }

      case 'session.next.reasoning.delta':
        reasoningDelta(ensureCur(), p.reasoningID || 'r0', String(p.delta || ''));
        break;

      case 'session.next.tool.input.started':
        toolStarted(ensureCur(), p.callID, p.name);
        break;

      case 'session.next.tool.called':
        toolCalled(ensureCur(), p.callID, p.tool, p.input);
        break;

      case 'session.next.tool.progress':
        // 进展事件：目前无需额外渲染（工具卡已是 running），保留分支以备细化
        break;

      case 'session.next.tool.success': {
        const textOut = evmap.contentText(p.content);
        toolFinished(ensureCur(), p.callID, true, { output: textOut || p.structured, structured: p.structured });
        break;
      }

      case 'session.next.tool.failed': {
        const textOut = evmap.contentText(p.content);
        // ⚠️ 注意 tool.failed 的 error 形状与 session.error 的**不同**（见 aiEventMap.js 文件头）
        toolFinished(ensureCur(), p.callID, false, {
          error: evmap.toolErrorMessage(p.error, textOut),
          structured: p.result,
        });
        break;
      }

      case 'session.next.step.ended': {
        // 与 message.part.updated/step-finish 共用同一套用量提取（别复制粘贴）
        applyTurnUsage(ensureCur(), p.tokens);
        break;
      }

      case 'session.idle': {
        const t = S.cur;
        if (t) {
          t.state = 'done';
          t.endedAt = Date.now();
          t.parts.forEach((pr) => {
            const c = pr.el && pr.el.querySelector && pr.el.querySelector('.ai-caret');
            if (c) c.remove();
          });
          patchTurnMeta(t);
          S.turns.push(t);
          S.cur = null;
          if (S.turns.length > MAX_TURNS) {
            const drop = S.turns.splice(0, S.turns.length - MAX_TURNS);
            drop.forEach((d) => d.el && d.el.remove());
          }
        }
        flushQueue();
        break;
      }

      case 'session.error': {
        const t = ensureCur();
        // ⚠️ 真机实测（不是猜）：session.error.properties.error 是「带 name + data 的判别联合」，
        //    真正的人类可读文本藏在 e.data.message，例如 { name:'APIError',
        //    data:{ message:'invalid model: model name not found', statusCode:400 } }。
        //    e.message 这个键**根本不存在** —— 只读 e.message 会让用户永远只看到兜底文案
        //    「引擎返回了错误」，而真正能救命的那句（模型名不对 / 鉴权失败）被吞掉，无从排查。
        //    提取逻辑已抽到 aiEventMap.js 并单测。
        showError(t, evmap.sessionErrorMessage(p.error) || '引擎返回了错误');
        break;
      }

      case 'permission.asked':
        addPermissionCard(p);
        break;

      case 'question.asked':
        addQuestionCard(p);
        break;

      default:
        break;
    }
  }

  function addQuestionCard(props) {
    const turn = ensureCur();
    const key = 'q:' + (props.id || String(Date.now()));
    const p = ensurePart(turn, key, 'question');
    const el = p.el;
    el.className = 'ai-part ai-question ai-card';
    const questions = Array.isArray(props.questions) ? props.questions : (props.question ? [props.question] : []);
    const qtext = questions.map((q) => (typeof q === 'string' ? q : (q && (q.question || q.text)) || '')).filter(Boolean).join('\n');
    el.innerHTML =
      '<div class="ai-card-head"><span>?</span><span>Agent 有个问题想问你</span></div>' +
      '<div class="ai-card-body"><div class="ai-card-cmd"></div></div>' +
      '<div class="ai-card-acts">' +
      '<button class="ai-btn ai-btn--primary" data-reply="ok">知道了</button>' +
      '</div>';
    el.querySelector('.ai-card-cmd').textContent = qtext || '（需要你的决定）';
    el.querySelector('[data-reply]').addEventListener('click', async () => {
      await (api.questionReply ? api.questionReply({ requestID: props.id, reply: '' }) : Promise.resolve());
      el.classList.add('is-answered');
    });
    if (S.pinnedBottom) scrollToBottom();
  }

  function showError(turn, msg) {
    const p = ensurePart(turn, 'err:' + Date.now(), 'error');
    p.el.className = 'ai-part ai-error';
    p.el.innerHTML =
      '<div class="ai-error-title">出错了</div>' +
      '<div class="ai-error-msg"></div>' +
      '<div class="ai-error-acts"><button class="ai-btn" data-act="retry">重试</button></div>';
    p.el.querySelector('.ai-error-msg').textContent = msg;
    p.el.querySelector('[data-act="retry"]').addEventListener('click', () => {
      const last = S.recent[0];
      if (last) submit(last);
      else toast('没有可重试的指令');
    });
    turn.state = 'error';
    turn.endedAt = Date.now();
    patchTurnMeta(turn);
    if (S.pinnedBottom) scrollToBottom();
  }

  // ══════════════════════════════════════════════════════════
  // 发送 / 中止 / 排队
  // ══════════════════════════════════════════════════════════
  let pendingFiles = []; // 拖进来的文件（路径由 preload 的 getPathForFile 取）

  async function submit(text, parts) {
    const t = String(text == null ? '' : text).trim();
    if (!t && !(parts && parts.length)) return;

    if (S.run === 'running' || S.run === 'waiting') {
      // §5.2 默认排队：想到一句就补一句，当前 turn 结束后自动发出
      S.queue.push({ text: t, parts });
      renderQueue();
      return;
    }

    const turn = makeTurn(t || '（文件）');
    S.cur = turn;
    mountTurn(turn);
    setRun('running');
    pushRecent(t);
    if (S.mode !== 'open') api.windowExpand && api.windowExpand();

    const body = { text: t, parts: parts || [] };
    const r = await (api.send ? api.send(body) : Promise.resolve({ ok: false, error: '桥接未就绪' }));
    if (!r || !r.ok) {
      showError(turn, (r && r.error) || '发送失败');
      setRun('error');
      S.cur = null;
      return;
    }
    if (r.sessionID) S.sessionID = r.sessionID;
    setRun('running');
  }

  function flushQueue() {
    if (!S.queue.length) { renderQueue(); setRun('idle'); return; }
    const next = S.queue.shift();
    renderQueue();
    submit(next.text, next.parts);
  }

  function renderQueue() {
    if (!S.queue.length) { elQueue.hidden = true; elQueue.innerHTML = ''; return; }
    elQueue.hidden = false;
    elQueue.innerHTML = '<span class="ai-queue-text"></span><span class="ai-queue-cancel">点此取消</span>';
    elQueue.querySelector('.ai-queue-text').textContent = S.queue.length + ' 条待发 · ' + (S.queue[0].text || '').slice(0, 24);
    elQueue.querySelector('.ai-queue-cancel').addEventListener('click', () => {
      S.queue = [];
      renderQueue();
    });
  }

  function pushRecent(text) {
    const t = String(text || '').trim();
    if (!t) return;
    S.recent = [t].concat(S.recent.filter((x) => x !== t)).slice(0, 50);
    S.histIdx = -1;
    if (api.pushRecent) api.pushRecent(t);
  }

  async function abort() {
    if (S.run !== 'running' && S.run !== 'waiting') return;
    const r = await (api.abort ? api.abort() : Promise.resolve({ ok: false }));
    if (!r || !r.ok) toast('中止失败');
    else toast('已中止');
  }

  // ══════════════════════════════════════════════════════════
  // 输入框行为
  // ══════════════════════════════════════════════════════════
  function autoGrow() {
    // ⚠️ 下限 1 行（20px）：胶囊态下 .ai-shell 是 display:none，此时量 scrollHeight 得 0，
    //    写回内联 height:0px 就会被钉死 —— 用户切到输入条态看到的是一个没有 placeholder 的空药丸。
    //    CSS 侧也有 min-height 兜底，两处都要有（这里还能正确处理「量在隐藏期」的时序问题）。
    const LINE = 20;
    elInput.style.height = 'auto';
    elInput.style.height = Math.min(100, Math.max(LINE, elInput.scrollHeight || 0)) + 'px';
  }

  elInput.addEventListener('input', () => {
    autoGrow();
    S.histIdx = -1;
    elSend.disabled = !elInput.value.trim() && S.run === 'running';
  });

  elInput.addEventListener('keydown', (e) => {
    const composing = e.isComposing || e.keyCode === 229;
    if (composing) return; // 中文输入法组字中，绝不当成提交

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = elInput.value;
      if (!text.trim() && !pendingFiles.length) return;
      const parts = takePendingFiles();
      elInput.value = '';
      autoGrow();
      submit(text, parts);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      escapeStep();
      return;
    }

    if (e.key === 'ArrowUp' && !elInput.value.includes('\n')) {
      if (S.histIdx + 1 < S.recent.length) {
        e.preventDefault();
        if (S.histIdx === -1) S.draft = elInput.value;
        S.histIdx += 1;
        elInput.value = S.recent[S.histIdx] || '';
        autoGrow();
      }
      return;
    }

    if (e.key === 'ArrowDown' && S.histIdx >= 0) {
      e.preventDefault();
      S.histIdx -= 1;
      elInput.value = S.histIdx === -1 ? S.draft : (S.recent[S.histIdx] || '');
      autoGrow();
      return;
    }

    // ⌘. / Ctrl+. → 中止
    if ((e.metaKey || e.ctrlKey) && e.key === '.') {
      e.preventDefault();
      abort();
    }
  });

  /** Esc 的两段语义（§13 Q3）：面板 → 输入条 → 收起 */
  function escapeStep() {
    if (S.mode === 'open') api.windowCollapse && api.windowCollapse();
    else api.windowHide && api.windowHide();
  }

  elSend.addEventListener('click', () => {
    if (S.mode !== 'open' && S.mode !== 'bar') return;
    const text = elInput.value;
    if (!text.trim() && !pendingFiles.length) return;
    const parts = takePendingFiles();
    elInput.value = '';
    autoGrow();
    submit(text, parts);
  });
  elStop.addEventListener('click', abort);
  elExpand.addEventListener('click', () => api.windowExpand && api.windowExpand());
  elHide.addEventListener('click', () => api.windowHide && api.windowHide());
  elNew.addEventListener('click', async () => {
    const r = await (api.newSession ? api.newSession() : Promise.resolve({ ok: false }));
    if (r && r.ok) {
      S.sessionID = r.sessionID || '';
      S.turns.forEach((t) => t.el && t.el.remove());
      S.turns = [];
      S.cur = null;
      partKindById.clear(); // 新会话：part/id 映射与用户消息 id 都作废
      userMsgIDs.clear();
      updateEmpty();
      toast('已开新会话');
    }
  });

  elCapsule.addEventListener('click', () => api.windowShow ? api.windowShow() : (api.windowExpand && api.windowExpand()));

  // ══════════════════════════════════════════════════════════
  // 拖文件进来（P3 的入口，先把渲染层行为接上）
  // ══════════════════════════════════════════════════════════
  function takePendingFiles() {
    if (!pendingFiles.length) return [];
    const parts = pendingFiles.map((f) => ({ type: 'file', mime: f.mime || 'application/octet-stream', url: 'file://' + f.path, filename: f.name }));
    pendingFiles = [];
    renderPendingFiles();
    return parts;
  }

  function renderPendingFiles() {
    // 只更新提示文案，不额外造 UI 节点（P3 再做完整的附件胶囊）
  }

  window.addEventListener('dragover', (e) => { e.preventDefault(); root.classList.add('ai--dropping'); });
  window.addEventListener('dragleave', (e) => {
    if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
      root.classList.remove('ai--dropping');
    }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    root.classList.remove('ai--dropping');
    const dt = e.dataTransfer;
    if (!dt) return;
    const files = Array.from(dt.files || []);
    if (files.length) {
      const getPath = window.getPathForFile || (() => '');
      pendingFiles = files.map((f) => ({ path: getPath(f), name: f.name, mime: f.type })).filter((f) => f.path);
      if (pendingFiles.length) {
        if (S.mode !== 'open') api.windowExpand && api.windowExpand();
        if (!elInput.value) elInput.value = '这个文件 ';
        elInput.focus();
        toast('已附带 ' + pendingFiles.length + ' 个文件');
      }
      return;
    }
    const text = dt.getData && dt.getData('text/plain');
    if (text) {
      elInput.value = (elInput.value ? elInput.value + ' ' : '') + text;
      autoGrow();
      if (S.mode === 'capsule') api.windowShow && api.windowShow();
      elInput.focus();
    }
  });

  // ══════════════════════════════════════════════════════════
  // 引擎状态
  // ══════════════════════════════════════════════════════════
  function renderEngine(st) {
    if (!st) return;
    S.engine = st;
    let cls = 'ai-engine';
    let text = '未连接';
    if (st.running) { cls += ' is-run'; text = '引擎 ' + (st.version || '运行中'); }
    else if (st.available === false) { cls += ' is-bad'; text = '未检测到引擎'; }
    else if (st.error) { cls += ' is-bad'; text = String(st.error).slice(0, 22); }
    else if (st.version) { cls += ' is-ok'; text = '引擎 ' + st.version + '（待机）'; }
    elEngine.className = cls;
    elEngineText.textContent = text;
    elEngine.title = [st.path, st.error].filter(Boolean).join('\n') || text;
  }

  async function refreshEngine() {
    if (!api.engineStatus) return;
    try {
      const r = await api.engineStatus();
      if (r && r.ok === false) return;
      renderEngine(evmap.engineStatusOf(r));
    } catch {
      renderEngine({ available: false, running: false });
    }
  }

  // ══════════════════════════════════════════════════════════
  // 诊断出口（P2 加固）
  // ══════════════════════════════════════════════════════════
  // 只读快照函数（不是活的 S 引用）—— contextIsolation 下页面全局只能经
  // webContents.executeJavaScript 读取，供 e2e / 现网排查用。
  // 只暴露 diag + sessionID + mode + run，**绝不**含引擎端口/密码等敏感信息。
  window.__mioAiDiag = () => ({
    ...S.diag,
    sessionID: S.sessionID,
    mode: S.mode,
    run: S.run,
  });

  // ══════════════════════════════════════════════════════════
  // 启动
  // ══════════════════════════════════════════════════════════
  async function boot() {
    if (api.onMode) api.onMode((d) => setMode(d && d.mode, d && d.side));
    if (api.onEvent) api.onEvent((d) => onEvent(d));
    if (api.onStatus) api.onStatus((d) => renderEngine(d));

    // 减弱动效
    try {
      if (window.mio && window.mio.getSettings) {
        const s = await window.mio.getSettings();
        if (s && s.appearance && s.appearance.reduceMotion) S.reduceMotion = true;
      }
    } catch {}

    // 最近提交（↑ 历史）
    if (api.recent) {
      try {
        const r = await api.recent();
        if (r && Array.isArray(r.recent)) S.recent = r.recent.slice(0, 50);
      } catch {}
    }

    refreshEngine();
    setRun('idle');
    setMode('capsule');
    autoGrow();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
