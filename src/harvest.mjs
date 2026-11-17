import { randomUUID } from 'node:crypto';
import { decode } from './decode.mjs';

const BASE = 'http://catalog.local';
const EXCEPTION_PATTERN = /<(?:[a-z][\w.-]*:)?ExceptionReport\b/i;

/** 服务入口身份只取来源源站与路径，查询参数不参与身份判定（标识空间由入口区分）。 */
export function canonicalEntry(path) {
  return new URL(path, BASE).pathname;
}

/** 能力文档约定为同目录下的 capabilities 入口，如 /csw -> /capabilities、/regional/csw -> /regional/capabilities。 */
export function capabilitiesPathFor(entryPath) {
  const url = new URL(entryPath, BASE);
  const parts = url.pathname.split('/');
  parts[parts.length - 1] = 'capabilities';
  url.pathname = parts.join('/');
  url.search = '';
  return url.pathname;
}

function withConditions(path, conditions) {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(conditions || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  url.searchParams.sort();
  return url.pathname + url.search;
}

async function safeRequest(client, path) {
  try {
    return await client.request(path);
  } catch (error) {
    return { transportError: error, status: 0, headers: {}, bytes: Buffer.alloc(0), url: path };
  }
}

function parseExceptionReport(text, httpStatus) {
  const code = /exceptionCode="([^"]+)"/.exec(text)?.[1]
    || /<[\w.-]+:Exception\b[^>]*code="([^"]+)"/.exec(text)?.[1]
    || 'Unspecified';
  return { httpStatus, code, excerpt: text.slice(0, 300) };
}

function retrievalPath(retrieval, identifier, entryPath) {
  if (retrieval?.mode === 'csw-getrecordbyid') {
    const url = new URL(retrieval.path || entryPath, BASE);
    url.search = '';
    url.searchParams.set('service', 'CSW');
    url.searchParams.set('request', 'GetRecordById');
    url.searchParams.set('id', identifier);
    url.searchParams.set('elementsetname', retrieval.elementSetName || 'full');
    return url.pathname + url.search;
  }
  if (retrieval?.mode === 'record-link') {
    const template = retrieval.pathTemplate || '/records/{identifier}';
    return template.replace('{identifier}', encodeURIComponent(identifier));
  }
  return null;
}

/**
 * 一次跨目录资料领取。
 * 关键约束：
 * - 遍历状态每次调用独立构建，上次查询访问过的目录不会跳过本次条件下的检索；
 * - 委托回路按服务入口截断并登记 uncertainty，不重复发请求，也不把被截断目录视为空结果；
 * - complete:false、异常报告、断连、跳数超限各自显式登记，绝不折算成“命中 0 条”；
 * - 命中计数只保留各来源自报值，不跨目录相加；记录身份为 服务入口 + identifier。
 */
