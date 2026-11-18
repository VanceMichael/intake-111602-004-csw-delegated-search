import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog } from '../src/catalog.mjs';
import { SourceClient } from '../src/transport.mjs';
import { Harvester, parseCapabilities, parseSearchResponse } from '../src/federation.mjs';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';

function startIsolatedJsonGateway() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('content-type', 'application/json');
    if (url.pathname !== '/catalog') { response.writeHead(404); return response.end(JSON.stringify({ error: 'not found' })); }
    response.end(JSON.stringify({
      catalog: 'isolated', delegates: [], complete: true, exceptions: [],
      records: [{ identifier: 'lonely-1', title: '孤立目录资料' }]
    }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ base: `http://127.0.0.1:${address.port}`,
        close: () => new Promise(done => server.close(done)) });
    });
  });
}

async function withWorkspace(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'federation-test-'));
  const source = await startSource({ scenario: 'federation' });
  const app = await startApplication({ source: source.base, root: directory });
  try {
    await callback({ directory, source, app });
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
}

async function postHarvest(app, body = {}) {
  const response = await fetch(`${app.base}/harvest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, report: await response.json() };
}

const pathOf = value => value ? new URL(value, 'http://placeholder.local').pathname : null;

test('先读取各站记录类型与返回模式，再沿委托树逐站检索并保留来源', async () => {
  await withWorkspace(async ({ app }) => {
    const { status, report } = await postHarvest(app);
    assert.equal(status, 201);
    const nodes = Object.fromEntries(report.coverage.nodes.map(node => [node.entry, node]));
    const root = nodes['/csw'];
    assert.equal(root.capabilities.status, 'declared');
    assert.deepEqual(root.capabilities.typeNames, ['csw:Record', 'gmd:MD_Metadata']);
    assert.equal(root.capabilities.returnMode, 'brief+summary+full');
    assert.equal(root.search.pages[0].mode, 'xml');
    const leaf = nodes['/leaf/csw'];
    assert.equal(leaf.capabilities.status, 'embedded');
    assert.equal(leaf.capabilities.returnMode, 'json');
    assert.equal(leaf.search.pages[0].mode, 'json');
    const via = report.coverage.edges.map(edge => [pathOf(edge.from), edge.via, edge.outcome]);
    assert.deepEqual(via, [
      [null, '/csw?service=CSW&request=GetRecords', 'followed'],
      ['/csw', '/branch/csw', 'followed'],
      ['/branch/csw', '/leaf/csw', 'followed'],
      ['/leaf/csw', '/orphan/csw', 'followed']
    ]);
  });
});

test('真正空目录与部分覆盖/异常严格区分，异常不得当作空结果', async () => {
  await withWorkspace(async ({ app }) => {
    const { report } = await postHarvest(app);
    const statusByName = Object.fromEntries(report.coverage.nodes.map(node => [node.entry, node.status]));
    assert.equal(statusByName['/branch/csw'], 'empty');
    assert.equal(statusByName['/leaf/csw'], 'incomplete');
    assert.equal(statusByName['/orphan/csw'], 'complete');
    const leaf = report.coverage.nodes.find(node => node.entry === '/leaf/csw');
    assert.equal(leaf.search.truncated, true);
    assert.deepEqual(leaf.exceptions.map(item => item.code), ['NoApplicableCode']);
    assert.ok(report.uncertainties.some(item => item.code === 'subordinate-exception' && item.catalog === 'county-x'));
    const branch = report.coverage.nodes.find(node => node.entry === '/branch/csw');
    assert.equal(branch.search.records.length, 0);
    assert.equal(branch.complete, true);
    assert.equal(report.uncertainties.filter(item => item.catalog === branch.key).length, 0);
  });
});

test('相同 identifier 按来源机构区分，完整元数据按来源支持的标识分别领取', async () => {
  const source = await startSource();
  const directory = await mkdtemp(join(tmpdir(), 'federation-ids-'));
  const app = await startApplication({ source: source.base, root: directory });
  try {
    const { report } = await postHarvest(app);
    const briefSources = [...new Set(report.claims.map(item => pathOf(item.briefSource)))];
    assert.deepEqual(briefSources.sort(), ['/csw', '/regional/csw']);
    const sameIdentifier = report.claims.filter(item => item.identifier === 'route-map-1');
    assert.equal(sameIdentifier.length, 2);
    assert.notEqual(sameIdentifier[0].receiptId, sameIdentifier[1].receiptId);
    assert.equal(sameIdentifier[0].digest, sameIdentifier[1].digest);
    const delegated = sameIdentifier.find(item => item.delegatedClaim === true);
    const direct = sameIdentifier.find(item => item.delegatedClaim === false);
    assert.ok(delegated);
    assert.ok(direct);
    assert.match(delegated.requested, /GetRecordById/);
    const receipts = await app.catalog.list();
    const provenance = receipts.map(item => pathOf(item.preview.briefSource));
    assert.deepEqual(provenance.sort(), ['/csw', '/regional/csw']);
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('委托回路有止境：回路被记录为 loop，不沿回路无限转发', async () => {
  const source = await startSource();
  const directory = await mkdtemp(join(tmpdir(), 'federation-loop-'));
  try {
    const client = new SourceClient(source.base);
    const harvester = new Harvester(client, { catalog: new Catalog(directory) });
    const report = await harvester.runHarvest();
    const loop = report.coverage.edges.filter(edge => edge.outcome === 'loop');
    assert.equal(loop.length, 1);
    assert.match(loop[0].via, /\/csw/);
    assert.equal(loop[0].depth, 2);
    const followed = report.coverage.edges.filter(edge => edge.outcome === 'followed');
    assert.equal(followed.length, 2);
    assert.ok(report.uncertainties.some(item => item.code === 'delegation-loop'));
  } finally {
    await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('hopCount 上限截断更深目录，并明确标记不确定而不是静默忽略', async () => {
  await withWorkspace(async ({ app }) => {
    const { report } = await postHarvest(app, { hopLimit: 1 });
    assert.equal(report.hopLimit, 1);
    const keys = report.coverage.nodes.map(node => node.entry);
    assert.ok(keys.includes('/csw'));
    assert.ok(keys.includes('/branch/csw'));
    assert.ok(!keys.includes('/leaf/csw'));
    const cut = report.coverage.edges.find(edge => edge.outcome === 'hop-limit');
    assert.ok(cut);
    assert.equal(cut.via, '/leaf/csw');
    assert.ok(report.uncertainties.some(item => item.code === 'hop-limit'));
  });
});

test('来源声明的 hopCount 只能收紧默认上限，显式请求参数优先', async () => {
  await withWorkspace(async ({ app }) => {
    const defaultRun = await postHarvest(app);
    assert.equal(defaultRun.report.hopLimit, 3);
    const wider = await postHarvest(app, { hopLimit: 8 });
    assert.equal(wider.report.hopLimit, 8);
    assert.ok(wider.report.coverage.nodes.map(node => node.entry).includes('/orphan/csw'));
  });
});

test('每次领取都重新检索：目录曾被上一次查询访问，不跳过它对本次条件的检索', async () => {
  await withWorkspace(async ({ app, source }) => {
    const first = await postHarvest(app);
    assert.equal(first.report.condition, null);
    const second = await postHarvest(app, { condition: 'region:north' });
    assert.equal(second.report.condition, 'region:north');
    assert.equal(second.report.coverage.nodes.length, first.report.coverage.nodes.length);
    for (const node of second.report.coverage.nodes) {
      assert.ok(node.search.pages.some(page => page.path.includes('constraint=region%3Anorth')),
        `${node.entry} 未按本次条件重新检索`);
    }
    const inspect = await new SourceClient(source.base).control({ action: 'inspect' });
    const constrainedHits = inspect.requests.filter(item => item.path.includes('constraint=region%3Anorth'));
    assert.equal(constrainedHits.length, second.report.coverage.nodes.length);
  });
});

test('无领取入口的简报记录为 unsupported 并进入不确定项，不伪造完整元数据', async () => {
  const gateway = await startIsolatedJsonGateway();
  const directory = await mkdtemp(join(tmpdir(), 'federation-unsupported-'));
  try {
    const client = new SourceClient(gateway.base);
    const report = await new Harvester(client, { catalog: new Catalog(directory) })
      .runHarvest({ entryPath: '/catalog' });
    const unsupported = report.claims.find(item => item.identifier === 'lonely-1');
    assert.equal(unsupported.status, 'unsupported');
    assert.equal(unsupported.receiptId, null);
    assert.ok(report.uncertainties.some(item => item.code === 'claim-unsupported'
      && item.detail.identifier === 'lonely-1'));
    assert.equal((await new Catalog(directory).list()).length, 0);
  } finally {
    await gateway.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('委托树内的 JSON 视图节点可经 CSW 网关代领，并在凭据中标记委托关系', async () => {
  await withWorkspace(async ({ app }) => {
    const { report } = await postHarvest(app);
    const orphan = report.claims.find(item => item.identifier === 'fed-3');
    assert.equal(orphan.status, 'accepted');
    assert.equal(orphan.delegatedClaim, true);
    assert.match(orphan.requested, /\/csw\?.*GetRecordById/);
  });
});

test('报告持久化并可按标识回查，汇总只反映覆盖而不混合来源', async () => {
  await withWorkspace(async ({ app }) => {
    const { report } = await postHarvest(app);
    const listing = await fetch(`${app.base}/harvests`).then(response => response.json());
    assert.equal(listing.length, 1);
    assert.equal(listing[0].id, report.id);
    const reread = await fetch(`${app.base}/harvests/${report.id}`).then(response => response.json());
    assert.deepEqual(reread.coverage.nodes.length, report.coverage.nodes.length);
    assert.equal(reread.totals.nodesQueried, report.coverage.nodes.length);
    assert.equal(reread.totals.briefRecords,
      report.coverage.nodes.reduce((sum, node) => sum + node.search.records.length, 0));
    const bad = await fetch(`${app.base}/harvests/not%20a%20valid%20id`);
    assert.equal(bad.status, 422);
  });
});

test('分页无法继续时标记截断与不确定，不能把已返回页当成完整空结果', async () => {
  const source = await startSource();
  const directory = await mkdtemp(join(tmpdir(), 'federation-page-'));
  try {
    const report = await new Harvester(new SourceClient(source.base), { catalog: new Catalog(directory) }).runHarvest();
    const root = report.coverage.nodes.find(node => node.entry === '/csw');
    assert.equal(root.search.truncated, true);
    assert.equal(root.status, 'error');
    assert.ok(root.search.pages.some(page => page.path.includes('startPosition=2') && page.status === 404));
    assert.ok(report.uncertainties.some(item => item.code === 'search-http-error'));
  } finally {
    await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('解析器区分 JSON 视图与 CSW XML，complete:false 不被折算为空集', () => {
  const jsonView = parseSearchResponse(Buffer.from(JSON.stringify({
    catalog: 'x', records: [{ identifier: 'a' }], complete: false, exceptions: [{ catalog: 'y', code: 'E' }]
  })), { 'content-type': 'application/json' });
  assert.equal(jsonView.mode, 'json');
  assert.equal(jsonView.complete, false);
  assert.equal(jsonView.exceptions.length, 1);
  const xml = parseSearchResponse(Buffer.from(
    '<?xml version="1.0"?><csw:GetRecordsResponse xmlns:csw="http://www.opengis.net/cat/csw/2.0.2" xmlns:dc="http://purl.org/dc/elements/1.1/"><csw:SearchResults numberOfRecordsMatched="0" numberOfRecordsReturned="0" nextRecord="0"></csw:SearchResults></csw:GetRecordsResponse>'),
    { 'content-type': 'application/xml' });
  assert.equal(xml.mode, 'xml');
  assert.equal(xml.complete, true);
  assert.equal(xml.records.length, 0);
  const caps = parseCapabilities(Buffer.from(JSON.stringify({
    version: '2.0.2', typeNames: ['csw:Record'], elementSetNames: ['brief', 'full'], delegates: ['/d'], hopCount: 2
  })));
  assert.equal(caps.returnMode, 'brief+full');
  assert.equal(caps.hopCount, 2);
});
