import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { SourceClient } from '../src/transport.mjs';
import { Catalog } from '../src/catalog.mjs';
import { runHarvest, canonicalEntry, capabilitiesPathFor } from '../src/harvest.mjs';
import { startApplication } from '../src/app.mjs';

const root = '/csw?service=CSW&request=GetRecords';

test('跨目录领取保留各站能力、委托路径与独立标识空间，同号 identifier 不合并', async () => {
  const source = await startSource({ scenario: 'federation' });
  try {
    const report = await runHarvest({ client: new SourceClient(source.base), roots: [root],
      conditions: { anyText: '研学线路', bbox: '116,39,117,40' }, hopBudget: 2 });

    const byEntry = Object.fromEntries(report.coverage.map(item => [item.entry, item]));
    assert.deepEqual(Object.keys(byEntry), ['/csw', '/regional/csw', '/county-a/csw']);

    // 能力文档中的记录类型与返回模式被原样保留。
    assert.deepEqual(byEntry['/csw'].capability.typeNames, ['csw:Record']);
    assert.deepEqual(byEntry['/csw'].capability.elementSetNames, ['brief', 'full']);
    assert.equal(byEntry['/regional/csw'].capability.retrieval.mode, 'record-link');
    assert.equal(byEntry['/csw'].capability.retrieval.mode, 'csw-getrecordbyid');

    // 委托链路逐跳留痕，且不把 matched 相加。
    assert.deepEqual(byEntry['/regional/csw'].via, ['/csw']);
    assert.deepEqual(byEntry['/county-a/csw'].via, ['/csw']);
    assert.equal(byEntry['/csw'].search.matched, 2);
    assert.equal(byEntry['/regional/csw'].search.matched, null);

    // 同一 identifier 出现在三个机构入口下，按 入口#identifier 各自独立保留。
    const shared = report.sharedIdentifiers.find(item => item.identifier === 'route-map-1');
    assert.ok(shared);
    assert.equal(shared.entries.length, 3);
    const routeMapRecords = report.records.filter(item => item.identifier === 'route-map-1');
    assert.equal(routeMapRecords.length, 3);
    assert.deepEqual([...new Set(routeMapRecords.map(item => item.entry))].sort(),
      ['/county-a/csw', '/csw', '/regional/csw']);
    assert.equal(report.totals.distinctRecords, 5);

    // 完整元数据按各来源支持的标识与领取方式取回，并落到内容摘要目录。
    for (const record of report.records) assert.equal(record.full.status, 'retrieved');
    const fullPaths = routeMapRecords.map(item => item.full.requestPath);
    assert.ok(fullPaths.some(path => path.startsWith('/csw?') && path.includes('GetRecordById')));
    assert.ok(fullPaths.includes('/records/route-map-1'));
    assert.ok(fullPaths.includes('/county-a/records/route-map-1'));
  } finally { await source.close(); }
});

test('complete:false、异常报告和断连都显式登记，绝不折算成空结果', async () => {
  const source = await startSource({ scenario: 'federation' });
  try {
    const report = await runHarvest({ client: new SourceClient(source.base),
      roots: [root, '/void/csw', '/broken/csw'], hopBudget: 2 });
    const byEntry = Object.fromEntries(report.coverage.map(item => [item.entry, item]));

    assert.equal(byEntry['/regional/csw'].search.status, 'incomplete');
    assert.equal(byEntry['/regional/csw'].search.exceptionReports[0].catalog, 'county-b');
    assert.equal(byEntry['/void/csw'].search.status, 'exception');
    assert.match(byEntry['/void/csw'].search.exceptionReports[0].code, /NoApplicableCode/);
    assert.equal(byEntry['/broken/csw'].search.status, 'unreachable');

    const kinds = report.uncertainties.map(item => item.kind);
    assert.ok(kinds.includes('incomplete-delegation'));
    assert.ok(kinds.includes('exception-report'));
    assert.ok(kinds.includes('unreachable'));

    // 异常/断连目录不产生命中，但它们的状态是 exception/unreachable，而不是“命中 0 条”的成功空集。
    assert.equal(byEntry['/void/csw'].recordKeys.length, 0);
    assert.equal(byEntry['/broken/csw'].recordKeys.length, 0);
    assert.ok(!report.coverage.some(item => item.search.status === 'covered'
      && item.search.returned === 0 && !report.uncertainties.some(u => u.entry === item.entry)));
  } finally { await source.close(); }
});

test('委托回路按入口截断止境，重复出现的入口不重复检索也不记空集', async () => {
  const source = await startSource();
  try {
    const report = await runHarvest({ client: new SourceClient(source.base), roots: [root], hopBudget: 2 });
    const byEntry = Object.fromEntries(report.coverage.map(item => [item.entry, item]));
    assert.deepEqual(Object.keys(byEntry).sort(), ['/csw', '/regional/csw']);

    const loop = report.uncertainties.find(item => item.kind === 'loop-cut');
    assert.ok(loop);
    assert.equal(loop.entry, '/csw');
    assert.deepEqual(loop.via, ['/csw', '/regional/csw']);

    // 回路中的根目录仍保留首次真实检索的命中，而不是被第二次出现覆盖成空结果。
    assert.equal(byEntry['/csw'].search.status, 'covered');
    assert.equal(byEntry['/csw'].search.returned, 1);
  } finally { await source.close(); }
});

