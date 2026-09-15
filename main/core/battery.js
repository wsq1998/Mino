// Mio - 核心层：电量提醒档位判定 + 去重状态机（纯函数，零副作用）
// v2.0 F1 优化：把「三档提醒 + 各档独立去重」从 main.js 抽成可单测纯函数。
//
// 三档（互相独立，离开档位即重置 —— 再次进入可再次提醒）：
//   - low      : 电量 <= low  且未充电 → 提醒充电
//   - full     : 电量 >= full 且充电中 → 提醒可拔电（刚跨过满电阈值）
//   - charged  : 电量 >= 100  且充电中 → 再次提醒拔电（真正充满）
//
// full 与 charged 是「充电过程中先后发生的两个独立事件」：先到 full 提醒一次，
// 继续充到 100% 再提醒一次。两档各有独立去重，互不吞并。
//
// 判定优先级（充电中时按电量取最高档）：
//   充电中：pct >= 100 → 'charged'；pct >= full → 'full'；否则 → null
//   未充电：pct <= low  → 'low'    ；否则           → null
//
// 依赖：无（不 require electron），可被 `node --test` 直接加载。

const LOW_LEVEL = 'low';
const FULL_LEVEL = 'full';
const CHARGED_LEVEL = 'charged';

// 归一化输入：电量夹到 0–100 整数；阈值非数字时回退业务默认（low=20 / full=80）。
function normalize(pct, low, full) {
  const p = Number(pct);
  const lo = Number(low);
  const fu = Number(full);
  return {
    pct: Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : 0,
    low: Number.isFinite(lo) ? lo : 20,
    full: Number.isFinite(fu) ? fu : 80,
  };
}

// 当前应处的提醒档位（可能为 null）。纯函数，不读任何外部状态。
// 入参：{ pct, charging, low, full }
function currentLevel({ pct, charging, low, full } = {}) {
  const n = normalize(pct, low, full);
  if (charging) {
    if (n.pct >= 100) return CHARGED_LEVEL;
    if (n.pct >= n.full) return FULL_LEVEL;
    return null;
  }
  if (n.pct <= n.low) return LOW_LEVEL;
  return null;
}

// 档位判定 + 去重状态机。
// 入参：{ pct, charging, low, full, lastLevel }
//   lastLevel —— 上一次「已提醒过」的档位（'low' | 'full' | 'charged' | null）
// 返回：{ level, notify, nextLevel }
//   level     —— 本次检测到的档位（'low' | 'full' | 'charged' | null）
//   notify    —— 是否应当发出提醒（档位非空且与上次已提醒档位不同）
//   nextLevel —— 下一次比较用的「已提醒档位」（档位为空时重置为 null）
function decideAlert({ pct, charging, low, full, lastLevel } = {}) {
  const level = currentLevel({ pct, charging, low, full });
  const last = (lastLevel === LOW_LEVEL || lastLevel === FULL_LEVEL || lastLevel === CHARGED_LEVEL)
    ? lastLevel : null;
  const notify = level !== null && level !== last;
  return { level, notify, nextLevel: level };
}

module.exports = { LOW_LEVEL, FULL_LEVEL, CHARGED_LEVEL, currentLevel, decideAlert };
