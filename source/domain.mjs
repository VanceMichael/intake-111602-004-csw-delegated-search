export function dispatch({ url, phase }) {
  if (url.pathname === '/regional/csw') return { json: { catalog: 'regional', delegates: ['/csw?service=CSW&request=GetRecords'],
    records: [{ identifier: 'route-map-1', title: '同号区域资料' }], complete: Boolean(phase),
    exceptions: phase ? [] : [{ catalog: 'county-b', code: 'NoApplicableCode' }] } };
  if (url.pathname === '/csw' && url.searchParams.get('request') === 'GetRecordById') {
    return { json: { identifier: url.searchParams.get('id'), owner: 'park', type: 'dataset', relation: '/assets/map1' } };
  }
  return null;
}
