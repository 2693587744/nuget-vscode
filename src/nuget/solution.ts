import * as fs from 'fs/promises';
import * as path from 'path';
import * as xml2jsLite from './xmlLight';

/** .sln 项目类型 GUID → 文件后缀 */
const PROJECT_TYPE = {
  CSharpProject:        { ext: '.csproj',          kind: 'csproj'  as const },
  FSharpProject:        { ext: '.fsproj',          kind: 'fsproj'  as const },
  VBNetProject:         { ext: '.vbproj',          kind: 'vbproj'  as const },
  SharedProject:        { ext: '.shproj',          kind: 'shproj'  as const },
  CpsSdk:               { ext: '.csproj',          kind: 'sdk'     as const }, // SDK style
  VsUser:               { ext: '',                 kind: 'user'    as const },
} satisfies Record<string, { ext: string; kind: ProjectKind }>;

export type ProjectKind = 'csproj' | 'fsproj' | 'vbproj' | 'shproj' | 'sdk' | 'user';

export interface SolutionProject {
  name: string;
  relativePath: string;
  absolutePath: string;
  kind: ProjectKind;
  outputType?: string; // Exe / Library / WinExe ...
  targetFramework?: string; // 单 TFM
  targetFrameworks?: string[]; // 多 TFM
  packageReferences: PackageReference[];
}

export interface PackageReference {
  name: string;
  version: string; // 已安装版本
  includeAssets?: string;
  excludeAssets?: string;
  privateAssets?: string;
}

/** 解决方案级别（含所有项目） */
export interface Solution {
  absolutePath: string;
  relativeRoot: string; // 工作区根
  name: string;
  projects: SolutionProject[];
}

/** 从工作区查找 .sln */
export async function findSolutionFiles(root: string, max = 5): Promise<string[]> {
  const stack: string[] = [root];
  const out: string[] = [];
  while (stack.length && out.length < max) {
    const cur = stack.pop()!;
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.vs' || e.name.startsWith('.')) continue;
        stack.push(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.sln')) {
        out.push(full);
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

/** 解析 .sln，得到所有 csproj/fsproj 等 */
export async function parseSolution(slnPath: string, workspaceRoot: string): Promise<Solution> {
  const raw = await fs.readFile(slnPath, 'utf8');
  const projects = parseSlnContent(raw, slnPath, workspaceRoot);
  // 读取 csproj 信息（最佳努力）
  for (const p of projects) {
    try {
      const proj = await parseProject(p.absolutePath);
      p.outputType = proj.outputType;
      p.targetFramework = proj.targetFramework;
      p.targetFrameworks = proj.targetFrameworks;
      p.packageReferences = proj.packageReferences;
    } catch (err) {
      // 忽略，保留占位
    }
  }
  return {
    absolutePath: slnPath,
    relativeRoot: workspaceRoot,
    name: path.basename(slnPath, '.sln'),
    projects,
  };
}

/** 解析 .sln 文本到项目（不考虑 csproj 内容） */
function parseSlnContent(content: string, slnPath: string, root: string): SolutionProject[] {
  const projects: SolutionProject[] = [];
  // Project("{TYPE-GUID}") "Name.csproj" "Path\Name.csproj" "GUID"
  const projectRegex = /^Project\("\{([0-9A-Fa-f-]+)\}"\)\s*=\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"\{([0-9A-Fa-f-]+)\}"/gm;
  let m: RegExpExecArray | null;
  while ((m = projectRegex.exec(content)) !== null) {
    const [, typeGuid, name, relativePath] = m;
    const kind = resolveKind(typeGuid, path.extname(relativePath));
    if (!kind) continue;
    projects.push({
      name,
      relativePath,
      absolutePath: path.resolve(path.dirname(slnPath), relativePath),
      kind,
      packageReferences: [],
    });
  }
  return projects.filter((p) => p.kind !== 'user');
}

function resolveKind(typeGuid: string, ext: string): ProjectKind | null {
  // typeGuid 转大写无连字符
  const k = typeGuid.replace(/[{}-]/g, '').toUpperCase();
  if (k === 'FAE04EC0-301F-11D3-BF4B-00C04F79EFBC') return 'csproj'; // C#
  if (k === 'F2A71F9B-5D33-465A-A702-920D77279786') return 'fsproj'; // F#
  if (k === 'F184B08F-C81C-45F6-A57F-5ABD9991F28F') return 'vbproj'; // VB
  if (k === 'D954291E-2A0B-460D-937E-833846648A22') return 'shproj'; // Shared
  if (k === '9A19103F-16F7-4668-BE54-9A1E7A4F7556' || k === '13B669BE-BB05-4DDF-9536-461F6A3B7773') {
    return 'sdk'; // SDK style
  }
  // 兜底：根据后缀
  if (ext === '.csproj') return 'csproj';
  if (ext === '.fsproj') return 'fsproj';
  if (ext === '.vbproj') return 'vbproj';
  if (ext === '.shproj') return 'shproj';
  return null;
}

/** 解析 csproj：TFMs、OutputType、PackageReference */
export async function parseProject(projectPath: string): Promise<{
  outputType?: string;
  targetFramework?: string;
  targetFrameworks?: string[];
  packageReferences: PackageReference[];
}> {
  const content = await fs.readFile(projectPath, 'utf8');
  return parseProjectContent(content);
}

export function parseProjectContent(content: string) {
  const out: ReturnType<typeof parseProjectContent> = {
    packageReferences: [],
  };
  const doc = xml2jsLite.parse(content);

  // OutputType
  const outType = xml2jsLite.findPath(doc, 'PropertyGroup/OutputType');
  if (outType?.text) out.outputType = outType.text.trim();

  // TargetFramework / TargetFrameworks
  const tf = xml2jsLite.findPath(doc, 'PropertyGroup/TargetFramework');
  const tfs = xml2jsLite.findPath(doc, 'PropertyGroup/TargetFrameworks');
  if (tf?.text) out.targetFramework = tf.text.trim();
  if (tfs?.text) out.targetFrameworks = tfs.text.split(';').map((s) => s.trim()).filter(Boolean);

  // PackageReference（可能出现在 ItemGroup 下，或 Conditional）
  const refs = xml2jsLite.findAll(doc, 'PackageReference');
  for (const r of refs) {
    const include = (r.attrs['Include'] || r.attrs['Update']) || '';
    const version = (r.attrs['Version'] || childVersion(r) || '').trim();
    if (!include) continue;
    out.packageReferences.push({
      name: include,
      version: version || '*',
      includeAssets: r.attrs['IncludeAssets'],
      excludeAssets: r.attrs['ExcludeAssets'],
      privateAssets: r.attrs['PrivateAssets'],
    });
  }
  return out;
}

function childVersion(el: xml2jsLite.Node): string | undefined {
  const v = el.children.find((c) => c.tag === 'Version');
  return v?.text?.trim();
}

/** 已安装包名的并集（解决方案级视图） */
export function solutionInstalledPackages(sln: Solution): Map<string, { version: string }> {
  const m = new Map<string, { version: string }>();
  for (const p of sln.projects) {
    for (const r of p.packageReferences) {
      const cur = m.get(r.name.toLowerCase());
      if (!cur) m.set(r.name.toLowerCase(), { version: r.version });
      else if (cur.version === '*') m.set(r.name.toLowerCase(), { version: r.version });
    }
  }
  return m;
}