test('跳数预算之外的子目录标记 hop-limit 不确定，而不是静默跳过', async () => {
  const source = await startSource({ scenario: 'federation' });
  try {
    const report = await runHarvest({ client: new SourceClient(source.base), roots: [root], hopBudget: 0 });
    const entries = report.coverage.map(item => item.entry);
    assert.deepEqual(entries, ['/csw']);
    const cuts = report.uncertainties.filter(item => item.kind === 'hop-limit')
      .map(item => item.entry).sort();
    assert.deepEqual(cuts, ['/county-a/csw', '/regional/csw'].sort());
    assert.deepEqual(report.uncertainties.find(item => item.entry === '/county-a/csw').via, ['/csw']);
  } finally { await source.close(); }
});

test('遍历状态按次查询独立：被上次查询访问过的目录仍按本次条件重新检索', async () => {
  const source = await startSource({ scenario: 'transition' });
  const client = new SourceClient(source.base);
  try {
    const first = await runHarvest({ client, roots: [root], conditions: { anyText: '第一次条件' }, hopBudget: 1 });
    const second = await runHarvest({ client, roots: [root], conditions: { anyText: '第二次条件' }, hopBudget: 1 });
    assert.notDeepEqual(first.id, second.id);
    // 两次查询各自独立覆盖根目录，第二次没有因为缓存访问而跳过。
    assert.equal(first.coverage[0].search.requestPath.includes('anyText'), true);
    assert.match(second.coverage[0].search.requestPath, /anyText=%E7%AC%AC%E4%BA%8C%E6%AC%A1%E6%9D%A1%E4%BB%B6/);
    const inspect = await client.control({ action: 'inspect' });
    const rootRequests = inspect.requests.filter(item => item.path.startsWith('/csw'));
    assert.ok(rootRequests.length >= 4);
    assert.deepEqual([...new Set(rootRequests.map(item => item.phase))], [0]);
  } finally { await source.close(); }
});

test('完整件按来源声明的模式领取，失败与不支持都进入不确定清单', async () => {
  const source = await startSource({ scenario: 'federation' });
  const directory = await mkdtemp(join(tmpdir(), 'harvest-cat-'));
  try {
    const catalog = await new Catalog(directory).initialize();
    const report = await runHarvest({ client: new SourceClient(source.base), roots: [root],
      hopBudget: 2, catalog });
    const persisted = report.records.filter(item => item.full.status === 'retrieved');
    assert.equal(persisted.length, 5);
    // 每份完整原件都有独立接收凭据，且可按摘要回读。
    for (const record of persisted) {
      const bytes = await catalog.object(record.full.digest);
      assert.equal(bytes.length, record.full.bytes);
      const receipt = (await catalog.list()).find(item => item.id === record.full.receiptId);
      assert.equal(receipt.preview.entry, record.entry);
      assert.equal(receipt.preview.identifier, record.identifier);
    }
    // 报告本身可持久化并在重开目录后回读。
    await catalog.saveHarvest(report);
    const reopened = await new Catalog(directory).harvestReport(report.id);
    assert.equal(reopened.totals.distinctRecords, 5);
  } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('应用提供跨目录领取入口，并可按编号回查覆盖与不确定项', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harvest-app-'));
  const source = await startSource({ scenario: 'federation' });
  const app = await startApplication({ source: source.base, root: directory });
  try {
    const response = await fetch(`${app.base}/harvests`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conditions: { anyText: '研学' }, hopBudget: 2 })
    });
    assert.equal(response.status, 201);
    const report = await response.json();
    assert.equal(report.coverage.length, 3);
    assert.ok(report.uncertainties.some(item => item.kind === 'incomplete-delegation'));

    const listed = await fetch(`${app.base}/harvests`).then(item => item.json());
    assert.equal(listed.length, 1);
    const single = await fetch(`${app.base}/harvests/${report.id}`).then(item => item.json());
    assert.equal(single.id, report.id);
    const bad = await fetch(`${app.base}/harvests/not-an-id`);
    assert.equal(bad.status, 422);
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('入口规范化忽略查询参数，能力入口按同目录约定推导', () => {
  assert.equal(canonicalEntry('/csw?service=CSW&request=GetRecords'), '/csw');
  assert.equal(canonicalEntry('/regional/csw'), '/regional/csw');
  assert.equal(capabilitiesPathFor('/csw?service=CSW&request=GetRecords'), '/capabilities');
  assert.equal(capabilitiesPathFor('/county-a/csw'), '/county-a/capabilities');
});
