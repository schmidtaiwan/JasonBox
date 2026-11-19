const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

class Node {
  constructor() { this.value = ''; this.children = []; this.open = false; this.style = {}; this.attrs = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attrs[key] = value; }
  removeAttribute(key) { delete this.attrs[key]; }
  get childElementCount() { return this.children.length; }
  reset() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  setPointerCapture(id) { this.pointerId = id; }
  hasPointerCapture(id) { return this.pointerId === id; }
  releasePointerCapture() { this.pointerId = null; }
  classList = { add() {} };
  getScreenCTM() { return { inverse: () => ({}) }; }
  createSVGPoint() { return { matrixTransform() { return { x: this.x, y: this.y }; } }; }
}

test('map placement, direct items, timestamps, reopening and deleting update storage', async () => {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  let records = [], count = 0;
  const timers = new Map(); let nextTimer = 0;
  const context = {
    document: { getElementById: get, querySelector: get, createElement: () => new Node(), createElementNS: () => new Node(), addEventListener() {} },
    window: { location: { protocol: 'https:' }, addEventListener() {}, scrollTo() {}, confirm: () => true },
    URL, Blob, Intl, Date, console, setInterval() {}, fetch: async () => ({ ok: false }),
    setTimeout(callback, delay) { assert.equal(delay, 1000); timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    IntersectionObserver: class { disconnect() {} observe() {} },
    drive: {
      SessionExpired: class extends Error {},
      readEntries: async () => records.map(r => ({ ...r })),
      save: async r => {
        const saved = { ...r, id: r.id || String(++count), createdAt: r.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
        records = records.filter(item => item.id !== saved.id).concat(saved);
        return saved;
      },
      touch: async r => { const updated = { ...r, updatedAt: '2026-11-19T04:00:00Z' }; records = records.map(item => item.id === r.id ? updated : item); return updated; },
      remove: async r => { records = records.filter(item => item.id !== r.id); }
    }
  };
  vm.createContext(context);
  for (const file of ['plan.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  const run = code => vm.runInContext(code, context);
  await run('refresh()'); await run('refresh()');
  assert.equal(records.length, 4, 'no duplicate floors on reload');
  assert.equal(get('add').hidden, true);
  get('floor-image').children[0].onclick({ clientX: 570, clientY: 240 });
  assert.equal(run('draft.parent'), records[1].id);
  assert.equal(run('draft.x'), 570 / 1672);
  assert.equal(run('draft.y'), 240 / 941);
  get('name').value = '床底下';
  await get('form').onsubmit({ preventDefault() {} });
  const storage = records.find(r => r.name === '床底下');
  assert.ok(storage.createdAt && storage.updatedAt);
  await run('refresh()');
  assert.equal(run('entries.find(e => e.name === "床底下").x'), 570 / 1672);
  let marker = get('floor-image').children[0].children.find(n => n.attrs.role === 'button');
  const pointer = { pointerId: 1, button: 0, clientX: 570, clientY: 240, stopPropagation() {}, preventDefault() {} };
  marker.onpointerdown(pointer);
  marker.onpointerup(pointer);
  assert.equal(timers.size, 0, 'short press cancels long-press timer');
  marker.onpointerdown(pointer);
  [...timers.values()][0]();
  assert.equal(run('planAdjustment.id'), storage.id, 'one-second hold enters adjustment mode');
  marker.onpointermove({ ...pointer, clientX: 0, clientY: 900 });
  assert.equal(run('planAdjustment.x'), 494 / 1672, 'drag stays within its original floor');
  assert.equal(run('planAdjustment.y'), 810 / 941);
  marker.onpointerup(pointer);
  marker.onclick({ stopPropagation() {} });
  assert.equal(run('current'), null, 'long press must not also open storage');
  get('marker-tools').children[3].onclick();
  assert.equal(run('planAdjustment.scale'), 1.1);
  get('marker-tools').children[5].onclick();
  assert.equal(run('planAdjustment'), null);
  assert.equal(records.find(r => r.id === storage.id).x, 570 / 1672, 'cancel restores persisted position');
  run('startAdjustment(entries.find(e => e.name === "床底下")); planAdjustment.scale = 1.5; planAdjustment.x = .34');
  await run('saveAdjustment()');
  await run('refresh()');
  assert.equal(run('entries.find(e => e.name === "床底下").scale'), 1.5);
  assert.equal(run('entries.find(e => e.name === "床底下").x'), .34);
  marker = get('floor-image').children[0].children.find(n => n.attrs.role === 'button');
  marker.onclick({ stopPropagation() {} });
  assert.equal(run('current.id'), storage.id);
  get('add').onclick();
  assert.equal(run('draft.level'), 4, 'items live directly under a marked space');
  assert.equal(run('draft.parent'), storage.id);
  get('name').value = '冬季棉被';
  await get('form').onsubmit({ preventDefault() {} });
  const item = records.find(r => r.name === '冬季棉被');
  assert.ok(item.updatedAt);
  assert.equal(run('current.updatedAt'), '2026-11-19T04:00:00Z');
  run('edit(entries.find(e => e.name === "冬季棉被"))');
  await get('remove').onclick();
  assert.ok(!records.some(r => r.id === item.id));
  get('add').onclick();
  get('name').value = '';
  await get('form').onsubmit({ preventDefault() {} });
  assert.equal(get('editor').open, true, 'empty item is rejected');
  run('draft.photo = new Blob(["test photo"], {type:"image/jpeg"})');
  await get('form').onsubmit({ preventDefault() {} });
  assert.ok(records.some(r => r.name.startsWith('物品照片 ') && r.parent === storage.id), 'photo-only item gets a readable automatic name');
  assert.equal(run('formatTime("2026-11-19T04:00:00Z")').includes('12:00:00'), true);
  run('edit(entries[0])');
  assert.equal(get('editor').open, false, 'fixed floor cannot be edited');
});

test('Drive round-trips coordinates and timestamps and reads both direct and legacy items', async () => {
  const folder = 'application/vnd.google-apps.folder';
  const files = new Map([
    ['root', { id: 'root', name: 'JasonBox', mimeType: folder, parents: [], appProperties: {} }],
    ['floor', { id: 'floor', name: '2F', mimeType: folder, parents: ['root'], appProperties: {} }],
    ['space', { id: 'space', name: '櫃子', mimeType: folder, parents: ['floor'], appProperties: { x: '.35', y: '.25' } }],
    ['cabinet', { id: 'cabinet', name: '舊櫃子', mimeType: folder, parents: ['space'], appProperties: {} }],
    ['box', { id: 'box', name: '舊分類箱', mimeType: folder, parents: ['cabinet'], appProperties: {} }],
    ['old', { id: 'old', name: '舊物品.json', mimeType: 'application/json', parents: ['box'], appProperties: { jasonBoxItem: '1' } }],
    ['direct', { id: 'direct', name: '直接物品.jpg', mimeType: 'image/jpeg', parents: ['space'], appProperties: { jasonBoxItem: '1' } }]
  ]);
  let count = 0;
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const id = parsed.pathname.split('/').pop();
    if (options.method) {
      let metadata;
      if (typeof options.body === 'string') metadata = JSON.parse(options.body);
      else {
        const body = await options.body.text();
        metadata = JSON.parse(body.split('\r\n\r\n')[1].split('\r\n--')[0]);
      }
      const previous = files.get(id);
      const saved = { ...(previous || { id: 'new-' + ++count, createdTime: '2026-11-19T00:00:00Z' }), ...metadata,
        appProperties: { ...previous?.appProperties, ...metadata.appProperties }, modifiedTime: new Date().toISOString() };
      files.set(saved.id, saved);
      return Response.json(saved);
    }
    if (parsed.searchParams.has('q')) {
      const query = parsed.searchParams.get('q');
      const parents = [...query.matchAll(/'([^']+)' in parents/g)].map(match => match[1]);
      return Response.json({ files: [...files.values()].filter(file => !file.trashed && file.parents.some(parent => parents.includes(parent))) });
    }
    return Response.json(files.get(id));
  };
  const context = { Headers, URLSearchParams, Blob, Date, crypto: require('node:crypto').webcrypto, fetch };
  vm.createContext(context);
  // Seed an authenticated adapter session; all requests go to the in-memory API above.
  const source = fs.readFileSync(path.join(__dirname, '..', 'drive.js'), 'utf8')
    .replace('let token;', 'let token = "test";')
    .replace('let expiresAt;', 'let expiresAt = Infinity;')
    .replace('let root;', 'let root = "root";');
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  const entries = await run('drive.readEntries()');
  assert.equal(entries.find(e => e.id === 'direct').level, 4);
  assert.equal(entries.find(e => e.id === 'old').level, 4);
  const marker = await run('drive.save({id:"space",name:"床底下",parent:"floor",level:1,x:.36,y:.26,scale:1.5})');
  assert.equal(marker.x, .36);
  assert.equal(marker.y, .26);
  assert.equal(marker.scale, 1.5);
  assert.ok(marker.updatedAt);
  const item = await run('drive.save({name:"新物品",parent:"space",level:4})');
  assert.equal(item.name, '新物品');
  assert.equal(item.parent, 'space');
  assert.ok(item.createdAt && item.updatedAt);
  const reread = await run('drive.readEntries()');
  assert.equal(reread.find(e => e.id === item.id).level, 4);
  const touched = await run('drive.touch({id:"space",level:1})');
  assert.equal(touched.x, .36, 'parent time updates preserve marker coordinates');
  assert.equal(touched.scale, 1.5, 'parent time updates preserve marker size');
});
