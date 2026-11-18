import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-'));
const source = await startSource();
const app = await startApplication({ source: source.base, root: directory });
try {
  const preview = await fetch(`${app.base}/preview`).then(response => response.json());
  process.stdout.write(`当前资料预览\n${JSON.stringify(preview, null, 2)}\n`);
  const saved = await fetch(`${app.base}/receipts`, { method: 'POST', body: '{}' }).then(response => response.json());
  const body = await fetch(`${app.base}/objects/${saved.digest}`).then(response => response.arrayBuffer());
  if (body.byteLength !== saved.bytes) throw new Error('原始资料长度不符');
  process.stdout.write(`原件已接收：${saved.digest}，${saved.bytes} 字节\n`);

  const harvestResponse = await fetch(`${app.base}/harvest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  if (harvestResponse.status !== 201) throw new Error(`跨目录领取失败：${harvestResponse.status}`);
  const report = await harvestResponse.json();
  process.stdout.write('\n跨目录资料领取报告（不做命中数相加）\n');
  for (const node of report.coverage.nodes) {
    process.stdout.write(`- 目录 ${node.entry}：状态=${node.status}，返回模式=${node.capabilities.returnMode}，`
      + `简报=${node.search.records.length}，异常=${node.exceptions.length}\n`);
  }
  for (const edge of report.coverage.edges) {
    if (edge.outcome !== 'followed') process.stdout.write(`- 委托止境：${edge.via} -> ${edge.outcome}\n`);
  }
  process.stdout.write(`领取完成 ${report.totals.claimsAccepted} 份，失败/不支持 ${report.totals.claimsFailed} 份，`
    + `不确定项 ${report.totals.uncertainties} 条，报告标识 ${report.id}\n`);
  const persisted = await fetch(`${app.base}/harvests/${report.id}`).then(response => response.json());
  if (persisted.id !== report.id) throw new Error('领取报告未能回查');
} finally {
  await app.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
