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

  const created = await fetch(`${app.base}/harvests`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conditions: { anyText: '研学线路' }, hopBudget: 2 })
  });
  if (created.status !== 201) throw new Error(`跨目录领取失败：${created.status}`);
  const report = await created.json();
  process.stdout.write('\n跨目录资料领取报告\n');
  process.stdout.write(`报告编号：${report.id}\n`);
  process.stdout.write('条件覆盖（各目录自报计数不相加）：\n');
  for (const item of report.coverage) {
    process.stdout.write(`- ${item.entry}（${item.name}）状态=${item.search.status} `
      + `深度=${item.depth} 委托链=${item.via.join(' -> ') || '根目录'} `
      + `matched=${item.search.matched ?? '不适用'} returned=${item.search.returned}\n`);
  }
  process.stdout.write(`同号 identifier 分属不同机构：${report.sharedIdentifiers.map(item => `${item.identifier} -> ${item.entries.join('、')}`).join('；') || '无'}\n`);
  process.stdout.write(`完整元数据：领取 ${report.totals.fullRetrieved} 份，失败 ${report.totals.fullFailed} 份，不支持 ${report.totals.retrievalUnsupported} 份\n`);
  process.stdout.write(`不确定项 ${report.uncertainties.length} 条（均不等同空结果）：\n`);
  for (const uncertainty of report.uncertainties) {
    process.stdout.write(`- [${uncertainty.kind}] ${uncertainty.entry}${uncertainty.via.length ? `（经 ${uncertainty.via.join(' -> ')}）` : ''}\n`);
  }
} finally {
  await app.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
