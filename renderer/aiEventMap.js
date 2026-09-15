/* Mio · AI 助手：引擎事件载荷 → 语义 的纯映射层（v2.16）
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────────
 * opencode 的事件载荷形状**不统一**，而且是只有跑到真引擎上才知道的那种不统一：
 *
 *   · session.error.properties.error
 *       = { name:'APIError', data:{ message:'invalid model: model name not found',
 *                                   statusCode:400, isRetryable:false, … } }
 *       → 人类可读文本在 data.message，**没有**顶层 message（additionalProperties:false）
 *
 *   · session.next.tool.failed.properties.error
 *       = { type:'unknown', message:'…' }        （SessionErrorUnknown）
 *       → 人类可读文本就在顶层 message
 *
 * 两种形状同时出现在同一条事件流里。这类字段读错的代价特别隐蔽：不抛异常、不报错，
 * 只是静默退化成一句兜底文案 —— 而恰好被吞掉的那句才是用户唯一能据以自救的信息。
 * 真机实测就是这么翻的：用户只看到「引擎返回了错误」，真正的原因
 * 「invalid model: model name not found」被吃掉，完全无从排查。
 *
 * 所以把这些形状差异集中到这里，用单测钉死；不要在 ai.js 里写内联三元表达式靠猜。
 *
 * ⚠️ 本文件必须保持零 DOM、零副作用：
 *    既被 renderer/ai.html 以 <script> 加载（挂全局 MioAiEventMap），
 *    也被 node --test 直接 require。两边形状必须一致。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MioAiEventMap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 只认「非空白字符串」，其余（数字/null/undefined/空串）一律算没拿到。 */
  function s(v) {
    return (typeof v === 'string' && v.trim()) ? v.trim() : '';
  }

  /**
   * session.error 的 properties.error → 人类可读文本。
   * 依次尝试：顶层 message → 判别联合的 data.message → data.name → type → name → ''。
   * @returns {string} 取不到时返回 ''，由调用方决定兜底文案
   */
  function sessionErrorMessage(err) {
    if (typeof err === 'string') return s(err);
    if (!err || typeof err !== 'object') return '';
    const d = (err.data && typeof err.data === 'object') ? err.data : null;
    return s(err.message)
      || (d ? s(d.message) : '')
      || (d ? s(d.name) : '')
      || s(err.type)
      || s(err.name)
      || '';
  }

  /**
   * session.next.tool.failed 的 properties.error → 人类可读文本。
   * 形状与 sessionErrorMessage **不同**（见文件头），但同样兜住 data.message 以防引擎换形状。
   * @param {*} err
   * @param {string} [fallbackText] 工具输出里的文本（引擎常把失败原因塞在 content 里）
   * @returns {string} 永不为空 —— 兜底为 '执行失败'
   */
  function toolErrorMessage(err, fallbackText) {
    const direct = (typeof err === 'string') ? s(err) : '';
    if (direct) return direct;
    const fromErr = sessionErrorMessage(err);
    return fromErr || s(fallbackText) || '执行失败';
  }

  /**
   * 把 ai-engine-status 的返回归一成裸状态对象。
   * 主进程给 { ok, status:{…} }；纯浏览器预览的 mock 直接给裸对象甚至 { available:false }。
   * @returns {object|null} 拿不到对象时返回 null
   */
  function engineStatusOf(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const inner = (raw.status && typeof raw.status === 'object') ? raw.status : raw;
    return (inner && typeof inner === 'object') ? inner : null;
  }

  /** 工具成功/失败事件里 content[] → 拼接文本（引擎两种键名都用过）。 */
  function contentText(content) {
    if (!Array.isArray(content)) return '';
    return content
      .map((c) => s(c && (c.text || c.output)))
      .filter(Boolean)
      .join('\n');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // message.part.* 家族（opencode serve 1.17.9 真机实测）
  //
  // 本机引擎**不走** session.next.text.delta 那一族：正文 / 思维链 / 工具 / 用量
  // 全部走 message.part.updated（全量快照）与 message.part.delta（增量）。
  // 这些函数把 part 形状归一，供 ai.js 分派 —— 形状读错不报错、只会静默空白，
  // 所以一律在这里用单测钉死。
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * part.type → 语义类别。
   * @param {{type?:string}} part
   * @returns {'text'|'reasoning'|'tool'|'step'|'other'}
   */
  function partKindOf(part) {
    const t = (part && typeof part === 'object') ? part.type : '';
    if (t === 'text') return 'text';
    if (t === 'reasoning') return 'reasoning';
    if (t === 'tool') return 'tool';
    if (t === 'step-start' || t === 'step-finish') return 'step';
    return 'other';
  }

  const TOOL_STATUSES = ['pending', 'running', 'completed', 'error'];

  /**
   * tool part → 渲染需要的字段。`state` 缺失/脏一律安全默认，**永不抛**。
   * 真机 message.part.updated/tool 对同一个 part.id 会来 5 次（status 从 pending 往后推进），
   * 调用方靠 callID 原地更新同一张卡。
   *
   * ⚠️ 真机实测（opencode serve 1.17.9）：**命令非 0 退出时 `status` 仍是 `'completed'`**，
   *    全程不出现 `'error'`、也不出现 `session.error` —— 唯一失败信号就是 `state.metadata.exit`。
   *    所以判断「成功/失败」必须看 `ok`（本函数算好），不能只看 `status==='completed'`；
   *    否则一条 `exit 3` 的失败命令会被画成绿色 ✓（失败画成成功）。不写下来，下一个必再踩。
   * @returns {{callID:string, tool:string, status:'pending'|'running'|'completed'|'error',
   *            input:object|null, output:*, error:*, title:string, exit:number|null, ok:boolean}}
   */
  function toolStateOf(part) {
    const p = (part && typeof part === 'object') ? part : {};
    const st = (p.state && typeof p.state === 'object') ? p.state : {};
    // exit：只有 bash 类工具有 state.metadata.exit；read / grep / glob 等没有 → null。
    // 只有「有限数字」或「非空数字字符串」才算数；其余脏值（null / undefined / '' / 'abc' / NaN /
    // 对象 / 数组）一律归一为 null —— 注意 Number([]) === 0，若不显式排除数组会被误当成「退出码 0」。
    const rawExit = (st.metadata && typeof st.metadata === 'object') ? st.metadata.exit : undefined;
    const exitNum = (typeof rawExit === 'number') ? rawExit
      : (typeof rawExit === 'string' && rawExit.trim() !== '' ? Number(rawExit) : NaN);
    const exit = Number.isFinite(exitNum) ? exitNum : null;
    return {
      callID: s(p.callID) || s(st.callID) || '',
      tool: s(p.tool) || '',
      status: TOOL_STATUSES.includes(st.status) ? st.status : 'pending',
      input: (st.input && typeof st.input === 'object') ? st.input : null,
      output: (st.output === undefined || st.output === null) ? '' : st.output,
      error: (st.error === undefined || st.error === null) ? '' : st.error,
      title: s(st.title) || s(p.title) || '',
      exit,
      // ok：completed 且退出码 ≤ 0 或取不到 → true；
      //     status==='error' / pending / running（未定型）→ false。
      //     调用方只在 completed / error 两态才用它。
      ok: st.status === 'completed' && !(exit > 0),
    };
  }

  /**
   * step-finish part → token 用量与成本（脏值收敛为 0）。
   * @returns {{input:number, output:number, reasoning:number, cost:number}}
   */
  function stepUsageOf(part) {
    const p = (part && typeof part === 'object') ? part : {};
    const tk = (p.tokens && typeof p.tokens === 'object') ? p.tokens : {};
    const num = (v) => (Number(v) > 0 ? Number(v) : 0);
    return {
      input: num(tk.input),
      output: num(tk.output),
      reasoning: num(tk.reasoning),
      cost: num(p.cost),
    };
  }

  /**
   * 合并「累积文本 / 权威快照 / 增量」。
   *
   * 真机上这两个来源会交错到达，顺序无保证：
   *   · message.part.delta   → 只有 delta（snapshotText 传 ''）
   *   · message.part.updated → 只有 snapshotText（delta 传 ''）
   * 规则（既防丢字，也防重复）：
   *   1) delta 非空 → 追加到累计值；
   *   2) 快照是权威值 —— 当它比「追加后的累计值」**长**时整体采用它。
   *      与追加后的值比较，才能既不被落后的快照截断（丢字），也不把快照与
   *      delta 首尾叠加成重复文本。
   * 任一侧非字符串 / 为空都安全降级（视为 ''）。
   * @param {string} accumulated
   * @param {string} snapshotText
   * @param {string} delta
   * @returns {string}
   */
  function mergeTextDelta(accumulated, snapshotText, delta) {
    let base = (typeof accumulated === 'string') ? accumulated : '';
    const d = (typeof delta === 'string') ? delta : '';
    if (d) base += d;
    const snap = (typeof snapshotText === 'string') ? snapshotText : '';
    if (snap.length > base.length) base = snap;
    return base;
  }

  /**
   * 会话闸门：决定一条事件该放行 / 锚定会话 / 丢弃。
   *
   * 真机 GET /global/event 是**全局**事件流：同一条连接里可能混进别的会话的事件
   * （并发终端、旧会话回推）。渲染层只能画当前会话，否则正文串台。
   * 但有两类「全局卡片」任何会话都必须放行 —— 否则用户永远看不到权限/提问，界面静默卡死：
   *   permission.*  /  question.*
   *
   * 把这段判断从 ai.js 抽到这里，是为了让「丢弃」这个**静默**行为可被单测钉死：
   * sessionID 判断错，代价同样是静默的（该显示的不显示、不该显示的串台），真机极难查。
   *
   * present = 「非空字符串」；其余（undefined / null / 数字 / 布尔 / 对象 / 数组 / 空串）
   * 一律视为缺席。用严格类型判断而非 truthiness 强转，避免 Number([])===0 之类的坑；
   * 且入参脏/缺失时**永不抛**。
   *
   * 真值表：
   *   ┌──────────┬──────────┬───────────┬───────────┐
   *   │ 全局卡片 │ 事件会话 │ 当前会话  │ 结果      │
   *   ├──────────┼──────────┼───────────┼───────────┤
   *   │ 是       │  任意    │  任意     │ 'global'  │
   *   │ 否       │ present  │  缺席     │ 'adopt'   │
   *   │ 否       │ present  │  = 事件   │ 'pass'    │
   *   │ 否       │ present  │  ≠ 事件   │ 'discard' │
   *   │ 否       │  缺席    │  任意     │ 'pass'    │
   *   └──────────┴──────────┴───────────┴───────────┘
   *
   * @param {*} type 事件类型（非字符串按 '' 处理）
   * @param {*} evtSessionID 事件自身携带的会话 id
   * @param {*} curSessionID 渲染层当前锚定的会话 id
   * @returns {'global'|'adopt'|'pass'|'discard'}
   */
  function sessionGate(type, evtSessionID, curSessionID) {
    const t = (typeof type === 'string') ? type : '';
    if (t.startsWith('permission.') || t.startsWith('question.')) return 'global';
    const evt = s(evtSessionID);   // s() 已归一：非字符串 / 空串 → ''
    if (!evt) return 'pass';       // 事件没带会话 → 不拦截
    const cur = s(curSessionID);
    if (!cur) return 'adopt';      // 当前还没锚定会话 → 采纳本事件
    return (evt === cur) ? 'pass' : 'discard';
  }

  return {
    sessionErrorMessage,
    toolErrorMessage,
    engineStatusOf,
    contentText,
    partKindOf,
    toolStateOf,
    stepUsageOf,
    mergeTextDelta,
    sessionGate,
  };
});
