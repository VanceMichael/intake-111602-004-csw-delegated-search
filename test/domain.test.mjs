import test from 'node:test';
import assert from 'node:assert/strict';
import { startSource } from '../source/service.mjs';
import { SourceClient } from '../src/transport.mjs';
import { decode } from '../src/decode.mjs';

test('委托目录保留回路与独立标识空间，不把局部异常当空集', async () => {
  const source = await startSource({ scenario: 'transition' });
  try {
    const client = new SourceClient(source.base);
    const gateway = decode((await client.request('/csw?request=GetRecords&service=CSW')).bytes);
    const regional = JSON.parse((await client.request('/regional/csw')).bytes);
    assert.equal(gateway.records[0].identifier, regional.records[0].identifier);
    assert.equal(regional.complete, false);
    assert.equal(regional.exceptions.length, 1);
    assert.ok(regional.delegates[0].startsWith('/csw'));
    await client.control({ action: 'advance' });
    assert.equal(JSON.parse((await client.request('/regional/csw')).bytes).complete, true);
  } finally { await source.close(); }
});
