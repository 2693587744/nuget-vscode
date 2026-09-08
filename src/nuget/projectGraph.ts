import * as fs from 'fs/promises';
import * as path from 'path';
import { Solution, SolutionProject, PackageReference } from './solution';
import { parseProject } from './solution';

/**
 * 间接/顶级引用的实现思路：
 *   - "顶级(Top)"  = 该项目自己的 PackageReference 命中此包
 *   - "间接(Transitive)" = 项目本身没有显式 PackageReference，但该项目的
 *                          OutputType/TFM 可视为"通过依赖传递可能用到"
 *
 *   VS 真实实现是基于 `nuget why` 或 DG 文件。我们在这里做一个轻量但
 *   与 VS 表现一致的近似：
 *     1. 构建 Project A -> Project B 的反向引用边（图）
 *     2. 若 A 在依赖图中传递可达到 X，而 X 不在 A 的 direct refs 中，
 *        视为 "Transitive"；若在则 "Top"（顶级）。
 */

export interface RefRow {
  project: string;
  version: string;
  installed?: string;     // 已安装版本（顶级有）
  requested?: string;     // 请求的版本范围
  level: '顶级' | '间接' | '未使用';
}

/** 读 csproj 之外，再解析 project.assets.json 中的真实版本与依赖图 */
export async function buildRefRows(
  solution: Solution,
  packageId: string,
): Promise<RefRow[]> {
  const rows: RefRow[] = [];
  for (const p of solution.projects) {
    let direct = false;
    let installedVersion = '';
    try {
      const parsed = await parseProject(p.absolutePath);
      const directRef = parsed.packageReferences.find(
        (r) => r.name.toLowerCase() === packageId.toLowerCase(),
      );
      if (directRef) {
        direct = true;
        installedVersion = directRef.version;
      }
    } catch { /* ignored */ }
    // 终极真实：asset.json 更准确。这里只依靠 PackageReference 即可满足 UI 需求。
    if (direct) {
      rows.push({
        project: p.name,
        version: installedVersion || '',
        installed: installedVersion || '',
        requested: installedVersion || '',
        level: '顶级',
      });
    } else {
      // 间接：通过依赖图传递（这里保守标记为间接，便于 UI 展示）
      const via = await findTransitiveVia(solution, p, packageId);
      if (via.resolvedVersion) {
        rows.push({
          project: p.name,
          version: via.resolvedVersion,
          installed: via.resolvedVersion,
          requested: via.requestedRange || via.resolvedVersion,
          level: '间接',
        });
      } else {
        rows.push({
          project: p.name,
          version: '',
          level: '未使用',
        });
      }
    }
  }
  return rows;
}

interface TransitiveResult {
  resolvedVersion?: string;
  requestedRange?: string;
}

/** 在依赖图中寻找一个 project 通过其他项目的 transitive refs 间接依赖 package */
async function findTransitiveVia(
  solution: Solution,
  target: SolutionProject,
  packageId: string,
): Promise<TransitiveResult> {
  // 从 project.assets.json 的 targets 里查询；
  // NuGet 5+ assets.json 中 key 形如 "Newtonsoft.Json/13.0.4"，需按 prefix 匹配
  try {
    const objDir = path.join(path.dirname(target.absolutePath), 'obj');
    const assetsFile = path.join(objDir, 'project.assets.json');
    const raw = await fs.readFile(assetsFile, 'utf8');
    const data = JSON.parse(raw);
    const targets = data?.targets || {};
    const pidLower = packageId.toLowerCase();
    const prefix = `${pidLower}/`;
    // 第一个命中即返回
    for (const tfm of Object.keys(targets)) {
      const tfmTarget = targets[tfm] || {};
      for (const key of Object.keys(tfmTarget)) {
        if (key.toLowerCase() === prefix || key.toLowerCase().startsWith(prefix)) {
          const version = key.slice(prefix.length);
          const entry = tfmTarget[key] || {};
          return {
            resolvedVersion: version,
            requestedRange: Array.isArray(entry?.requestedRange) ? entry.requestedRange[0] : version,
          };
        }
      }
    }
  } catch { /* 无 project.assets.json 或解析失败 */ }
  return {};
}

/** 安装/卸载：直接修改 csproj（不调用 dotnet CLI） */

/** Uninstall: 从 csproj 中删除 <PackageReference Include="..." Version="..." /> */
export async function uninstallPackage(
  projectAbsPath: string,
  packageId: string,
): Promise<boolean> {
  const raw = await fs.readFile(projectAbsPath, 'utf8');
  const next = removePackageReferenceXml(raw, packageId);
  if (next === raw) return false;
  await fs.writeFile(projectAbsPath, next, 'utf8');
  return true;
}

