// Mio - v2.0 批次 D 纯函数层单元测试（node:test，零第三方）
// 覆盖：sunburst（parseDu/computeOwnSize）、uninstall（kindOf）、
//       stash（暂存引用 CRUD + 校验）、snippets（片段 CRUD + 上限/截断）。
// 运行：npm test（= node --test test/*.test.js）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const sunburst = require('../main/core/sunburst.js');
const uninstall = require('../main/core/uninstall.js');

// ===== 工具：mock electron，把 userData 指向临时目录 =====
// stash/snippets 通过 require('electron').app.getPath('userData') 取落盘路径。
// 用 Module._load 拦截，注入一个指向 os.tmpdir()/mio-test-userData 的 mock。
let tmpUserData = null;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath: () => {
          if (!tmpUserData) {
            tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-test-userdata-'));
          }
          return tmpUserData;
        },
      },
    };
  }
  return origLoad.apply(this, arguments);
};

// 每个用例前重置临时目录与模块缓存，保证隔离
function freshUserData() {
  if (tmpUserData) { try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch {} }
  tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-test-userdata-'));
  delete require.cache[require.resolve('../main/core/stash.js')];
  delete require.cache[require.resolve('../main/core/snippets.js')];
  return tmpUserData;
}

// ===== sunburst：纯函数 =====
test('sunburst.parseDu 把 du 输出解析成树（size 转 bytes）', () => {
  const root = '/Users/demo/Documents';
  const out = [
    '4\t/Users/demo/Documents',
    '100\t/Users/demo/Documents/a.txt',
    '2048\t/Users/demo/Documents/photos',
    '1024\t/Users/demo/Documents/photos/1.jpg',
    '1024\t/Users/demo/Documents/photos/2.jpg',
  ].join('\n');
  const tree = sunburst.parseDu(out, root);
  assert.equal(tree.name, 'Documents');
  assert.equal(tree.path, root);
  // 自身 size（不含子树）：根 4KB - 子(100KB + 2048KB) → 负则 clamp 0
  assert.equal(tree.own, 0);
  // photos 子目录：2048KB - (1024+1024)KB = 0KB → own 0
  const photos = tree.children.find((c) => c.name === 'photos');
  assert.ok(photos, '应有 photos 子节点');
  assert.equal(photos.size, 2048 * 1024);
  assert.equal(photos.own, 0);
  assert.equal(photos.children.length, 2);
  const a = tree.children.find((c) => c.name === 'a.txt');
  assert.equal(a.size, 100 * 1024);
  assert.equal(a.own, 100 * 1024);
});

test('sunburst.parseDu 忽略非 root 前缀与畸形行', () => {
  const root = '/Users/x/Documents';
  const out = [
    '1\t/Users/x/Documents/ok.txt',
    '2\t/Users/other/not-mine.txt',
    'garbage line',
    'no-tab 123',
  ].join('\n');
  const tree = sunburst.parseDu(out, root);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].name, 'ok.txt');
});

test('sunburst.computeOwnSize 自身大小 = size - Σ子 size（clamp ≥0）', () => {
  const node = {
    size: 100, children: [
      { size: 30, children: [{ size: 10, children: [] }, { size: 5, children: [] }] },
      { size: 40, children: [] },
    ],
  };
  sunburst.computeOwnSize(node);
  // 叶子
  assert.equal(node.children[0].children[0].own, 10);
  assert.equal(node.children[0].children[1].own, 5);
  // 中间：30 - (10+5) = 15
  assert.equal(node.children[0].own, 15);
  // 根：100 - (30 + 40) = 30
  assert.equal(node.own, 30);
});

test('sunburst.computeOwnSize 空/null 节点安全返回 0', () => {
  assert.equal(sunburst.computeOwnSize(null), 0);
  assert.equal(sunburst.computeOwnSize({ size: 5, children: [] }), 5);
});

