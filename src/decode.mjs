export function decode(bytes) {
  const text = bytes.toString('utf8');
  if (!/<csw:GetRecordsResponse\b/.test(text) || !/<\/csw:GetRecordsResponse>/.test(text)) throw new Error('不是目录检索响应');
  const root = /<csw:SearchResults\b([^>]*)>/.exec(text)?.[1];
  if (!root) throw new Error('缺少检索状态');
  const count = name => Number(new RegExp(`${name}="(\\d+)"`).exec(root)?.[1] || 0);
  const records = [...text.matchAll(/<csw:(BriefRecord|Record)>([\s\S]*?)<\/csw:\1>/g)].map(match => ({
    identifier: /<dc:identifier>(.*?)<\/dc:identifier>/.exec(match[2])?.[1],
    title: /<dc:title>(.*?)<\/dc:title>/.exec(match[2])?.[1],
    kind: match[1]
  }));
  return { matched: count('numberOfRecordsMatched'), returned: count('numberOfRecordsReturned'), nextRecord: count('nextRecord'), records };
}
