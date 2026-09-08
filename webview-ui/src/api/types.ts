export interface SourceConfig {
  name: string;
  url: string;
  allowInsecureConnections?: boolean;
  hidden?: boolean;
}

export interface SourceManagerSnapshot {
  sources: SourceConfig[];
  /** 当前激活源：源名 或 '__all__'（全部） */
  active: string;
  /** 默认源：源名 或 '__all__'（全部） */
  default: string;
}

export interface PackageReference { name: string; version: string; }

export interface SolutionProject {
  name: string;
  kind: string;
  targetFramework?: string;
  targetFrameworks?: string[];
  packageReferences: PackageReference[];
}

export interface Solution {
  name: string;
  projects: SolutionProject[];
}

export interface Bootstrap {
  solution: Solution;
  sources: SourceConfig[];
  activeSource: string;
  defaultSource: string;
  includePrerelease: boolean;
  /** 打开面板时默认激活的页签：updates / browse / installed */
  defaultTab?: string;
}

export interface PackageItemData {
  id: string;
  version?: string;
  latestPrerelease?: string;
  current?: string;
  latest?: string;
  author?: string;
  authors?: string[];
  description?: string;
  summary?: string;
  title?: string;
  iconUrl?: string;
  licenseUrl?: string;
  projectUrl?: string;
  tags?: string[];
  owners?: string[];
  verified?: boolean;
  isPrerelease?: boolean;
  /** 总下载量（仅 NuGet 官方搜索 API 会返回） */
  totalDownloads?: number;
  /** 版本历史：version + 每版本下载量 */
  versions?: { version: string; downloads: number }[];
  /** 包类型（Dependency / DotnetTool 等） */
  packageTypes?: { name: string }[];
  /** 漏洞信息 */
  vulnerabilities?: unknown[];
}

export interface RefRow {
  project: string;
  version?: string;
  installed?: string;
  requested?: string;
  level: '顶级' | '间接' | '未使用';
}

export interface PackageVersionsResult {
  version: string;
  isPrerelease: boolean;
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
  dependencies?: PackageDependency[];
  dependencyGroups?: PackageDepGroup[];
  published?: string;
  nugetGalleryUrl?: string;
  reportAbuseUrl?: string;
  source?: string;
}
