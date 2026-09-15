import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface SourceConfig {
  name: string;
  url: string;
  /** 允许 HTTP 明文连接（内网 Baget 等场景）。默认 false */
  allowInsecureConnections?: boolean;
  /** 名称在 UI 中隐藏（依然可以被选中） */
  hidden?: boolean;
}

/** NuGet flat-container 风格 API 反序列化 */
interface FlatContainerItem { id: string; version: string; }
interface RegistrationEntry {
  items: { items?: RegistrationEntryItem[]; }[];
  count?: number;
}
interface RegistrationEntryItem {
  id: string;
  version: string;
  catalogEntry?: { id: string; version: string; isPrerelease?: boolean; listed?: boolean; };
}

export interface PackageVersion { version: string; isPrerelease: boolean; }
export interface PackageVersionsResult {
  versions: PackageVersion[];
  /** 当网络失败时，由 mock 提供 */
  offlineMock?: boolean;
}

/** HTTP GET JSON */
function fetchJson<T>(rawUrl: string, timeoutMs = 8000, insecure = false): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let url: URL;
    try { url = new URL(rawUrl); } catch (e) { return reject(e); }
    // https 默认；http 需要明确允许
    if (url.protocol === 'http:' && !insecure) {
      return reject(new Error('http 明文连接被拒绝：请在包源配置中设置 allowInsecureConnections=true'));
    }
    const lib = url.protocol === 'http:' ? http : https;
    const reqOpts: any = {
      method: 'GET',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + (url.search || ''),
      headers: { 'User-Agent': 'nuget-vscode/0.1.0', 'Accept': 'application/json' },
    };
    if (url.protocol === 'https:' && insecure) {
      reqOpts.rejectUnauthorized = false;
    }
    const req = lib.request(reqOpts, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${url.protocol}//${url.host}${res.headers.location}`;
        fetchJson<T>(next, timeoutMs, insecure).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url.hostname}${url.pathname}`));
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (err: any) => reject(new Error(`${url.hostname}: ${err.message || err.code || 'unknown'}`)));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.end();
  });
}

/** 仓库级不安全开关 */
function insecureAllowed(source: SourceConfig): boolean {
  return !!source.allowInsecureConnections;
}

/** 解析 V3 (catalog) index URL 得到 registration/flatcontainer/search/details/readme base */
async function getServiceIndex(source: SourceConfig): Promise<{
  flat: string;
  reg?: string;
  search?: string;
  details?: string;
  readme?: string;
}> {
  const idx = await fetchJson<{ resources: { '@type': string; '@id': string }[] }>(source.url, 8000, insecureAllowed(source));
  const findRes = (typePrefix: string) => {
    const r = idx.resources.find((r) => r['@type'].startsWith(typePrefix));
    return r ? r['@id'].replace(/\/$/, '') : undefined;
  };
  const flat    = findRes('PackageBaseAddress/3.0.0');
  const reg     = findRes('RegistrationsBaseUrl')
               ?? findRes('RegistrationsBaseUrl/3.0.0')
               ?? findRes('RegistrationsBaseUrl/3.0.6-rc')
               ?? findRes('RegistrationsBaseUrl/3.4.0-rc');
  const search  = findRes('SearchQueryService')
               ?? findRes('SearchQueryService/3.0.0-rc')
               ?? findRes('SearchQueryService/3.5.0')
               ?? findRes('SearchQueryService/3.0.0');
  const details = findRes('PackageDetailsUriTemplate/3.0.0-rc')
               ?? findRes('PackageDetailsUriTemplate/5.1.0')
               ?? findRes('PackageDetailsUriTemplate');
  const readme  = findRes('ReadmeUriTemplate/3.0.0-rc')
               ?? findRes('ReadmeUriTemplate');
  if (!flat) throw new Error('源未声明 PackageBaseAddress');
  return { flat, reg, search, details, readme };
}

/** NuGet Search API 返回项（NuGet 官方搜索返回的完整字段，见真实响应） */
export interface PackageSearchResult {
  id: string;
  version: string;
  description?: string;
  summary?: string;
  title?: string;
  authors?: string[];
  owners?: string[];
  iconUrl?: string;
  licenseUrl?: string;
  projectUrl?: string;
  tags?: string[];
  isPrerelease?: boolean;
  listed?: boolean;
  verified?: boolean;
  /** 包下载总量 */
  totalDownloads?: number;
  /** 包类型（Dependency / DotnetTool 等） */
  packageTypes?: { name: string }[];
  /** 版本历史：version + 每版本下载量（来自搜索结果的 versions 字段） */
  versions?: { version: string; downloads: number; '@id'?: string }[];
  /** 漏洞信息 */
  vulnerabilities?: unknown[];
  offlineMock?: boolean;
  latestPrerelease?: string;
}

interface SearchHit {
  id: string;
  version: string;
  description?: string;
  summary?: string;
  title?: string;
  authors?: string[];
  owners?: string[];
  iconUrl?: string;
  licenseUrl?: string;
  projectUrl?: string;
  tags?: string[];
  isPrerelease?: boolean;
  listed?: boolean;
  verified?: boolean;
  totalDownloads?: number;
  packageTypes?: { name: string }[];
  versions?: { version: string; downloads: number; '@id'?: string }[];
  vulnerabilities?: unknown[];
}

/** 搜索包名。优先使用 SearchQueryService（所有包源都支持），fallback 到 registrations 索引 */
export async function searchPackages(source: SourceConfig, opts: {
  query?: string;
  includePrerelease?: boolean;
  take?: number;
  skip?: number;
  signal?: { aborted: boolean };
} = {}): Promise<PackageSearchResult[]> {
  const take = opts.take ?? 30;
  const skip = opts.skip ?? 0;
  try {
    const idx = await getServiceIndex(source);
    // 1. 首选：SearchQueryService（NuGet 官方 + Baget 都支持）
    if (idx.search) {
      const q = (opts.query || '').trim();
      // 与 VS NuGet Package Manager 完全一致的请求参数：
      //   https://azuresearch-usnc.nuget.org/query?q=json&skip=0&take=25&prerelease=False&semVerLevel=2.0.0
      // 注意：
      //  - prerelease 是大小写敏感布尔，VS 传 False/True（首字母大写）
      //  - semVerLevel=2.0.0 必须带（控制返回的版本/字段解析）
      //  - 不传 sortBy（VS 就用服务端默认排序，传了反而不同）
      const params = new URLSearchParams();
      params.set('take', String(take));
      params.set('skip', String(skip));
      params.set('prerelease', opts.includePrerelease !== false ? 'True' : 'False');
      params.set('semVerLevel', '2.0.0');
      if (q) params.set('q', q);
      const url = `${idx.search}?${params.toString()}`;
      console.log('[NuGet] searchPackages URL=', url);
      const res = await fetchJson<{ data?: SearchHit[]; value?: SearchHit[]; totalHits?: number }>(url, 8000, insecureAllowed(source));
      const hits: SearchHit[] = res.value || res.data || [];
      console.log('[NuGet] searchPackages result count=', hits.length, 'sample=', hits[0]?.id, hits[0]?.version);
      // 对同一 id 的多个版本条目：合并为一条，保留最全的元数据（搜索结果本身已含全字段）
      const map = new Map<string, PackageSearchResult>();
      for (const h of hits) {
        const cur = map.get(h.id);
        if (!cur) {
          map.set(h.id, {
            id: h.id,
            version: h.version,
            description: h.description,
            summary: h.summary,
            title: h.title,
            authors: h.authors,
            owners: h.owners,
            iconUrl: h.iconUrl,
            licenseUrl: h.licenseUrl,
            projectUrl: h.projectUrl,
            tags: h.tags,
            isPrerelease: !!h.isPrerelease,
            listed: h.listed,
            verified: h.verified,
            totalDownloads: h.totalDownloads,
            packageTypes: h.packageTypes,
            versions: h.versions,
            vulnerabilities: h.vulnerabilities,
          });
        } else {
          // 版本更高则替换 version 并补全缺失元数据
          if (compareVersions(h.version, cur.version) > 0) {
            cur.version = h.version;
            cur.isPrerelease = !!h.isPrerelease;
          }
          if (h.isPrerelease) cur.latestPrerelease = h.version;
          // 补全当前缺失的字段
          if (!cur.description && h.description) cur.description = h.description;
          if (!cur.summary && h.summary) cur.summary = h.summary;
          if (!cur.title && h.title) cur.title = h.title;
          if (!cur.authors?.length && h.authors?.length) cur.authors = h.authors;
          if (!cur.owners?.length && h.owners?.length) cur.owners = h.owners;
          if (!cur.iconUrl && h.iconUrl) cur.iconUrl = h.iconUrl;
          if (!cur.licenseUrl && h.licenseUrl) cur.licenseUrl = h.licenseUrl;
          if (!cur.projectUrl && h.projectUrl) cur.projectUrl = h.projectUrl;
          if (!cur.tags?.length && h.tags?.length) cur.tags = h.tags;
          // 累计下载量（同 id 多个版本条目，按 NuGet 设计每个版本都返回独立 download 数）
          if (typeof h.totalDownloads === 'number') {
            cur.totalDownloads = (cur.totalDownloads || 0) + h.totalDownloads;
          }
          // versions 历史合并（取更全的）
          if (h.versions?.length && (!cur.versions?.length || h.versions.length > cur.versions.length)) {
            cur.versions = h.versions;
          }
        }
      }
      // 结果按服务端返回顺序（与 VS 一致，不擅自二次排序）；
      // 未勾选"包括预发行版"时，剔除预发行版本的条目并清空 latestPrerelease 标记
      let list = [...map.values()];
      if (opts.includePrerelease === false) {
        // 服务端返回的数据里，同 id 多条：稳定版优先；只有预发行版（无稳定版）的条目保留
        const filtered = new Map<string, PackageSearchResult>();
        for (const it of list) {
          const cur = filtered.get(it.id);
          if (!cur) { filtered.set(it.id, it); continue; }
          const curPre = cur.version?.includes('-');
          const itPre = it.version?.includes('-');
          if (curPre && !itPre) filtered.set(it.id, it);
          else if (!curPre && itPre) { /* 保留稳定版，丢弃预发行 */ }
          else if (!curPre && !itPre && compareVersions(it.version, cur.version) > 0) filtered.set(it.id, it);
        }
        list = [...filtered.values()];
        // 清掉 latestPrerelease，避免前端显示预发行
        list.forEach((x) => { (x as any).latestPrerelease = undefined; });
      }
      return list;
    }
    // 2. fallback：RegistrationsBaseUrl 索引（需要枚举）
    if (idx.reg) {
      const out: { id: string; version: string; isPrerelease?: boolean }[] = [];
      let nextUrl: string | undefined = `${idx.reg}/semver1/index.json`;
      let pageCount = 0;
      const seenIds = new Set<string>();
      while (nextUrl && pageCount < 50) {
        if (opts.signal?.aborted) break;
        const page = await fetchJson<RegistrationEntry | { items: RegistrationEntryItem[]; '@id': string; }>(nextUrl, 8000, insecureAllowed(source));
        const items: RegistrationEntryItem[] = (page as any).items || [];
        for (const it of items) {
          const cat = it.catalogEntry || (it as any);
          if (cat.listed === false) continue;
          const id = cat.id || it.id;
          if (!seenIds.has(id.toLowerCase())) {
            seenIds.add(id.toLowerCase());
            out.push({ id, version: cat.version || it.version, isPrerelease: !!cat.isPrerelease });
          }
        }
        const nextId = (page as any)['@id'];
        nextUrl = nextId && nextId !== nextUrl ? nextId : undefined;
        pageCount++;
      }
      return out;
    }
    throw new Error('源未声明 SearchQueryService / RegistrationsBaseUrl');
  } catch (err) {
    // 失败：仅当 query 为空且源未联网时返回示例列表（使 UI 不会完全空白）
    if (!opts.query) return mockPackages(source, opts.includePrerelease === false).map((m) => ({ ...m, offlineMock: true }));
    // 有 query 仍失败：返回空数组 + 报错
    return [];
  }
}

/** 保留旧名 queryAllPackages 以兼容现有调用 */
export async function queryAllPackages(source: SourceConfig, opts: {
  includePrerelease?: boolean;
  signal?: { aborted: boolean };
} = {}): Promise<{ id: string; version: string; isPrerelease?: boolean; offlineMock?: boolean }[]> {
  return searchPackages(source, { includePrerelease: opts.includePrerelease, signal: opts.signal });
}

/** 离线情况下，给出一个示例包列表，方便本地开发 */
function mockPackages(source: SourceConfig, stableOnly: boolean): { id: string; version: string; isPrerelease?: boolean }[] {
  const list = [
    'Newtonsoft.Json', 'Microsoft.Extensions.Logging', 'Microsoft.Extensions.DependencyInjection',
    'Microsoft.Extensions.Hosting', 'Serilog', 'NLog', 'AutoMapper', 'MediatR',
    'FluentValidation', 'Dapper', 'EntityFramework', 'Xunit', 'Moq', 'FluentAssertions',
    'BCrypt.Net-Next', 'MailKit', 'MimeKit', 'Polly', 'Refit', 'StackExchange.Redis',
    'Swashbuckle.AspNetCore', 'NEST', 'Elasticsearch.Net', 'Confluent.Kafka',
    'RabbitMQ.Client', 'Grpc.Core', 'Grpc.AspNetCore', 'protobuf-net', 'protobuf-net.Grpc',
    'Npgsql', 'MySql.Data', 'MySqlConnector', 'Microsoft.Data.Sqlite', 'Dapper.SqlBuilder',
    'Hangfire', 'Quartz', 'CsvHelper', 'EPPlus', 'ClosedXML', 'MiniExcel',
    'System.Text.Json', 'System.Memory', 'System.Reactive', 'Rx.NET', 'ReactiveUI',
    'Microsoft.IdentityModel.Tokens', 'System.IdentityModel.Tokens.Jwt',
    'Azure.Identity', 'Azure.Storage.Blobs', 'Azure.Messaging.ServiceBus',
    'AWSSDK.S3', 'AWSSDK.DynamoDBv2', 'Google.Cloud.Storage.V1',
    'Basic.Payment.Service', 'Basic.Payment.Wallent', 'ipdata-sdk',
  ];
  const items: { id: string; version: string; isPrerelease?: boolean }[] = [];
  for (const id of list) {
    const stable = semverishBump(`${Math.floor((Math.abs(hash(id)) % 8) + 1)}.${Math.floor(Math.random() * 8)}.0`);
    items.push({ id, version: stable });
    // 加一个预发行版
    if (!stableOnly) items.push({ id, version: `${stable}-preview.${Math.floor(Math.random() * 9) + 1}`, isPrerelease: true });
    // 偶发再加一个更新版本
    if (Math.random() > 0.4) items.push({ id, version: semverishBump(stable) });
  }
  return items;

  function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return h; }
  function semverishBump(v: string): string {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return v;
    return `${m[1]}.${(parseInt(m[2], 10) + 1).toString()}.${(parseInt(m[3], 10) + (Math.random() > 0.7 ? 1 : 0))}`;
  }
}

/** 为一批 {id, version} 构造 NuGet v3 flat-container 图标 URL。
 *  模板 `{flatBase}/{id小写}/{version小写}/icon` 是 V3 规范路径（官方搜索 API 返回的
 *  iconUrl 即此格式），因此无需发起额外网络请求即可拿到候选地址；
 *  若包没有图标或源不支持该端点，浏览器加载该 URL 会 404，前端 img onerror 自动回退默认图。
 *  返回 key=调用方原样传入的 id，value=icon URL 或 null（无源/版本缺失无法构造）。 */
export async function resolveFlatContainerIcons(source: SourceConfig, packages: { id: string; version: string }[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (!packages.length) return out;
  let flat: string | undefined;
  try {
    flat = (await getServiceIndex(source)).flat;
  } catch { flat = undefined; }
  if (!flat) return out;
  for (const p of packages) {
    const id = (p.id || '').trim();
    const ver = (p.version || '').trim();
    if (!id || !ver || ver === '*') { out[p.id] = null; continue; }
    out[p.id] = `${flat}/${encodeURIComponent(id.toLowerCase())}/${encodeURIComponent(ver.toLowerCase())}/icon`;
  }
  return out;
}

/** 包的版本列表（flat container） */
export async function queryPackageVersions(source: SourceConfig, pkgId: string, opts: {
  includePrerelease?: boolean;
} = {}): Promise<PackageVersionsResult> {
  try {
    const { flat, reg } = await getServiceIndex(source);
    const enc = encodeURIComponent(pkgId.toLowerCase());
    // 优先 flatcontainer/{id}/index.json；缺失则用 registration 索引。
    // 注意：NuGet v3 规范下 flatcontainer 返回的是 { "versions": [...] } 对象，不是纯数组。
    let versions: string[] | null = null;
    try {
      const raw = await fetchJson<{ versions: string[] } | string[]>(`${flat}/${enc}/index.json`, 8000, insecureAllowed(source));
      // 兼容两种结构：标准对象 {versions:[...]} 或个别实现直接返回字符串数组
      versions = Array.isArray(raw) ? raw : (raw?.versions ?? null);
    } catch {
      if (reg) {
        try {
          // registration 索引：每个 page 含 items[].version
          const pages = await fetchJson<{ items?: { items?: { version: string }[] }[] }>(`${reg}/${enc}/index.json`, 8000, insecureAllowed(source));
          versions = [];
          for (const p of pages.items || []) for (const v of p.items || []) versions.push(v.version);
        } catch { /* registration 索引也失败时回退为空 */ }
      }
    }
    if (!versions) return { versions: [] };
    const list: PackageVersion[] = versions
      .map((v) => ({ version: v, isPrerelease: /[-+]/i.test(v) }))
      .filter((v) => opts.includePrerelease ? true : !v.isPrerelease);
    // 排序（版本倒序，最新在前；预发行版排在同主版本后）
    list.sort((a, b) => compareVersions(b.version, a.version));
    return { versions: list };
  } catch (err) {
    // 错误时不返回假数据（避免误导），直接返回空数组
    console.warn('[NuGet] queryPackageVersions failed:', pkgId, err);
    return { versions: [] };
  }
}

/** NuGet v3 服务索引里 {@type: "PackageDetailsUriTemplate/..."} 或
 *  "ReadmeUriTemplate/..." 的 URL Template 使用 RFC 6570 Level-1 占位符，
 *  形如 `https://api.nuget.org/v3/registration5-semver1/{id-lower}/{version-lower}.json`。
 *  这里只做 Level-1 字符串替换（{var} 与 {+var}），不做完整 URL 编码转换。 */
