import { createHash, randomUUID } from 'node:crypto';
import { decode } from './decode.mjs';
import { profile } from './profile.mjs';

/**
 * 一次跨目录领取的全部状态都保存在本次 Harvester 实例内：
 * 不使用模块级“已访问目录”缓存，因此同一目录在不同查询条件下仍会被重新检索。
 * 止境只针对本次条件形成的委托回路（visited 集合 + hopCount 上限）。
 */

const trimSlash = value => value.replace(/\/+$/, '');

export function nodeKeyOf(value, base) {
  const url = new URL(value, base);
  return url.origin + url.pathname;
}

function looksJson(bytes, headers) {
  const type = String(headers?.['content-type'] || '');
  if (type.includes('json')) return true;
  return bytes.toString('utf8').trimStart().startsWith('{');
}

export function parseSearchResponse(bytes, headers) {
  if (looksJson(bytes, headers)) {
    const body = JSON.parse(bytes.toString('utf8'));
    return {
      mode: 'json',
      records: Array.isArray(body.records) ? body.records.map(item => ({ identifier: item.identifier, title: item.title, raw: item })) : [],
      matched: typeof body.numberOfRecordsMatched === 'number' ? body.numberOfRecordsMatched
        : (Array.isArray(body.records) ? body.records.length : 0),
      returned: typeof body.numberOfRecordsReturned === 'number' ? body.numberOfRecordsReturned
        : (Array.isArray(body.records) ? body.records.length : 0),
      nextRecord: 0,
      complete: body.complete !== false,
      exceptions: Array.isArray(body.exceptions) ? body.exceptions : [],
      delegates: Array.isArray(body.delegates) ? body.delegates : [],
      catalog: body.catalog || null,
      raw: body
    };
  }
  const decoded = decode(bytes);
  return {
    mode: 'xml',
    records: decoded.records.map(item => ({ identifier: item.identifier, title: item.title, kind: item.kind })),
    matched: decoded.matched,
    returned: decoded.returned,
    nextRecord: decoded.nextRecord,
    complete: decoded.nextRecord === 0,
    exceptions: [],
    delegates: [],
    catalog: null,
    raw: decoded
  };
}

export function parseCapabilities(bytes) {
  const body = JSON.parse(bytes.toString('utf8'));
  return {
    version: body.version || null,
    typeNames: Array.isArray(body.typeNames) ? body.typeNames : [],
    elementSetNames: Array.isArray(body.elementSetNames) ? body.elementSetNames : [],
    returnMode: Array.isArray(body.elementSetNames) && body.elementSetNames.length ? body.elementSetNames.join('+') : 'unknown',
    delegates: Array.isArray(body.delegates) ? body.delegates : [],
    hopCount: Number.isInteger(body.hopCount) ? body.hopCount : null
  };
}

function withParameter(path, name, value) {
  const url = new URL(path, 'http://placeholder.local');
  url.searchParams.set(name, value);
  return url.pathname + url.search;
}

export class Harvester {
  constructor(client, { catalog = null, hopLimit = profile.harvest.hopLimit,
    maxPages = profile.harvest.maxPages, elementSet = profile.harvest.elementSet,
    explicitHopLimit = false } = {}) {
    if (!Number.isInteger(hopLimit) || hopLimit < 0) throw new RangeError('hopLimit 必须是非负整数');
    if (!Number.isInteger(maxPages) || maxPages < 1) throw new RangeError('maxPages 必须是正整数');
    this.client = client;
    this.catalog = catalog;
    this.hopLimit = hopLimit;
    this.explicitHopLimit = explicitHopLimit;
    this.maxPages = maxPages;
    this.elementSet = elementSet;
    this.visited = new Map();
    this.edges = [];
    this.uncertainties = [];
    this.claims = [];
  }

  addUncertainty({ code, catalog = null, message, detail = null }) {
    this.uncertainties.push({ code, catalog, message, detail });
  }

