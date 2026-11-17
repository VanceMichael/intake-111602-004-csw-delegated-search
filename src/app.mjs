import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Catalog } from './catalog.mjs';
import { decode } from './decode.mjs';
import { runHarvest } from './harvest.mjs';
import { SourceClient } from './transport.mjs';
import { profile } from './profile.mjs';

export async function previewOne(base, path = profile.previewPath) {
  const result = await new SourceClient(base).request(path);
  if (result.status !== 200) throw new Error(`来源响应：${result.status}`);
  return { ...result, preview: decode(result.bytes, result.headers) };
}

export async function startApplication({ source, root, port = 0 }) {
  const catalog = await new Catalog(root).initialize();
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true, product: profile.name }));
      if (request.method === 'GET' && url.pathname === '/preview') {
        const result = await previewOne(source, url.searchParams.get('path') || profile.previewPath);
        return response.end(JSON.stringify({ source: result.url, preview: result.preview }));
      }
      if (request.method === 'POST' && url.pathname === '/receipts') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks));
        const result = await previewOne(source, input.path || profile.previewPath);
        const receipt = await catalog.accept({ source: result.url, bytes: result.bytes,
          mediaType: result.headers['content-type'], preview: result.preview });
        response.statusCode = 201;
        return response.end(JSON.stringify(receipt));
      }
      if (request.method === 'GET' && url.pathname === '/receipts') return response.end(JSON.stringify(await catalog.list()));
      if (request.method === 'GET' && url.pathname.startsWith('/objects/')) {
        response.setHeader('content-type', 'application/octet-stream');
        return response.end(await catalog.object(url.pathname.split('/').at(-1)));
      }
      if (request.method === 'POST' && url.pathname === '/harvests') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const roots = Array.isArray(input.roots) && input.roots.length ? input.roots : profile.harvestRoots;
        const report = await runHarvest({ client: new SourceClient(source), roots,
          conditions: input.conditions || {}, hopBudget: Number.isFinite(input.hopBudget) ? input.hopBudget : 2,
          full: input.full !== false, catalog });
        await catalog.saveHarvest(report);
        response.statusCode = 201;
        return response.end(JSON.stringify(report));
      }
      if (request.method === 'GET' && url.pathname === '/harvests') {
        return response.end(JSON.stringify(await catalog.listHarvests()));
      }
      if (request.method === 'GET' && url.pathname.startsWith('/harvests/')) {
        const report = await catalog.harvestReport(url.pathname.split('/').at(-1));
        return response.end(JSON.stringify(report));
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: '没有此操作' }));
    } catch (error) {
      response.statusCode = 422;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, catalog,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startApplication({ source: process.env.SOURCE_URL || 'http://127.0.0.1:4310',
    root: process.env.DATA_DIR || './var', port: Number(process.env.PORT || 4320) });
  process.stdout.write(`资料查看服务已启动：${app.base}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
