const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('PDF export includes cover and album photos within scope even when there are no items', async () => {
  const floor = { id: 'floor', level: 0, name: '1F' };
  const space = { id: 'space', parent: 'floor', level: 1, name: '櫃子', photoId: 'cover', hasPhoto: true, spaceAlbum: true };
  const other = { id: 'other', parent: 'floor', level: 1, name: '別的空間', photoId: 'other-cover', hasPhoto: true };
  const fetched = [];
  let html;
  let printed = false;
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, {});
    return nodes.get(id);
  };
  const popup = {
    document: { write(value) { html = value; }, open() {}, close() {}, getElementById: get, images: [], fonts: { ready: Promise.resolve() } },
    closed: false, focus() {}, print() { printed = true; }, addEventListener() {}
  };
  const context = {
    current: space, entries: [floor, space, other], ancestors: entry => [floor, entry], $: get, Date, formatTime: () => '台北時間',
    window: { open: () => popup }, URL: { createObjectURL: blob => 'blob:' + blob },
    drive: { spacePhotos: async () => [{ id: 'side', name: '側面.jpg' }], photo: async id => { fetched.push(id); return id; } }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'export.js'), 'utf8');
  await vm.runInNewContext(source + '\nexportPdf()', context);
  assert.deepEqual(fetched, ['cover', 'side']);
  assert.match(html, /空間照片/);
  assert.match(html, /1F \/ 櫃子/);
  assert.match(html, /blob:cover/);
  assert.match(html, /blob:side/);
  assert.doesNotMatch(html, /別的空間/);
  assert.equal(printed, true);
});

class Node {
  constructor() { this.value = ''; this.children = []; this.open = false; this.style = {}; this.attrs = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  replaceWith(node) { this.replacement = node; }
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
  classList = { add() {}, remove() {} };
  getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 300 }; }
  getScreenCTM() { return { inverse: () => ({}) }; }
  createSVGPoint() { return { matrixTransform() { return { x: this.x, y: this.y }; } }; }
}