  async runHarvest({ entryPath = profile.previewPath, condition = null, capabilitiesPath = profile.capabilitiesPath } = {}) {
    const startedAt = new Date().toISOString();
    const id = randomUUID();
    await this.walk({ entryPath, condition, capabilitiesPath, depth: 0, from: null });
    this.markCswReachability();
    await this.claimAll(condition);
    const nodes = [...this.visited.values()];
    const totals = {
      nodesQueried: nodes.length,
      nodesComplete: nodes.filter(node => node.status === 'complete').length,
      nodesEmpty: nodes.filter(node => node.status === 'empty').length,
      nodesIncomplete: nodes.filter(node => node.status === 'incomplete').length,
      nodesError: nodes.filter(node => node.status === 'error' || node.status === 'unreachable').length,
      briefRecords: nodes.reduce((sum, node) => sum + node.search.records.length, 0),
      claimsAccepted: this.claims.filter(item => item.status === 'accepted').length,
      claimsFailed: this.claims.filter(item => item.status !== 'accepted').length,
      uncertainties: this.uncertainties.length
    };
    return {
      id,
      startedAt,
      finishedAt: new Date().toISOString(),
      entry: new URL(entryPath, this.client.base).href,
      condition,
      hopLimit: this.hopLimit,
      maxPages: this.maxPages,
      coverage: { nodes, edges: this.edges },
      claims: this.claims,
      uncertainties: this.uncertainties,
      totals
    };
  }

  async walk({ entryPath, condition, capabilitiesPath, depth, from }) {
    const key = nodeKeyOf(entryPath, this.client.base);
    const edgeBase = { from, to: key, via: entryPath, depth };
    const existing = this.visited.get(key);
    if (existing) {
      existing.reachedBy.push({ from, via: entryPath });
      this.edges.push({ ...edgeBase, outcome: 'loop' });
      this.addUncertainty({ code: 'delegation-loop', catalog: key,
        message: '委托路径回到已检索目录，已停止沿该回路继续转发', detail: { from, via: entryPath } });
      return existing;
    }
    if (depth > this.hopLimit) {
      this.edges.push({ ...edgeBase, outcome: 'hop-limit' });
      this.addUncertainty({ code: 'hop-limit', catalog: key,
        message: '委托深度超过本次允许的转发上限，未检索该目录', detail: { depth, hopLimit: this.hopLimit } });
      return null;
    }

    const node = {
      key,
      entry: new URL(entryPath, this.client.base).pathname,
      depth,
      reachedBy: [{ from, via: entryPath }],
      capabilities: { status: 'unknown', returnMode: 'unknown', typeNames: [], elementSetNames: [], delegates: [], hopCount: null },
      search: { requested: entryPath, pages: [], records: [], truncated: false },
      exceptions: [],
      complete: false,
      status: 'unreachable',
      delegates: []
    };
    this.visited.set(key, node);
    this.edges.push({ ...edgeBase, outcome: 'followed' });

    const isRoot = depth === 0;
    if (isRoot) await this.readRootCapabilities(node, capabilitiesPath);
    await this.searchNode(node, condition);
    for (const delegatePath of node.delegates) {
      try {
        await this.walk({ entryPath: delegatePath, condition, capabilitiesPath, depth: depth + 1, from: key });
      } catch (error) {
        this.edges.push({ from: key, to: null, via: delegatePath, depth: depth + 1, outcome: 'unresolved' });
        this.addUncertainty({ code: 'delegate-unreachable', catalog: delegatePath,
          message: '委托目录无法访问，不能视为空结果', detail: { reason: error.message } });
      }
    }
    return node;
  }

  async readRootCapabilities(node, capabilitiesPath) {
    try {
      const result = await this.client.request(capabilitiesPath);
      if (result.status !== 200) throw new Error(`capabilities 响应：${result.status}`);
      const parsed = parseCapabilities(result.bytes);
      node.capabilities = { status: 'declared', ...parsed };
      node.kind = 'csw';
      node.delegates = parsed.delegates;
      // 显式传入的本次上限优先；默认上限可被来源声明的 hopCount 收紧，但不会被放宽。
      if (!this.explicitHopLimit && parsed.hopCount !== null && parsed.hopCount < this.hopLimit) {
        this.hopLimit = parsed.hopCount;
      }
    } catch (error) {
      node.capabilities = { status: 'error', returnMode: 'unknown', typeNames: [], elementSetNames: [],
        delegates: [], hopCount: null, error: error.message };
      this.addUncertainty({ code: 'capabilities-error', catalog: node.key,
        message: '无法读取目录声明的记录类型与返回模式', detail: { reason: error.message } });
    }
  }