function expandUriTemplate(template: string, vars: Record<string, string>): string {
  // 占位符名有多种写法：{id} / {version} / {id-lower} / {version-lower} / {lower_id} / {lower_version}
  const resolve = (key: string): string => {
    const k = key.replace(/^[+-]+/, '');
    if (vars[k] !== undefined) return vars[k];
    const norm = k.toLowerCase().replace(/[-_]/g, '');
    if (norm === 'id' || norm === 'idlower' || norm === 'lowerid') return vars['id'] ?? '';
    if (norm === 'version' || norm === 'versionlower' || norm === 'lowerversion') return vars['version'] ?? '';
    return '';
  };
  return template.replace(/\{([+\w.-]+)\}/g, (_m, key: string) => encodeURIComponent(resolve(key)));
}

export interface PackageDependency { id: string; range: string; }
export interface PackageDepGroup { targetFramework: string; dependencies: PackageDependency[]; }
export interface PackageMetadata {
  id: string;
  version: string;
  title?: string;
  authors?: string[];
  owners?: string[];
  description?: string;
  summary?: string;
  projectUrl?: string;
  licenseUrl?: string;
  licenseName?: string;
  iconUrl?: string;
  tags?: string[];
  totalDownloads?: number;
  /** 展平后的所有依赖（所有 TFM 合并去重） */
  dependencies?: PackageDependency[];
  /** 按 TFM 分组的依赖（详情面板渲染用） */
  dependencyGroups?: PackageDepGroup[];
  published?: string;
  /** NuGet.org 包详情页 URL */
  nugetGalleryUrl?: string;
  /** 报告滥用链接 */
  reportAbuseUrl?: string;
  source?: string;
}