/** Install: 添加/更新 <PackageReference Include="..." Version="..." /> */
export async function installPackage(
  projectAbsPath: string,
  packageId: string,
  version: string,
): Promise<void> {
  const raw = await fs.readFile(projectAbsPath, 'utf8');
  const next = upsertPackageReferenceXml(raw, packageId, version);
  await fs.writeFile(projectAbsPath, next, 'utf8');
}

function removePackageReferenceXml(content: string, packageId: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 单行形如 <PackageReference Include="X" Version="1.0" />
    const single = /^\s*<PackageReference\s+([^>]*?)\/?>\s*$/.exec(line);
    if (single) {
      const attrs = single[1];
      if (matchesInclude(attrs, packageId)) {
        // 跳到下一行（仅本行）
        i++;
        continue;
      }
    }
    // 多行形如
    //   <PackageReference Include="X">
    //     <Version>1.0</Version>
    //   </PackageReference>
    const open = /^\s*<PackageReference\s+([^>]*?)>\s*$/.exec(line);
    if (open) {
      const attrs = open[1];
      if (matchesInclude(attrs, packageId)) {
        // 跳过到关闭标签为止
        i++;
        while (i < lines.length && !/^\s*<\/PackageReference>/.test(lines[i])) i++;
        if (i < lines.length) i++;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

function upsertPackageReferenceXml(content: string, packageId: string, version: string): string {
  const lines = content.split(/\r?\n/);
  // 1) 已有 Include 一致的 PackageReference → 改 Version
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = /^\s*<PackageReference\s+([^>]*?)(\/?)>.*$/.exec(line);
    if (open) {
      const attrs = open[1] || '';
      if (matchesInclude(attrs, packageId)) {
        // 单行自闭合
        if (open[2] === '/') {
          const newAttrs = replaceAttr(attrs, 'Version', version);
          lines[i] = line.replace(/<PackageReference\s+([^>]*?)\/>/, (_, a) => `<PackageReference ${newAttrs} />`);
          return lines.join('\n');
        }
        // 多行（version 在子节点 Version 内）：找到下一个 </PackageReference> 之前的 Version 节点
        let j = i + 1;
        let replaced = false;
        while (j < lines.length && !/^\s*<\/PackageReference>/.test(lines[j])) {
          const m = /^\s*<Version>([^<]*)<\/Version>/.exec(lines[j]);
          if (m) {
            lines[j] = lineIndent(lines[j]) + `<Version>${version}</Version>`;
            replaced = true;
            j++;
            break;
          }
          j++;
        }
        if (replaced) return lines.join('\n');
        // 没有 Version 子节点：在 </PackageReference> 前插入一个
        const indent = lineIndent(lines[j - 1] || lines[i]);
        lines[j - 1] = lines[j - 1]; // noop
        lines.splice(j, 0, `${indent}<Version>${version}</Version>`);
        return lines.join('\n');
      }
    }
  }
  // 2) 不存在：插入到一个 ItemGroup 内（首选）
  const inserted = insertNewPackageReference(content, packageId, version);
  if (inserted !== content) return inserted;
  // 2.b) 没有任何 ItemGroup，在 Project 末尾插入
  const closeIdx = content.lastIndexOf('</Project>');
  if (closeIdx < 0) return content;
  const before = content.slice(0, closeIdx);
  const after = content.slice(closeIdx);
  return `${before}  <ItemGroup>\n    <PackageReference Include="${packageId}" Version="${version}" />\n  </ItemGroup>\n${after}`;
}

function insertNewPackageReference(content: string, packageId: string, version: string): string {
  const lines = content.split(/\r?\n/);
  let lastItemGroupClose = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*<\/ItemGroup>/.test(lines[i])) { lastItemGroupClose = i; break; }
  }
  if (lastItemGroupClose >= 0) {
    const indent = lineIndent(lines[lastItemGroupClose]);
    lines.splice(lastItemGroupClose, 0, `${indent}  <PackageReference Include="${packageId}" Version="${version}" />`);
    return lines.join('\n');
  }
  return content;
}

function matchesInclude(attrs: string, packageId: string): boolean {
  const re = /\b(?:Include|Update)\s*=\s*"([^"]+)"/;
  const m = re.exec(attrs);
  return !!m && m[1].toLowerCase() === packageId.toLowerCase();
}
function replaceAttr(attrs: string, key: string, value: string): string {
  const re = new RegExp(`\\b${key}\\s*=\\s*"[^"]*"`);
  if (re.test(attrs)) {
    return attrs.replace(re, `${key}="${value}"`);
  }
  return `${attrs} ${key}="${value}"`;
}
function lineIndent(line: string): string {
  const m = /^(\s*)/.exec(line);
  return m ? m[1] : '';
}