  async searchNode(node, condition) {
    let path = node.search.requested;
    if (condition) path = withParameter(path, 'constraint', condition);
    let page = 0;
    let nextRecord = 0;
    do {
      const pagePath = nextRecord ? withParameter(path, 'startPosition', nextRecord) : path;
      let result;
      try {
        result = await this.client.request(pagePath);
      } catch (error) {
        node.search.pages.push({ path: pagePath, status: 0, error: error.message });
        node.search.truncated = true;
        node.status = 'error';
        this.addUncertainty({ code: 'search-transport-error', catalog: node.key,
          message: '检索请求未完成，不能视为空结果', detail: { path: pagePath, reason: error.message } });
        return;
      }
      if (result.status !== 200) {
        node.search.pages.push({ path: pagePath, status: result.status, error: `HTTP ${result.status}` });
        node.search.truncated = true;
        node.status = 'error';
        this.addUncertainty({ code: 'search-http-error', catalog: node.key,
          message: '目录返回错误状态，不能视为空结果', detail: { path: pagePath, status: result.status } });
        return;
      }
      let parsed;
      try {
        parsed = parseSearchResponse(result.bytes, result.headers);
      } catch (error) {
        node.search.pages.push({ path: pagePath, status: result.status, error: error.message });
        node.search.truncated = true;
        node.status = 'error';
        this.addUncertainty({ code: 'search-parse-error', catalog: node.key,
          message: '检索响应无法解释，不能视为空结果', detail: { path: pagePath, reason: error.message } });
        return;
      }
      node.search.pages.push({
        path: pagePath, status: 200, mode: parsed.mode,
        matched: parsed.matched, returned: parsed.returned, nextRecord: parsed.nextRecord
      });
      for (const record of parsed.records) {
        node.search.records.push({ identifier: record.identifier, title: record.title, source: node.key });
      }
      node.exceptions.push(...parsed.exceptions.map(item => ({ ...item, page })));
      if (!parsed.complete) node.search.truncated = true;
      for (const item of parsed.exceptions) {
        this.addUncertainty({ code: 'subordinate-exception', catalog: item.catalog || node.key,
          message: '子站返回异常报告，该部分覆盖不确定，不能视为空结果', detail: item });
      }
      // 节点类型由实际观察到的返回模式决定；capabilities 不可用时也不能臆测为 CSW。
      const observedKind = parsed.mode === 'json' ? 'json-debug' : 'csw';
      if (node.kind === undefined) {
        node.kind = observedKind;
        if (node.capabilities.status === 'unknown' || node.capabilities.status === 'error') {
          node.capabilities = {
            status: node.capabilities.status === 'error' ? 'error' : 'embedded',
            returnMode: parsed.mode,
            typeNames: [],
            elementSetNames: [],
            delegates: parsed.delegates,
            hopCount: null,
            ...(node.capabilities.error ? { error: node.capabilities.error } : {})
          };
        }
      }
      if (parsed.delegates.length) node.delegates = parsed.delegates;
      nextRecord = parsed.nextRecord;
      page += 1;
      if (nextRecord && page >= this.maxPages) {
        node.search.truncated = true;
        this.addUncertainty({ code: 'page-limit', catalog: node.key,
          message: '翻页达到本次领取上限，仍有未读记录', detail: { nextRecord, maxPages: this.maxPages } });
        break;
      }
    } while (nextRecord);

    node.complete = !node.search.truncated && node.exceptions.length === 0;
    if (node.search.pages.some(item => item.status !== 200)) node.status = 'error';
    else if (!node.complete) node.status = 'incomplete';
    else if (node.search.records.length === 0) node.status = 'empty';
    else node.status = 'complete';
  }