/** 取包详细元数据（nuspec）。优先 PackageDetailsUriTemplate；NuGet 官方该端点返回的是
 *  registration 叶子节点（含 catalogEntry URL，但元数据字段极少），需要再请求一次
 *  catalog data 才能拿到 authors/owners/dependencyGroups/projectUrl 等完整字段。
 *  Baget 没这层——Baget 的 PackageDetailsUriTemplate 直接返回完整 metadata。 */
export async function getPackageDetails(source: SourceConfig, pkgId: string, version: string): Promise<PackageMetadata> {
  const insecure = insecureAllowed(source);
  const idx = await getServiceIndex(source);
  const vars = { id: pkgId.toLowerCase(), version: version.toLowerCase() };

  let leaf: any = null;
  // 1. 优先 PackageDetailsUriTemplate
  if (idx.details) {
    try {
      const url = expandUriTemplate(idx.details, vars);
      leaf = await fetchJson<any>(url, 8000, insecure);
    } catch { /* 降级到 registration */ }
  }
  // 2. fallback：registration5-semver1/{id}/{version}.json
  if (!leaf && idx.reg) {
    const url = `${idx.reg}/${encodeURIComponent(pkgId.toLowerCase())}/${encodeURIComponent(version.toLowerCase())}.json`;
    leaf = await fetchJson<any>(url, 8000, insecure);
  }
  if (!leaf) throw new Error('源未声明 PackageDetailsUriTemplate / RegistrationsBaseUrl');

  // 3. 如果叶子节点有 catalogEntry 字段（NuGet 官方风格），再请求一次 catalog data 拿完整元数据
  let detail = leaf;
  if (typeof leaf?.catalogEntry === 'string' && /^https?:\/\//.test(leaf.catalogEntry)) {
    try {
      detail = await fetchJson<any>(leaf.catalogEntry, 8000, insecure);
    } catch { /* catalog 失败时降级用 leaf，避免完全没数据 */ }
  }

  return parseCatalogEntry(detail, source.url, pkgId, version);
}

