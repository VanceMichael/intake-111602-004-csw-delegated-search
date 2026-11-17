export function dispatch({ url, phase, scenario = 'ordinary' }) {
  // federation 场景在夹具中自带多站调试视图，不由本动态视图接管。
  if (url.pathname === '/regional/csw' && scenario !== 'federation') {
    return { json: { catalog: 'regional', delegates: ['/csw?service=CSW&request=GetRecords'],
      records: [{ identifier: 'route-map-1', title: '同号区域资料' }], complete: Boolean(phase),
      exceptions: phase ? [] : [{ catalog: 'county-b', code: 'NoApplicableCode' }] } };
  }
  if (url.pathname === '/csw' && url.searchParams.get('request') === 'GetRecordById') {
    return { json: { identifier: url.searchParams.get('id'), owner: 'park', institution: 'root-gateway',
      type: 'dataset', elementSetName: url.searchParams.get('elementsetname') || 'full',
      relation: '/assets/map1' } };
  }
  return null;
}