  claimEndpoint(node) {
    if (node.kind === 'csw') return { pathname: new URL(node.entry, 'http://placeholder.local').pathname, delegated: false };
    // JSON 调试视图本身不能按 identifier 领取；只有沿本次委托树能回到 CSW 网关的节点，
    // 才能委托该网关领取完整元数据，并在凭据中保留委托关系。
    // 与委托树断开（无下游、自身又非 CSW）的目录没有可用的标识领取入口。
    if (!node.cswReachable) return null;
    const cswNode = [...this.visited.values()].find(item => item.kind === 'csw');
    if (!cswNode) return null;
    return { pathname: new URL(cswNode.entry, 'http://placeholder.local').pathname, delegated: true };
  }

  markCswReachability() {
    const children = new Map();
    for (const edge of this.edges) {
      if (edge.outcome !== 'followed' || !edge.from) continue;
      if (!children.has(edge.from)) children.set(edge.from, []);
      children.get(edge.from).push(edge.to);
    }
    const reachable = new Set();
    const walk = key => {
      if (reachable.has(key)) return;
      reachable.add(key);
      for (const child of children.get(key) || []) walk(child);
    };
    for (const node of this.visited.values()) {
      if (node.kind === 'csw') walk(node.key);
      node.cswReachable = false;
    }
    for (const key of reachable) {
      const node = this.visited.get(key);
      if (node) node.cswReachable = true;
    }
  }

  async claimAll(condition) {
    for (const node of this.visited.values()) {
      const endpoint = this.claimEndpoint(node);
      const seen = new Set();
      for (const record of node.search.records) {
        if (!record.identifier || seen.has(record.identifier)) continue;
        seen.add(record.identifier);
        const claim = {
          identifier: record.identifier,
          briefSource: node.key,
          title: record.title,
          delegatedClaim: endpoint ? endpoint.delegated : null,
          status: 'pending',
          requested: null,
          receiptId: null,
          digest: null,
          mediaType: null,
          error: null
        };
        if (!endpoint) {
          claim.status = 'unsupported';
          claim.error = '该来源未声明可按 identifier 领取完整元数据的入口';
          this.addUncertainty({ code: 'claim-unsupported', catalog: node.key,
            message: '无法按来源支持的标识领取完整元数据', detail: { identifier: record.identifier } });
          this.claims.push(claim);
          continue;
        }
        const parameters = new URLSearchParams({
          service: 'CSW', request: 'GetRecordById', id: record.identifier, elementsetname: this.elementSet
        });
        const path = `${trimSlash(endpoint.pathname)}?${parameters.toString()}`;
        claim.requested = new URL(path, this.client.base).href;
        try {
          const result = await this.client.request(path);
          if (result.status !== 200) throw new Error(`GetRecordById 响应：${result.status}`);
          const digest = createHash('sha256').update(result.bytes).digest('hex');
          claim.digest = digest;
          claim.mediaType = result.headers['content-type'] || null;
          if (this.catalog) {
            const receipt = await this.catalog.accept({
              source: claim.requested,
              bytes: result.bytes,
              mediaType: claim.mediaType,
              preview: {
                kind: 'full-metadata-claim',
                identifier: record.identifier,
                briefSource: node.key,
                claimedFrom: endpoint.pathname,
                delegatedClaim: endpoint.delegated,
                condition,
                briefTitle: record.title
              }
            });
            claim.receiptId = receipt.id;
          }
          claim.status = 'accepted';
        } catch (error) {
          claim.status = 'error';
          claim.error = error.message;
          this.addUncertainty({ code: 'claim-error', catalog: node.key,
            message: '完整元数据领取失败，简报记录不能替代完整元数据',
            detail: { identifier: record.identifier, reason: error.message } });
        }
        this.claims.push(claim);
      }
    }
  }
}

export async function runHarvest(client, options = {}) {
  return new Harvester(client, options).runHarvest(options);
}