test('map placement, direct items, timestamps, reopening and deleting update storage', async () => {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  let records = [], count = 0;
  const timers = new Map(); let nextTimer = 0;
  const listeners = new Map();
  const context = {
    document: { body: new Node(), documentElement: new Node(), getElementById: get, querySelector: get, createElement: () => new Node(), createElementNS: () => new Node(), addEventListener(type, callback) { listeners.set(type, callback); } },
    window: { scrollX: 0, scrollY: 420, location: { protocol: 'https:' }, addEventListener() {}, scrollTo(x, y) { this.lastScroll = [x, y]; }, confirm: () => true },
    URL, Blob, Intl, Date, console, setInterval() {}, fetch: async () => ({ ok: false }),
    setTimeout(callback, delay) { assert.equal(delay, 1000); timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    IntersectionObserver: class { disconnect() {} observe() {} },
    drive: {
      SessionExpired: class extends Error {},
      account: () => ({ email: 'test@example.com', name: 'Test', picture: 'https://example.com/avatar.png' }),
      quota: async () => ({ usage: '1073741824', limit: '16106127360' }),
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
  for (const file of ['appearance.js', 'photo.js', 'plan.js', 'export.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  const run = code => vm.runInContext(code, context);
  assert.ok(run('changeDescription({updatedAt: "2026-11-19T04:00:00Z",updatedBy:"backy2777@example.com"})').endsWith(' · BACKY2777'));
  assert.equal(run('markerTone([255,255,255,255])'), 'dark', 'light photo uses dark markers');
  assert.equal(run('markerTone([0,0,0,255])'), 'light', 'dark photo uses light markers');
  assert.equal(run('markerTone([0,0,0,0])'), 'dark', 'transparent photo is treated as white');
  await run('refresh()'); await run('refresh()');
  assert.equal(records.length, 4, 'no duplicate floors on reload');
  assert.equal(get('add').hidden, false);
  assert.equal(get('add').disabled, true);
  run('setSearchOpen(false)');
  get('toggle-search').onclick();
  assert.equal(get('search-panel').hidden, false);
  assert.equal(get('toggle-search').attrs['aria-expanded'], 'true');
  get('search').value = '搜尋文字';
  get('toggle-search').onclick();
  assert.equal(get('search-panel').hidden, true);
  assert.equal(get('search').value, '', 'closing search restores the normal content');

  get('view-list').onclick();
  assert.equal(get('list').className, 'compact-list');
  assert.equal(get('view-list').attrs['aria-pressed'], 'true');
  await run('refresh()');
  assert.equal(get('list').className, 'compact-list', 'refresh preserves selected display mode');
  await run('refresh({ initial: true })');
  assert.equal(run('current.name'), '1F', 'new sessions start on the first floor');
  assert.equal(get('floor-tabs').children[0].attrs['aria-pressed'], 'true');
  get('floor-tabs').children[4].onclick();
  assert.equal(run('current'), null, 'ALL remains selectable');
  get('view-details').onclick();
  assert.equal(get('list').className, '');
  assert.equal(get('view-details').attrs['aria-pressed'], 'true');
  assert.equal(get('floor-image').children[0].onclick, undefined, 'blank floor does not create spaces');
  run('navigate(entries.find(e => e.name === "2F"))');
  get('add').onclick();
  get('add-kind').children[1].onclick();
  assert.equal(run('draft.parent'), records[1].id);
  assert.equal(run('draft.level'), 1);
  assert.ok(Number.isFinite(run('draft.x')));
  run('draft.x = 570 / 1672; draft.y = 240 / 941');
  get('name').value = '床底下';
  await get('form').onsubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  const storage = records.find(r => r.name === '床底下');
  run('navigate(null); navigationHistory = []');
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
  assert.equal(context.document.body.style.position, 'fixed', 'page freezes during adjustment');
  assert.equal(context.document.body.style.top, '-420px');
  for (const type of ['wheel', 'touchmove']) {
    let prevented = false;
    listeners.get(type)({ preventDefault() { prevented = true; } });
    assert.ok(prevented, type + ' cannot scroll during adjustment');
  }
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
  assert.equal(run('adjustmentScroll'), null, 'cancel releases scroll lock');
  assert.deepEqual(context.window.lastScroll, [0, 420], 'cancel restores original scroll position');
  listeners.get('touchmove')({ preventDefault() { assert.fail('normal scrolling should resume after cancel'); } });
  assert.equal(records.find(r => r.id === storage.id).x, 570 / 1672, 'cancel restores persisted position');
  run('startAdjustment(entries.find(e => e.name === "床底下")); planAdjustment.scale = 1.5; planAdjustment.x = .34');
  await run('saveAdjustment()');
  assert.equal(run('adjustmentScroll'), null, 'successful save releases scroll lock');
  await run('refresh()');
  assert.equal(run('entries.find(e => e.name === "床底下").scale'), 1.5);
  assert.equal(run('entries.find(e => e.name === "床底下").x'), .34);
  marker = get('floor-image').children[0].children.find(n => n.attrs.role === 'button');
  marker.onclick({ stopPropagation() {} });
  assert.equal(run('current.id'), storage.id);
  get('current-space-icon').onclick();
  assert.equal(get('appearance-dialog').open, true);
  assert.equal(get('icon-choices').children.length, 10);
  assert.equal(get('icon-choices').children[9].children[1].textContent, '僅照片（透明底）');
  assert.equal(get('color-choices').children.length, 8);
  get('icon-choices').children[1].onclick();
  get('color-choices').children[1].onclick();
  await get('appearance-save').onclick();
  assert.equal(run('current.iconKey'), 'bed');
  assert.equal(run('current.iconColor'), '#1768a6');

  assert.equal(get('floor-plans').hidden, true, 'cabinet opens a content screen');
  run('setSignedIn(true)');
  assert.equal(get('footer').hidden, false);
  assert.equal(get('add').disabled, false);
  get('back').onclick();
  assert.equal(run('current'), null);
  assert.equal(get('floor-plans').hidden, false, 'back restores floor layout');
  assert.deepEqual(context.window.lastScroll, [0, 420], 'back restores the scroll position saved before opening cabinet');
  assert.equal(get('footer').hidden, false, 'footer stays pinned on floor screen');
  assert.equal(get('add').disabled, true);
  run('navigate(entries.find(e => e.name === "床底下"))');

  get('add').onclick();
  assert.equal(run('draft.level'), 4, 'items live directly under a marked space');
  assert.equal(run('draft.parent'), storage.id);
  get('name').value = '冬季棉被';
  await get('form').onsubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  const item = records.find(r => r.name === '冬季棉被');
  assert.ok(item.updatedAt);
  get('view-list').onclick();
  const group = run('photoListCard(entries.find(e => e.name === "床底下"))');
  assert.equal(group.children[0].children[0].textContent, '床底下');
  assert.equal(group.children[1].children.length, 1);
  assert.equal(group.children[1].children[0].children[1].textContent, '冬季棉被');
  group.children[1].children[0].onclick();
  assert.equal(run('draft.id'), item.id, 'gallery item opens its editor');
  run('closeEditor()');
  get('view-details').onclick();
  assert.equal(run('current.updatedAt'), '2026-11-19T04:00:00Z');
  run('edit(entries.find(e => e.name === "冬季棉被"))');
  await get('remove').onclick();
  assert.ok(!records.some(r => r.id === item.id));
  get('add').onclick();
  get('name').value = '';
  await get('form').onsubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('editor').open, true, 'empty item is rejected');
  run('compress = async blob => blob');
  await get('camera').onchange({ target: { files: [Object.assign(new Blob(['test photo'], { type: 'image/jpeg' }), { name: 'test.jpg' })] } });
  const realSave = context.drive.save;
  let resolveUpload, rejectUpload;
  context.drive.save = () => new Promise((resolve, reject) => { resolveUpload = resolve; rejectUpload = reject; });
  await get('form').onsubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('editor').open, false, 'photo editor closes before upload finishes');
  assert.equal(run('photoUploads.size'), 1);
  assert.ok(run('entries.some(e => e.photo && e.id.startsWith("pending-photo-"))'));
  rejectUpload(new Error('network unavailable'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run('Array.from(photoUploads.values())[0].failed'), true);
  run('openItem(Array.from(photoUploads.values())[0].local)');
  assert.equal(run('Array.from(photoUploads.values())[0].running'), true);
  const uploaded = await realSave(run('Array.from(photoUploads.values())[0].record'));
  resolveUpload(uploaded);
  await new Promise(resolve => setImmediate(resolve));
  context.drive.save = realSave;
  assert.equal(run('photoUploads.size'), 0, 'retry replaces local photo with uploaded record');
  assert.equal(get('drive-quota').textContent, '1GB/15GB', 'successful upload refreshes quota');
  run('queueSelectedPhotos({level:4,parent:current.id,name:"批次照片",photos:[{name:"照片A",photo:new Blob(["a"])},{name:"照片B",photo:new Blob(["b"])}]}, "")');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(records.filter(r => ["照片A", "照片B"].includes(r.name) && r.parent === storage.id).length, 2, 'multiple photos go into the same cabinet');
  assert.equal(run('photoUploads.size'), 0);

  assert.ok(records.some(r => r.name.startsWith('物品照片 ') && r.parent === storage.id), 'photo-only item gets a readable automatic name');
  const metadataSave = context.drive.save;
  let releaseParent;
  context.drive.save = record => record.name === '背景櫃'
    ? new Promise(resolve => { releaseParent = async () => resolve(await metadataSave(record)); })
    : metadataSave(record);
  run('queuePhotoUpload({name:"背景櫃",level:1,parent:entries.find(e => e.level === 0).id})');
  const pendingParentId = run('entries.find(e => e.name === "背景櫃").id');
  assert.equal(get('editor').open, false, 'text-only saves also close immediately');
  run('navigate(entries.find(e => e.name === "背景櫃")); queuePhotoUpload({name:"背景櫃物品",level:4,parent:current.id})');
  assert.ok(!records.some(r => r.name === '背景櫃物品'), 'child waits for its parent in the background');
  await releaseParent();
  await new Promise(resolve => setImmediate(resolve));
  const savedParent = records.find(r => r.name === '背景櫃');
  assert.equal(records.find(r => r.name === '背景櫃物品').parent, savedParent.id);
  assert.notEqual(savedParent.id, pendingParentId);
  assert.equal(run('current.id'), savedParent.id, 'current location updates to the real Drive id');
  context.drive.save = metadataSave;
  assert.equal(run('formatTime("2026-11-19T04:00:00Z")').includes('12:00:00'), true);
  run('navigate(entries.find(e => e.name === "床底下"))');
  get('add').onclick();
  get('add-kind').children[1].onclick();
  assert.equal(run('draft.level'), 2);
  get('position-type').value = '層';
  get('name').value = '上層';
  await get('form').onsubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  const position = records.find(r => r.name === '上層');
  assert.equal(position.positionType, '層');
  assert.equal(position.parent, storage.id);
  run('current = {...current, hasPhoto:true, photo:new Blob(["space photo"])}; render()');
  assert.equal(get('space-layout').hidden, false);
  const photoViewport = get('space-layout').children.find(node => node.className === 'space-photo-viewport');
  const photoCanvas = photoViewport.children[0];
  const frameControls = get('space-layout').children.find(node => node.className === 'space-photo-frame-controls');
  const handle = frameControls.children[0];
  Object.assign(photoCanvas.children[0], { naturalWidth: 800, naturalHeight: 400 });
  handle.onpointerdown({ pointerId: 1, button: 0, clientY: 300 });
  handle.onpointermove({ pointerId: 1, clientY: 450 });
  assert.equal(photoViewport.style.height, '450px');
  assert.equal(photoCanvas.style.minWidth, '900px', 'photo grows with the frame while keeping its aspect ratio');
  handle.onpointermove({ pointerId: 1, clientY: 240 });
  assert.equal(photoViewport.style.height, '240px');
  handle.onlostpointercapture({ pointerId: 1 });
  assert.equal(photoCanvas.style.minWidth, '480px', 'the photo grows or shrinks with the frame in either direction');
  frameControls.children[1].onclick();
  assert.equal(photoViewport.style.maxHeight, 'none');
  assert.equal(photoViewport.style.height, '');
  assert.equal(photoCanvas.style.minWidth, '');
  assert.ok(photoCanvas);
  assert.equal(photoCanvas.onclick, undefined, 'blank photo does not create positions');
  run('current = {...current, coverTransform:[2,0,0,1,-1.4,0]}; render()');
  const croppedLayout = get('space-layout');
  const croppedCanvas = croppedLayout.children.find(node => node.className === 'space-photo-viewport').children[0];
  const croppedMarker = croppedCanvas.children.find(node => node.className === 'space-photo-marker');
  assert.equal(croppedMarker.style.left, '5%');
  assert.notEqual(croppedMarker.hidden, true);
  const croppedLinks = croppedLayout.children.find(node => node.className === 'cropped-position-links');
  assert.ok(croppedLinks.children.some(node => node.textContent === '上層'));
  run('current = {...current, coverTransform:undefined}; render()');
  get('add').onclick();
  get('add-kind').children[1].onclick();
  assert.equal(run('draft.parent'), storage.id);
  assert.equal(run('draft.photoX'), .5);
  assert.equal(run('draft.photoY'), .5);
  assert.equal(run('draft.positionType'), '區');
  run('closeEditor()');

  run('navigate(entries.find(e => e.name === "上層"))');
  get('add').onclick();
  assert.equal(run('draft.parent'), position.id);
  assert.ok(get('location').textContent.endsWith('床底下 / 上層'), 'add dialog identifies the current nested location');

  get('name').value = '層內物品';
  await get('form').onsubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(records.some(r => r.name === '層內物品' && r.parent === position.id));
  assert.equal(run('exportItems().length'), 1, 'nested export only includes current location');
  assert.equal(run('exportItems()[0].name'), '層內物品');
  assert.ok(run('exportItems()[0].location').endsWith('床底下 / 上層'));
  assert.ok(run('exportItems(null).length') > 1, 'all-space export includes other items');
  assert.equal(run('exportEscape("<script>&")'), '&lt;script&gt;&amp;');

  run('navigate(entries.find(e => e.level === 0))');
  assert.equal(get('add').disabled, false);
  get('add').onclick();
  assert.equal(run('draft.parent'), run('current.id'));
  assert.equal(run('draft.level'), 1, 'floor Add defaults to space');
  assert.equal(get('add-kind').children.length, 3);
  assert.equal(get('add-kind').children[0].disabled, true, 'floors cannot select items');
  assert.equal(get('add-kind').children[2].disabled, true);
  assert.equal(get('add-kind').children[1].textContent, '空間');
  run('closeEditor()');
  run('navigate(entries.find(e => e.name === "上層"))');

  run('edit(entries.find(e => e.name === "上層"))');
  await get('remove').onclick();
  assert.ok(records.some(r => r.id === position.id), 'nonempty position cannot be deleted');
  run('closeEditor()');
  run('edit(entries[0])');
  assert.equal(get('editor').open, false, 'fixed floor cannot be edited');
  run('setSignedIn(true)');
  await run('refreshQuota()');
  assert.equal(get('header-storage').hidden, false);
  assert.equal(get('account-email').textContent, 'test@example.com');
  assert.equal(get('account-avatar').hidden, false);
  assert.equal(get('drive-quota').textContent, '1GB/15GB');
  assert.equal(run('formatStorage(71932314)'), '68.6MB');
  assert.equal(get('floor-tabs').children[4].textContent, 'ALL');
  get('account-avatar').onerror();
  assert.equal(get('avatar-fallback').hidden, false);
  context.drive.quota = async () => { throw new Error('offline'); };
  await run('refreshQuota()');
  assert.equal(get('retry-quota').hidden, false, 'quota failures can be retried');
  let resolveQuota;
  context.drive.quota = () => new Promise(resolve => { resolveQuota = resolve; });
  const pending = run('refreshQuota()');
  run('setSignedIn(false)');
  resolveQuota({ usage: '1', limit: '15' });
  await pending;
  assert.equal(get('drive-quota').textContent, '', 'late quota response cannot repopulate signed-out account');
  assert.equal(get('header-storage').hidden, true);
  assert.equal(get('account-menu').hidden, true);
  run('navigate(entries.find(e => e.name === "床底下")); setSignedIn(true)');
  get('add').onclick();
  get('name').value = '圍巾 帽子,手套，雨傘';
  await get('form').onsubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  for (const name of ['圍巾', '帽子', '手套', '雨傘']) assert.ok(records.some(record => record.name === name));
  const moved = run('photoPoint(combinePhotoTransforms([2,0,0,2,-.5,-.5],[0,1,-1,0,1,0]), .5, .25)');
  assert.deepEqual(Array.from(moved), [1, .5], 'rotation and crop preserve relative marker location');
  records.push({ id: 'left', level: 2, name: '左', parent: storage.id }, { id: 'right', level: 2, name: '右', parent: storage.id });
  records.push({ id: 'left-child', level: 3, name: '下層', parent: 'left' });
  for (const id of ['move-a', 'move-b', 'stay']) records.push({ id, level: 4, name: id, parent: 'left' });
  context.drive.moveItem = async (entry, target) => realSave({ ...entry, parent: target.id });
  await run('refresh();');
  run('navigate(entries.find(e => e.id === "left"))');
  assert.equal(get('move-items').hidden, false);
  get('move-items').onclick();
  const targets = get('move-target').children;
  assert.ok(targets.some(option => option.value === storage.id && option.textContent.startsWith('上一層')));
  assert.ok(targets.some(option => option.value === 'right' && option.textContent.startsWith('同層')));
  assert.ok(targets.some(option => option.value === 'left-child' && option.textContent.startsWith('下一層')));
  assert.equal(run('spaceAppearance({hasPhoto:true}).icon[0]'), 'photo-only');
  const circleThumb = run('const photoTestSvg = svgNode("svg", {}); photoTestSvg.isConnected = true; addPhotoThumbnail(photoTestSvg, {photo:new Blob(["photo"])}, 38, true); photoTestSvg');
  await Promise.resolve();
  const clip = circleThumb.children[0].children[0];
  assert.equal(Number(clip.children[0].attrs.r), 19);
  assert.equal(circleThumb.children[1].attrs['clip-path'], 'url(#' + clip.attrs.id + ')');
  assert.equal(circleThumb.children[1].attrs.preserveAspectRatio, 'xMidYMid slice');
  assert.equal(run('spaceAppearance({hasPhoto:true,iconKey:"bed"}).icon[0]'), 'bed');
  assert.equal(run('spaceAppearance({hasPhoto:false}).icon[0]'), 'cabinet');
  for (const id of ['move-a', 'move-b']) {
    const checkbox = get('move-list').children.find(row => row.children[1].textContent === id).children[0];
    checkbox.checked = true;
    checkbox.onchange();
  }
  get('move-target').value = 'right';
  get('move-target').onchange();
  await get('move-form').onsubmit({ preventDefault() {} });
  assert.equal(get('move-dialog').open, false);
  assert.deepEqual(records.filter(record => record.parent === 'right').map(record => record.id).sort(), ['move-a', 'move-b']);
  assert.equal(records.find(record => record.id === 'stay').parent, 'left');
  get('marker-settings').onclick();
  get('markers-transparent').checked = true;
  get('marker-label-size').value = 'large';
  get('marker-label-position').value = 'above';
  get('marker-label-color').value = '#842743';
  get('marker-settings-form').onsubmit({ preventDefault() {} });
  assert.equal(run('markerIconEntry({hasPhoto:true, iconKey:"bed"}).iconKey'), 'photo-only');
  run('navigate(null)');
  const label = get('floor-image').children[0].children.find(node => node.attrs.role === 'button').children.at(-1);
  assert.equal(label.attrs.y, -25);
  assert.equal(label.style.fill, '#842743');
  assert.equal(label.style.fontSize, '21.25px');
  get('marker-settings').onclick();
  get('markers-only').checked = true;
  get('marker-settings-form').onsubmit({ preventDefault() {} });
  const iconsOnly = get('floor-image').children[0].children.find(node => node.attrs.role === 'button');
  assert.ok(!iconsOnly.children.some(node => node.attrs['text-anchor']));
  run('navigate(entries.find(e => e.id === "left")); newEntryAtCurrent("position")');
  get('name').value = '左格  右格　上層';
  await get('form').onsubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  const spaces = records.filter(record => record.parent === 'left' && ['左格', '右格', '上層'].includes(record.name));
  assert.equal(spaces.length, 3);
  assert.equal(new Set(spaces.map(space => space.photoX)).size, 3, 'batch-created spaces have distinct marker positions');
  const editId = spaces[0].id;
  context.batchSpaceId = editId;
  run('edit(entries.find(e => e.id === batchSpaceId))');
  get('name').value = '左 格';
  await get('form').onsubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(records.find(record => record.id === editId).name, '左 格', 'renaming preserves spaces inside a name');
  run('navigate(entries.find(e => e.id === "right"))');
  assert.equal(get('delete-items').hidden, false);
  get('delete-items').onclick();
  assert.equal(get('move-target').disabled, true);
  for (const row of get('move-list').children) {
    row.children[0].checked = true;
    row.children[0].onchange();
  }
  context.window.confirm = () => false;
  await get('move-form').onsubmit({ preventDefault() {} });
  assert.equal(records.filter(record => record.parent === 'right').length, 2);
  context.window.confirm = () => true;
  await get('move-form').onsubmit({ preventDefault() {} });
  assert.equal(records.filter(record => record.parent === 'right').length, 0);
  assert.ok(records.some(record => record.id === 'stay'));
  assert.ok(records.some(record => record.id === 'right'), 'batch delete removes items only');
  run('navigate(entries.find(entry => entry.id === "left"))');
  get('view-preview').onclick();
  assert.equal(get('view-preview').attrs['aria-pressed'], 'true');
  const itemGrid = get('list').children[0].children[1];
  assert.ok(itemGrid.children.some(tile => tile.children[1].textContent === 'stay'));
  assert.ok(!itemGrid.children.some(tile => tile.children[1].textContent === '層內物品'));
  run('entries.push({id:"p1",name:"第一張",parent:"left",level:4,photo:new Blob(["one"])},{id:"p2",name:"第二張",parent:"left",level:4,photo:new Blob(["two"])}); render()');
  const tiles = get('list').children[0].children[1].children;
  tiles.find(tile => tile.children[1].textContent === '第一張').onclick();
  assert.equal(get('snapshot-title').textContent, '第一張');
  assert.match(get('snapshot-location').textContent, /^存放位置：.*\/ 床底下 \/ 左$/);
  const stage = get('snapshot-stage');
  stage.onpointerdown({ pointerId: 1, button: 0, clientX: 150, clientY: 10 });
  stage.onpointerup({ pointerId: 1, clientX: 50, clientY: 15 });
  assert.equal(get('snapshot-title').textContent, '第二張');
  assert.equal(get('snapshot-count').textContent, '2 / 2');
  get('snapshot-previous').onclick();
  assert.equal(get('snapshot-title').textContent, '第一張');
  get('snapshot-close').onclick();
  get('add').onclick();
  const kinds = get('add-kind').children;
  assert.deepEqual(kinds.map(kind => kind.textContent), ['物品', '空間', '照片']);
  kinds[2].onclick();
  assert.equal(get('name-field').hidden, true);
  assert.equal(get('gallery').multiple, true);
  await get('form').onsubmit({ preventDefault() {} });
  assert.match(get('form-status').textContent, /請先拍照或選擇照片/);
  await get('gallery').onchange({ target: { files: ['first.jpg', 'second.jpg'].map(name => Object.assign(new Blob([name]), { name })) } });
  await get('form').onsubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  const uploadedPhotos = records.filter(record => record.parent === 'left' && record.photo);
  assert.equal(uploadedPhotos.length, 2);
  assert.ok(uploadedPhotos.every(record => /^物品照片 /.test(record.name)));
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
    if (id === 'about') return Response.json({ storageQuota: { usage: '1024', limit: '2048' } });
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
      if (parsed.searchParams.has('addParents')) {
        saved.parents = previous.parents.filter(parent => parent !== parsed.searchParams.get('removeParents'));
        saved.parents.push(parsed.searchParams.get('addParents'));
      }
      files.set(saved.id, saved);
      return Response.json(saved);
    }
    if (parsed.searchParams.has('q')) {
      const query = parsed.searchParams.get('q');
      const parents = [...query.matchAll(/'([^']+)' in parents/g)].map(match => match[1]);
      return Response.json({ files: [...files.values()].filter(file => !file.trashed && file.parents.some(parent => parents.includes(parent))
        && (!query.includes('jasonBoxSpacePhoto') || file.appProperties?.jasonBoxSpacePhoto === '1')
        && (!query.includes('jasonBoxItem') || file.mimeType === folder || file.appProperties?.jasonBoxItem === '1')) });
    }
    return Response.json(files.get(id));
  };
  const context = { Headers, URLSearchParams, Blob, Date, crypto: require('node:crypto').webcrypto, fetch };
  vm.createContext(context);
  // Seed an authenticated adapter session; all requests go to the in-memory API above.
  const source = fs.readFileSync(path.join(__dirname, '..', 'drive.js'), 'utf8')
    .replace('let token;', 'let token = "test";')
    .replace('let expiresAt;', 'let expiresAt = Infinity;')
    .replace('let root;', 'let root = "root";')
    .replace('let accountInfo;', 'let accountInfo = {email:"jason660803@example.com"};');
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
  const styled = await run('drive.save({id:"space",name:"床",parent:"floor",level:1,iconKey:"bed",iconColor:"#1768a6"})');
  assert.equal(styled.iconKey, 'bed');
  assert.equal(styled.iconColor, '#1768a6');
  const photoStyled = await run('drive.save({id:"space",name:"床",parent:"floor",level:1,iconKey:"photo"})');
  assert.equal(photoStyled.iconKey, 'photo');


  assert.equal(marker.updatedBy, 'jason660803@example.com');
  const item = await run('drive.save({name:"新物品",parent:"space",level:4})');
  assert.equal(item.name, '新物品');
  assert.equal(item.parent, 'space');
  assert.ok(item.createdAt && item.updatedAt);
  const reread = await run('drive.readEntries()');
  assert.equal(reread.find(e => e.id === item.id).level, 4);
  const touched = await run('drive.touch({id:"space",level:1})');
  assert.equal(touched.x, .36, 'parent time updates preserve marker coordinates');
  assert.equal(touched.scale, 1.5, 'parent time updates preserve marker size');
  assert.equal(touched.updatedBy, 'jason660803@example.com');
  const position = await run('drive.save({name:"第2格",parent:"space",level:2,positionType:"格"})');
  assert.equal(position.positionType, '格');
  const positionEntries = await run('drive.readEntries()');
  assert.equal(positionEntries.find(e => e.id === position.id).positionType, '格');
  const photoSpace = await run('drive.save({id:"space",name:"床",level:1,parent:"floor",photo:new Blob(["space photo"])})');
  assert.ok(photoSpace.photoId);
  assert.equal(photoSpace.hasPhoto, true);
  assert.equal(files.get(photoSpace.photoId).parents[0], 'space');
  const placed = await run('drive.save({id:"' + position.id + '",name:"第2格",parent:"space",level:2,positionType:"格",photoX:.25,photoY:.5})');
  assert.equal(placed.photoX, .25);
  assert.equal(placed.photoY, .5);
  const afterPhoto = await run('drive.readEntries()');
  assert.equal(afterPhoto.find(e => e.id === 'space').photoId, photoSpace.photoId);
  context.photoSpace = photoSpace;
  const album = await run('drive.save({...photoSpace, iconKey:"photo-only", extraPhotos:[{name:"側面",photo:new Blob(["side"])},{name:"近照",photo:new Blob(["close"])}]})');
  assert.equal(album.spaceAlbum, true);
  assert.equal(album.iconKey, 'photo-only');
  assert.equal(album.photoId, photoSpace.photoId, 'adding photos preserves the cover used for location markers');
  assert.equal((await run('drive.spacePhotos("space")')).length, 2);
  assert.ok(!(await run('drive.readEntries()')).some(record => record.name === '側面'));
  const rotated = await run('drive.save({...photoSpace, photo:new Blob(["rotated"]), replaceCover:true, coverTransform:[0,1,-1,0,1,0]})');
  assert.equal(rotated.photoId, photoSpace.photoId);
  assert.deepEqual(Array.from(rotated.coverTransform), [0, 1, -1, 0, 1, 0]);
  const oldAlbumIds = (await run('drive.spacePhotos("space")')).map(file => file.id);
  context.oldSpace = rotated;
  const replacement = await run('drive.save({...oldSpace, photoRemoved:true, coverTransform:undefined, photo:new Blob(["new cover"]), extraPhotos:[{name:"新近照",photo:new Blob(["new close"])}]})');
  assert.notEqual(replacement.photoId, rotated.photoId);
  assert.equal(files.get(rotated.photoId).trashed, true);
  assert.ok(oldAlbumIds.every(id => files.get(id).trashed));
  assert.deepEqual(Array.from(await run('drive.spacePhotos("space")'), file => file.name), ['新近照.jpg']);
  const original = (await run('drive.readEntries()')).find(entry => entry.id === 'direct');
  context.moveOriginal = original;
  const moved = await run('drive.moveItem(moveOriginal, {id:"cabinet"})');
  assert.equal(moved.id, original.id);
  assert.equal(moved.parent, 'cabinet');
  assert.equal(moved.hasPhoto, true);
  const retried = await run('drive.moveItem(moveOriginal, {id:"cabinet"})');
  assert.equal(retried.parent, 'cabinet');

  const quota = await run('drive.quota()');
  assert.equal(quota.usage, '1024');
  assert.equal(quota.limit, '2048');
});