function parseCatalogEntry(j: any, sourceUrl: string, fallbackId = '', fallbackVersion = ''): PackageMetadata {
  const authors = Array.isArray(j?.authors) ? j.authors : (typeof j?.authors === 'string' && j.authors ? j.authors.split(',').map((s: string) => s.trim()) : undefined);
  const owners  = Array.isArray(j?.owners) ? j.owners : undefined;
  const tags    = Array.isArray(j?.tags) ? j.tags : (typeof j?.tags === 'string' && j.tags ? j.tags.split(/[,\s]+/).filter(Boolean) : undefined);
  const depGroups: any[] = Array.isArray(j?.dependencyGroups) ? j.dependencyGroups : [];
  // 保留分组：用于详情面板按 TFM 分组展示（与 VS 一致）
  const dependencyGroups = depGroups
    .filter((g) => Array.isArray(g?.dependencies) && g.dependencies.length > 0)
    .map((g) => ({
      targetFramework: g.targetFramework || '',
      dependencies: (g.dependencies as any[]).filter((d) => d?.id).map((d) => ({ id: d.id, range: d.range || '' })),
    }));
  const flatDeps: PackageDependency[] = [];
  for (const g of depGroups) {
    for (const d of (g.dependencies || [])) {
      if (d?.id) flatDeps.push({ id: d.id, range: d.range || '' });
    }
  }
  // 滥用报告链接：包 ID 上传到 NuGet.org 后，可以构造 abuse 报告 URL
  // catalogEntry 有时缺少 id/version（例如某些第三方源），用调用方传入的参数兜底，
  // 否则会拼出 https://www.nuget.org/packages// 这类无效链接
  const id = j?.id || fallbackId;
  const version = j?.version || fallbackVersion;
  return {
    id,
    version,
    title: j?.title,
    authors,
    owners,
    description: j?.description,
    summary: j?.summary,
    projectUrl: j?.projectUrl,
    licenseUrl: j?.licenseUrl,
    licenseName: typeof j?.license === 'string' ? j.license : (j?.license?.text || j?.license?.name || undefined),
    iconUrl: j?.iconUrl,
    tags,
    totalDownloads: j?.totalDownloads,
    dependencies: flatDeps,
    dependencyGroups,
    published: j?.published,
    /** NuGet.org 上的报告滥用链接（VS 也是用这个 URL） */
    reportAbuseUrl: `https://www.nuget.org/packages/${encodeURIComponent(id)}/${encodeURIComponent(version)}/ReportAbuse`,
    /** NuGet.org 包详情页 URL（包含自述文件） */
    nugetGalleryUrl: `https://www.nuget.org/packages/${encodeURIComponent(id)}/${encodeURIComponent(version)}`,
    source: sourceUrl,
  };
}