export async function runHarvest({ client, roots, conditions = {}, hopBudget = 2, full = true, catalog } = {}) {
  if (!client || typeof client.request !== 'function') throw new TypeError('缺少来源客户端');
  if (!Array.isArray(roots) || roots.length === 0) throw new TypeError('至少需要一个根目录入口');
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const coverage = new Map();
  const records = new Map();
  const uncertainties = [];
  const queue = roots.map(path => ({ path, depth: 0, via: [] }));
  let effectiveBudget = hopBudget;
  const addUncertainty = uncertainty => uncertainties.push({
    id: randomUUID(), at: new Date().toISOString(), ...uncertainty
  });

  while (queue.length) {
    const job = queue.shift();
    const key = canonicalEntry(job.path);

    if (coverage.has(key)) {
      addUncertainty({ kind: 'loop-cut', entry: key, depth: job.depth, via: job.via,
        detail: '委托回路在本次查询内截断：该目录已按本次条件检索过，不再重复请求' });
      continue;
    }
    if (job.depth > effectiveBudget) {
      addUncertainty({ kind: 'hop-limit', entry: key, depth: job.depth, via: job.via,
        detail: `超出委托跳数预算 ${effectiveBudget}，该目录本次未检索` });
      continue;
    }

    const entry = {
      entry: key, name: key, depth: job.depth, via: job.via, kind: null,
      capability: { ok: false },
      search: { status: 'unreachable', requestPath: null, matched: null, returned: 0,
        nextRecord: null, exceptionReports: [] },
      recordKeys: []
    };
    coverage.set(key, entry);

    // 第一步：读取该站支持的记录类型、返回模式与完整件领取方式。
    const capPath = capabilitiesPathFor(job.path);
    const capResponse = await safeRequest(client, capPath);
    let capability = null;
    if (!capResponse.transportError && capResponse.status === 200) {
      try {
        capability = JSON.parse(capResponse.bytes.toString('utf8'));
        entry.capability = {
          ok: true, path: capPath,
          typeNames: capability.typeNames ?? [],
          elementSetNames: capability.elementSetNames ?? [],
          outputSchemas: capability.outputSchemas ?? [],
          retrieval: capability.recordRetrieval ?? null,
          delegates: capability.delegates ?? [],
          hopCount: capability.hopCount ?? null
        };
        if (capability.hopCount != null && job.depth === 0) {
          // 委托跳数预算由根目录能力文档声明；下游站点只登记自己的上限，不改写本次预算。
          effectiveBudget = Math.min(effectiveBudget, Number(capability.hopCount));
        }
      } catch (error) {
        entry.capability = { ok: false, path: capPath, reason: error.message };
        addUncertainty({ kind: 'capability-failed', entry: key, via: job.via, detail: error.message });
      }
    } else {
      const reason = capResponse.transportError ? capResponse.transportError.message : `HTTP ${capResponse.status}`;
      entry.capability = { ok: false, path: capPath, reason };
      addUncertainty({ kind: 'capability-failed', entry: key, via: job.via, detail: reason });
    }
    entry.name = capability?.catalog || capability?.name
      || key.split('/').filter(Boolean).at(-1) || 'root';

    // 第二步：按本次条件执行检索。
    const searchPath = withConditions(job.path, conditions);
    entry.search.requestPath = searchPath;
    const response = await safeRequest(client, searchPath);
    if (response.transportError) {
      entry.search.status = 'unreachable';
      entry.search.reason = response.transportError.message;
      addUncertainty({ kind: 'unreachable', entry: key, via: job.via, detail: response.transportError.message });
      continue;
    }
    const text = response.bytes.toString('utf8');
    const contentType = response.headers['content-type'] || '';
    if (response.status >= 400 || EXCEPTION_PATTERN.test(text)) {
      const report = parseExceptionReport(text, response.status);
      entry.search.status = 'exception';
      entry.search.exceptionReports.push(report);
      addUncertainty({ kind: 'exception-report', entry: key, via: job.via, detail: report });
      continue;
    }

    let view = null;
    if (contentType.includes('json') || text.trimStart().startsWith('{')) {
      entry.kind = 'json-debug';
      try {
        view = JSON.parse(text);
      } catch (error) {
        entry.search.status = 'exception';
        entry.search.exceptionReports.push({ httpStatus: response.status, code: 'UnparseableView', excerpt: error.message });
        addUncertainty({ kind: 'exception-report', entry: key, via: job.via, detail: error.message });
        continue;
      }
      const brief = Array.isArray(view.records) ? view.records : [];
      entry.search.returned = brief.length;
      const mode = 'brief';
      for (const record of brief) {
        addRecord(records, entry, key, job, record.identifier, record.title, mode);
      }
      entry.search.status = view.complete === false ? 'incomplete' : 'covered';
      for (const exception of view.exceptions ?? []) {
        entry.search.exceptionReports.push(exception);
        addUncertainty({ kind: 'exception-report', entry: key, via: job.via, detail: exception });
      }
      if (view.complete === false) {
        addUncertainty({ kind: 'incomplete-delegation', entry: key, via: job.via,
          detail: '网关声明仅转回部分子站或存在未完成委托，不能视为完整空结果',
          exceptions: view.exceptions ?? [] });
      }
    } else {
      let preview;
      try {
        preview = decode(response.bytes);
      } catch (error) {
        entry.search.status = 'exception';
        entry.search.exceptionReports.push({ httpStatus: response.status, code: 'UnparseableRecord', excerpt: error.message });
        addUncertainty({ kind: 'exception-report', entry: key, via: job.via, detail: error.message });
        continue;
      }
      entry.kind = 'xml-csw';
      entry.search.status = 'covered';
      entry.search.matched = preview.matched;
      entry.search.returned = preview.returned;
      entry.search.nextRecord = preview.nextRecord;
      const mode = /<csw:BriefRecord\b/.test(text) ? 'brief' : 'full';
      for (const record of preview.records) {
        addRecord(records, entry, key, job, record.identifier, record.title, mode);
      }
    }

    // 第三步：登记委托关系（能力文档与调试视图中的委托取并集），继续跨目录遍历。
    const delegates = [...new Set([
      ...(capability?.delegates ?? []),
      ...(view?.delegates ?? [])
    ])];
    for (const delegate of delegates) {
      const target = new URL(delegate, BASE);
      queue.push({ path: target.pathname + target.search, depth: job.depth + 1, via: [...job.via, key] });
    }
  }

  // 第四步：按各来源自己支持的标识与领取方式取回完整元数据。
  for (const record of records.values()) {
    const owner = coverage.get(record.entry);
    const retrieval = owner?.capability.ok ? owner.capability.retrieval : null;
    if (!full) {
      record.full = { status: 'skipped' };
      continue;
    }
    if (!retrieval) {
      record.full = { status: 'unsupported' };
      addUncertainty({ kind: 'retrieval-unsupported', entry: record.entry, via: record.via,
        identifier: record.identifier, detail: '该站能力文档未声明完整记录领取方式' });
      continue;
    }
    const path = retrievalPath(retrieval, record.identifier, record.entry);
    if (!path) {
      record.full = { status: 'unsupported' };
      addUncertainty({ kind: 'retrieval-unsupported', entry: record.entry, via: record.via,
        identifier: record.identifier, detail: `未知领取模式 ${retrieval.mode}` });
      continue;
    }
    const response = await safeRequest(client, path);
    if (response.transportError || response.status >= 400
        || EXCEPTION_PATTERN.test(response.bytes.toString('utf8'))) {
      const reason = response.transportError ? response.transportError.message
        : parseExceptionReport(response.bytes.toString('utf8'), response.status);
      record.full = { status: 'failed', requestPath: path, reason };
      addUncertainty({ kind: 'retrieval-failed', entry: record.entry, via: record.via,
        identifier: record.identifier, detail: reason });
      continue;
    }
    const source = new URL(path, client.base).href;
    const provenance = { kind: 'full-record', harvestId: id, entry: record.entry,
      identifier: record.identifier, retrievalMode: retrieval.mode };
    if (catalog) {
      const receipt = await catalog.accept({ source, bytes: response.bytes,
        mediaType: response.headers['content-type'] || 'application/octet-stream',
        preview: provenance });
      record.full = { status: 'retrieved', requestPath: path, retrievalMode: retrieval.mode,
        digest: receipt.digest, receiptId: receipt.id, mediaType: receipt.mediaType, bytes: receipt.bytes };
    } else {
      record.full = { status: 'retrieved', requestPath: path, retrievalMode: retrieval.mode,
        mediaType: response.headers['content-type'] || 'application/octet-stream',
        bytes: response.bytes.length, persisted: false };
    }
  }

  const identifierOwners = new Map();
  for (const record of records.values()) {
    if (!identifierOwners.has(record.identifier)) identifierOwners.set(record.identifier, new Set());
    identifierOwners.get(record.identifier).add(record.entry);
  }
  const sharedIdentifiers = [...identifierOwners.entries()]
    .filter(([, entries]) => entries.size > 1)
    .map(([identifier, entries]) => ({ identifier, entries: [...entries] }));

  const coverageList = [...coverage.values()];
  const countStatus = status => coverageList.filter(item => item.search.status === status).length;
  const fullStatuses = [...records.values()].map(item => item.full?.status);
  return {
    id,
    startedAt,
    finishedAt: new Date().toISOString(),
    conditions,
    roots,
    hopBudget: effectiveBudget,
    coverage: coverageList,
    records: [...records.values()],
    sharedIdentifiers,
    uncertainties,
    totals: {
      queriedCatalogs: coverageList.length,
      covered: countStatus('covered'),
      incomplete: countStatus('incomplete'),
      exception: countStatus('exception'),
      unreachable: countStatus('unreachable'),
      distinctRecords: records.size,
      fullRetrieved: fullStatuses.filter(status => status === 'retrieved').length,
      fullFailed: fullStatuses.filter(status => status === 'failed').length,
      retrievalUnsupported: fullStatuses.filter(status => status === 'unsupported').length,
      uncertaintyCount: uncertainties.length
    },
    note: 'matched/returned 为各目录自报计数，不跨目录相加；记录身份由服务入口与 identifier 共同确定'
  };
}

function addRecord(records, entry, entryKey, job, identifier, title, mode) {
  if (!identifier) return;
  const key = `${entryKey}#${identifier}`;
  if (records.has(key)) return;
  records.set(key, {
    key, entry: entryKey, name: entry.name, identifier, title: title ?? null,
    mode, via: [...job.via], full: { status: 'pending' }
  });
  entry.recordKeys.push(key);
}