// ===== uninstall：kindOf =====
test('uninstall.kindOf 识别 4 类残留路径', () => {
  const HOME = os.homedir();
  assert.equal(uninstall.kindOf(path.join(HOME, 'Library/Preferences/com.a.plist'), 'com.a'), 'preferences');
  assert.equal(uninstall.kindOf(path.join(HOME, 'Library/Application Support/MyApp'), 'com.a'), 'support');
  assert.equal(uninstall.kindOf(path.join(HOME, 'Library/Caches/MyApp'), 'com.a'), 'caches');
  assert.equal(uninstall.kindOf(path.join(HOME, 'Library/Saved Application State/com.a.savedState'), 'com.a'), 'savedState');
  assert.equal(uninstall.kindOf('/tmp/whatever', 'com.a'), 'other');
});

// ===== stash：中转站 CRUD =====
test('stash.add 空路径拒绝', () => {
  const stash = require('../main/core/stash.js');
  const r = stash.add('');
  assert.equal(r.ok, false);
  assert.match(r.error, /路径/);
});

test('stash.add 不存在的文件拒绝', () => {
  const stash = require('../main/core/stash.js');
  const r = stash.add('/definitely/not/exist/xyz');
  assert.equal(r.ok, false);
});

test('stash.add 成功加入并去重', () => {
  const ud = freshUserData();
  const stash = require('../main/core/stash.js');
  const p = path.join(ud, 'probe.txt');
  fs.writeFileSync(p, 'hello');
  const r = stash.add(p);
  assert.equal(r.ok, true);
  assert.equal(r.item.path, path.resolve(p));
  assert.equal(r.item.name, 'probe.txt');
  assert.equal(r.item.isDir, false);
  // 重复路径拒绝
  const dup = stash.add(p);
  assert.equal(dup.ok, false);
  assert.match(dup.error, /已在/);
  // list 反映 exists
  const listed = stash.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].exists, true);
});

test('stash.remove/clear 删除引用（不删源文件）', () => {
  const ud = freshUserData();
  const stash = require('../main/core/stash.js');
  const p = path.join(ud, 'probe.txt');
  fs.writeFileSync(p, 'hello');
  const { item } = stash.add(p);
  const rm = stash.remove(item.id);
  assert.equal(rm.ok, true);
  assert.equal(stash.list().length, 0);
  // 源文件仍在
  assert.equal(fs.existsSync(p), true);
  // clear 幂等
  assert.deepEqual(stash.clear(), { ok: true, items: [] });
});

// ===== snippets：片段 CRUD =====
test('snippets.add 名称/内容非空 + 长度上限', () => {
  const snippets = require('../main/core/snippets.js');
  assert.equal(snippets.add({ name: '', text: 'x' }).ok, false);
  assert.equal(snippets.add({ name: 'n', text: '' }).ok, false);
  const long = 'x'.repeat(2001);
  const r = snippets.add({ name: 'n', text: long });
  assert.equal(r.ok, false);
  assert.match(r.error, /2000/);
});

test('snippets.add 成功 + 名称截断 40 字符', () => {
  const ud = freshUserData();
  const snippets = require('../main/core/snippets.js');
  const longName = 'n'.repeat(60);
  const r = snippets.add({ name: longName, text: 'hello' });
  assert.equal(r.ok, true);
  assert.equal(r.item.name.length, 40);
  assert.equal(r.item.text, 'hello');
});

test('snippets.update 修改 + insert 取文本', () => {
  const ud = freshUserData();
  const snippets = require('../main/core/snippets.js');
  const { item } = snippets.add({ name: 'greet', text: 'hi' });
  const up = snippets.update(item.id, { text: 'hello world' });
  assert.equal(up.ok, true);
  assert.equal(up.item.text, 'hello world');
  const ins = snippets.insert(item.id);
  assert.equal(ins.ok, true);
  assert.equal(ins.text, 'hello world');
  // 更新不存在 id
  assert.equal(snippets.update('nope', { text: 'x' }).ok, false);
  // insert 不存在 id
  assert.equal(snippets.insert('nope').ok, false);
});

test('snippets.remove 删除片段', () => {
  const ud = freshUserData();
  const snippets = require('../main/core/snippets.js');
  const { item } = snippets.add({ name: 'tmp', text: 'x' });
  const rm = snippets.remove(item.id);
  assert.equal(rm.ok, true);
  assert.equal(snippets.list().length, 0);
  assert.equal(snippets.remove(item.id).ok, false); // 已删
});

// 恢复 Module._load
test.after(() => {
  Module._load = origLoad;
});