/** 从 projectUrl 解析 GitHub 仓库地址；不是 GitHub 返回 null */
function parseGithubRepo(projectUrl?: string): { owner: string; repo: string } | null {
  if (!projectUrl) return null;
  const m = /github\.com\/([^/]+)\/([^/#?]+)/i.exec(projectUrl);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, '') };
}

/** 从 NuGet Gallery 包页面（https://www.nuget.org/packages/{id}/{version}#show-readme-container）
 *  抓取 README。NuGet Gallery 页面结构（实测 Newtonsoft.Json 13.0.5-beta1）：
 *    <li id="show-readme-container">...README tab...</li>
 *      ↓ tab 内容
 *    <div class="tab-pane" id="readme-tab" aria-label="Readme tab content">
 *      <div class="readme-common">
 *        <div id="readme-container">
 *          ...完整 README HTML（h2/h3/p/pre/ul/li/a/img）...
 *        </div>
 *      </div>
 *    </div>
 *  返回 readme-container 内的 HTML 片段（前端 v-html 直接渲染）。 */
async function fetchNugetGalleryReadme(pkgId: string, version: string): Promise<string | null> {
  const url = `https://www.nuget.org/packages/${encodeURIComponent(pkgId.toLowerCase())}/${encodeURIComponent(version.toLowerCase())}`;
  try {
    const html = await fetchRaw(url, 8000, false);
    if (!html) return null;
    // 提取 <div id="readme-container"> ... </div>（按 div 配对，避免被内层 </div> 提前截断）
    const open = /<div[^>]*\bid=["']readme-container["'][^>]*>/i.exec(html);
    if (!open) return null;
    const block = extractDivBlock(html, open.index);
    if (!block) return null;
    let body = block.replace(/^<div\b[^>]*>/i, '').replace(/<\/div>\s*$/i, '');
    if (!body) return null;
    // 还原：把相对 src/href 替换为绝对 URL，避免 webview 加载不到图片/链接
    body = body.replace(/src=["'](\/[^"']+)["']/g, (_m, p) => `src="https://www.nuget.org${p}"`);
    body = body.replace(/href=["'](\/[^"']+)["']/g, (_m, p) => `href="https://www.nuget.org${p}"`);
    return body;
  } catch {
    return null;
  }
}

/** 从 GitHub 拉取仓库 README.md（main / master 分支都试，含重定向跟随） */
async function fetchGithubReadme(projectUrl?: string): Promise<string | null> {
  const gh = parseGithubRepo(projectUrl);
  if (!gh) return null;
  const { owner, repo } = gh;
  // raw.githubusercontent.com 大小写敏感，常见文件名都试一遍
  const candidates: string[] = [];
  for (const branch of ['main', 'master']) {
    for (const name of ['README.md', 'readme.md', 'README.MD', 'README']) {
      candidates.push(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${name}`);
    }
  }
  for (const url of candidates) {
    const text = await fetchRaw(url, 8000, false);
    if (text) return text;
  }
  return null;
}

/** 取包自述文件（统一返回可被 v-html 直接渲染的 HTML）。优先级：
 *  1. ReadmeUriTemplate（官方 flatcontainer/CDN，返回**完整 Markdown**）——最稳定、内容最全；
 *  2. NuGet Gallery 包页面的已渲染 HTML；
 *  3. projectUrl 指向的 GitHub 仓库 README（Markdown）；
 *  4. 兜底 nuspec description / summary。
 *  nugetGalleryUrl 由调用方传入（若包来自官方源会有该 URL）。 */
export async function getPackageReadme(source: SourceConfig, pkgId: string, version: string, projectUrl?: string, nugetGalleryUrl?: string): Promise<string> {
  const insecure = insecureAllowed(source);
  const idx = await getServiceIndex(source);
  const vars = { id: pkgId.toLowerCase(), version: version.toLowerCase() };

  // 1. 包内嵌 README（ReadmeUriTemplate：nuget.org 指向 globalcdn flatcontainer，返回完整 Markdown）
  if (idx.readme) {
    try {
      const url = expandUriTemplate(idx.readme, vars);
      const direct = await fetchRaw(url, 8000, insecure);
      // 过短的内容通常是占位片段，继续尝试后续来源
      if (direct && direct.trim().length >= 60) return ensureReadmeHtml(direct);
    } catch { /* 降级 */ }
  }

  // 2. NuGet Gallery 包页面 README（已是 HTML，展示效果与 VS 一致）
  if (nugetGalleryUrl || /nuget\.org/i.test(source.url)) {
    const gallery = await fetchNugetGalleryReadme(pkgId, version);
    if (gallery) return gallery;
  }

  // 3. GitHub README（Markdown）
  if (projectUrl) {
    const gh = await fetchGithubReadme(projectUrl);
    if (gh) return ensureReadmeHtml(gh);
  }

  // 4. 兜底：nuspec description / summary
  try {
    const meta = await getPackageDetails(source, pkgId, version);
    const parts: string[] = [];
    if (meta.summary) parts.push(meta.summary);
    if (meta.description) parts.push(meta.description);
    if (parts.length) return `<p class="md-p">${escapeHtml(parts.join('\n\n'))}</p>`;
  } catch { /* ignore */ }
  return '';
}

/** 内容本身是 HTML 则原样返回，否则按 Markdown 转成 HTML */
function ensureReadmeHtml(text: string): string {
  return /<(h[1-6]|p|div|ul|ol|table|pre|blockquote|br)\b/i.test(text) ? text : markdownToHtml(text);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 轻量 Markdown → HTML：覆盖 README 常见语法，输出与 webview CSS 约定的 md-* class。
 *  刻意不引入第三方依赖（内网/离线环境也能构建）。 */
function markdownToHtml(md: string): string {
  const inline = (s: string): string => {
    let t = escapeHtml(s);
    t = t.replace(/`([^`]+)`/g, (_m, c) => `<code class="md-code">${c}</code>`);
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt, src) => `<img src="${src}" alt="${alt}" />`);
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, txt, href) => `<a href="${href}" target="_blank" rel="noopener">${txt}</a>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return t;
  };

  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (/^\s*```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre class="md-pre"><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lv = h[1].length;
      out.push(`<h${lv} class="md-h">${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    // 水平线
    if (/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/.test(line)) { out.push('<hr class="md-hr" />'); i++; continue; }

    // 引用
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote class="md-quote">${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // 表格（表头 + |---| 分隔行）
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?[\s:|-]*$/.test(lines[i + 1])) {
      const cells = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      const thead = `<tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>`;
      const tbody = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table class="md-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`);
      continue;
    }

    // 列表
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const tag = ordered ? 'ol' : 'ul';
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        i++;
      }
      out.push(`<${tag} class="md-list">${items.map((t) => `<li class="md-li">${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }

    // 空行
    if (!line.trim()) { i++; continue; }

    // 段落（合并连续非空且非块级起始的行）
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length && lines[i].trim() &&
      !/^\s*(#{1,6}\s|>|```)/.test(lines[i]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
      !/^\s*\|/.test(lines[i])
    ) { buf.push(lines[i]); i++; }
    out.push(`<p class="md-p">${inline(buf.join('\n'))}</p>`);
  }
  return out.join('\n');
}

/** 从 startIndex（一个 <div ...> 开始标签）起按 div 配对取到配对的 </div>，
 *  避免非贪婪正则在第一个嵌套 </div> 处提前截断 README。 */
function extractDivBlock(html: string, startIndex: number): string | null {
  const re = /<div\b[^>]*>|<\/div>/gi;
  re.lastIndex = startIndex;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[0].startsWith('</')) {
      depth--;
      if (depth === 0) return html.slice(startIndex, m.index + m[0].length);
    } else {
      depth++;
    }
  }
  return null;
}

/** 拿到原始响应文本（不做 JSON 解析） */
function fetchRaw(rawUrl: string, timeoutMs: number, insecure: boolean): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let url: URL;
    try { url = new URL(rawUrl); } catch { return resolve(null); }
    if (url.protocol === 'http:' && !insecure) return resolve(null);
    const lib = url.protocol === 'http:' ? require('http') : require('https');
    const req = lib.request({
      method: 'GET',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + (url.search || ''),
      headers: { 'User-Agent': 'nuget-vscode/0.1.0' },
    }, (res: any) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** 简易版本比较（语义化 + 预发行后缀优先顺序） */
export function compareVersions(a: string, b: string): number {
  const pa = splitVersion(a); const pb = splitVersion(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const x = pa.nums[i] || 0; const y = pb.nums[i] || 0;
    if (x !== y) return x - y;
  }
  if (pa.isPre === pb.isPre) return 0;
  return pa.isPre ? -1 : 1;
  function splitVersion(v: string) {
    const m = /([0-9.]+)(?:[-+]([0-9A-Za-z.-]+))?/.exec(v) || [];
    const main = m[1] || v;
    const pre  = m[2];
    return {
      nums: main.split('.').map((s) => parseInt(s, 10) || 0),
      isPre: !!pre,
      raw: v,
    };
  }
}
