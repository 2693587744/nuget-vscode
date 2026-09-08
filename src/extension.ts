import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { findSolutionFiles, parseSolution, Solution, PackageReference } from './nuget/solution';
import { SourceConfig, searchPackages, queryAllPackages, queryPackageVersions, compareVersions, getPackageDetails, getPackageReadme, PackageSearchResult } from './nuget/packageSource';
import { buildRefRows, RefRow, installPackage, uninstallPackage } from './nuget/projectGraph';
import * as sourceManager from './nuget/sourceManager';
import { NugetPanel } from './webview/nugetPanel';

let activeContext: vscode.ExtensionContext | undefined;
let cachedSolution: Solution | undefined;
let activeSolutionUri: vscode.Uri | undefined;

/** 解析解决方案成功时设置条件；找不到时清除 */
function updateSolutionContext(sln: Solution | undefined) {
  cachedSolution = sln;
  vscode.commands.executeCommand('setContext', 'nuget.solutionResolved', !!sln);
}

export async function activate(context: vscode.ExtensionContext) {
  activeContext = context;
  registerCommands(context);
  registerSolutionWatcher(context);
  // 启动时尝试加载工作区中的 sln
  await tryLoadSolutionFromWorkspace();
}

export function deactivate() { /* noop */ }

function registerCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('nuget.manageSolution', async (uri?: vscode.Uri) => {
      let slnUri = uri || activeSolutionUri;
      if (!slnUri) {
        // 备份探测工作区 sln
        await tryLoadSolutionFromWorkspace();
        slnUri = activeSolutionUri;
      }
      if (!slnUri) {
        const wsFolders = vscode.workspace.workspaceFolders || [];
        for (const f of wsFolders) {
          const found = await findSolutionFiles(f.uri.fsPath, 3);
          if (found.length) {
            activeSolutionUri = vscode.Uri.file(found[0]);
            slnUri = activeSolutionUri;
            break;
          }
        }
      }
      if (!slnUri) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectMany: false,
          filters: { 'Solution': ['sln'] },
          title: '选择解决方案文件 (.sln)',
        });
        if (picked && picked[0]) {
          activeSolutionUri = picked[0];
          slnUri = picked[0];
        }
      }
      if (!slnUri) { vscode.window.showInformationMessage('未选择解决方案。'); return; }
      await loadSolution(slnUri);
      NugetPanel.showOrCreate(context);
    }),
    vscode.commands.registerCommand('nuget.restoreSolution', async () => {
      await runDotnetRestore();
    }),
    vscode.commands.registerCommand('nuget.openPackageSourceSettings', async () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'nuget-vscode');
    }),
    vscode.commands.registerCommand('nuget.openPackageSourceManager', async () => {
      // 确保 webview 已创建，然后让前端调 getSources 拿到当前列表
      await tryLoadSolutionFromWorkspace();
      await loadSolution(activeSolutionUri || vscode.Uri.file(''));
      NugetPanel.showOrCreate(context);
      NugetPanel.current?.focus();
    }),
    vscode.commands.registerCommand('nuget.setActiveSource', async (source?: SourceConfig) => {
      const cfg = vscode.workspace.getConfiguration('nuget-vscode');
      const list: SourceConfig[] = cfg.get('sources') || [];
      if (!source) {
        const picked = await vscode.window.showQuickPick(list.map((s) => ({ label: s.name, description: s.url, target: s })));
        if (!picked) return;
        source = picked.target;
      }
      await sourceManager.setActive(source.name);
    }),
  );
}

function registerSolutionWatcher(context: vscode.ExtensionContext) {
  // 监听 sln 切换
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async () => {
    await tryLoadSolutionFromWorkspace();
  }));
}

/** 自动发现工作区的 sln */
async function tryLoadSolutionFromWorkspace() {
  const wsFolders = vscode.workspace.workspaceFolders || [];
  if (!wsFolders.length) { updateSolutionContext(undefined); return; }
  const root = wsFolders[0].uri.fsPath;
  const files = await findSolutionFiles(root, 3);
  if (!files.length) { updateSolutionContext(undefined); return; }
  if (files.length === 1) {
    activeSolutionUri = vscode.Uri.file(files[0]);
  } else {
    // 多个 .sln 让用户选
    const picked = await vscode.window.showQuickPick(files.map((f) => ({ label: path.basename(f), description: f, target: f })));
    if (!picked) return;
    activeSolutionUri = vscode.Uri.file(picked.target);
  }
  // 仅当 UI 启动或上下文变化时才解析
  if (!cachedSolution || cachedSolution.absolutePath !== activeSolutionUri.fsPath) {
    await loadSolution(activeSolutionUri);
  }
}

async function loadSolution(uri: vscode.Uri) {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(uri.fsPath);
  try {
    const sln = await parseSolution(uri.fsPath, wsRoot);
    updateSolutionContext(sln);
    if (NugetPanel.current) NugetPanel.current.postSolutionChanged();
  } catch (e) {
    vscode.window.showErrorMessage(`解析解决方案失败：${(e as Error).message}`);
  }
}

/** 调用 dotnet 还原（如果可用） */
async function runDotnetRestore() {
  const cfg = vscode.workspace.getConfiguration('nuget-vscode');
  let dotnet = cfg.get<string>('dotnetPath') || '';
  if (!dotnet) {
    // 默认按 PATH 查找
    dotnet = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
  }
  const sln = activeSolutionUri?.fsPath || cachedSolution?.absolutePath;
  if (!sln) { vscode.window.showErrorMessage('未找到解决方案'); return; }
  const terminal = vscode.window.createTerminal({ name: 'NuGet', cwd: path.dirname(sln) });
  terminal.show();
  terminal.sendText(`${dotnet} restore "${sln}"`);
}

/* =========================================================
 * WebView 端 ↔ Extension 端 消息桥
 * ========================================================= */

NugetPanel.bus.on('getBootstrapData', async () => {
  if (!activeContext) return null;
  if (!cachedSolution) return null;
  const cfg = vscode.workspace.getConfiguration('nuget-vscode');
  const snap = await sourceManager.load();
  const includePrerelease: boolean = cfg.get('includePrerelease') ?? false;
  return {
    solution: serializeSolution(cachedSolution),
    sources: snap.sources,
    activeSource: snap.active,
    defaultSource: snap.default,
    includePrerelease,
  };
});

NugetPanel.bus.on('setIncludePrerelease', async ({ value }: { value: boolean }) => {
  await vscode.workspace.getConfiguration('nuget-vscode').update('includePrerelease', value, vscode.ConfigurationTarget.Global);
  return true;
});

NugetPanel.bus.on('setActiveSource', async ({ name }: { name: string }) => {
  const snap = await sourceManager.setActive(name);
  NugetPanel.current?.postSourcesChanged(snap);
  return snap;
});

NugetPanel.bus.on('openSourceSettings', async () => {
  vscode.commands.executeCommand('workbench.action.openSettings', 'nuget-vscode');
});

NugetPanel.bus.on('queryPackages', async ({ includePrerelease, query, take, skip }: { includePrerelease: boolean; query: string; take?: number; skip?: number }) => {
  const snap = await sourceManager.load();
  const srcs = sourceManager.resolveActiveSources(snap.sources, snap.active);
  if (!srcs.length) return { source: null, items: [] };
  const _take = Math.max(1, Math.min(100, take ?? 30));
  const _skip = Math.max(0, skip ?? 0);
  console.log('[NuGet] queryPackages active=', snap.active, 'sources=', srcs.map((s) => s.url), 'query=', query, 'take=', _take, 'skip=', _skip);
  // 并行查询所有激活源，按包 ID 去重合并（版本高者替换，下载量取较大值——同 id 的 totalDownloads 是包全局值，多源重复累加无意义）
  const results = await Promise.all(srcs.map((src) => searchPackages(src, {
    query,
    includePrerelease,
    take: _take,
    skip: _skip,
  })));
  // 多源合并：直接展开源返回的完整 PackageSearchResult（含 title/summary/iconUrl/licenseUrl/projectUrl/tags/owners/versions 等）
  const map = new Map<string, PackageSearchResult>();
  for (const list of results) {
    for (const it of list) {
      const key = it.id.toLowerCase();
      const cur = map.get(key);
      if (!cur) {
        map.set(key, { ...it });
        continue;
      }
      // 版本号高者替换 entry（保留其它元数据）
      if (compareVersions(it.version, cur.version) > 0) {
        map.set(key, { ...it, totalDownloads: it.totalDownloads ?? cur.totalDownloads });
      } else if (typeof it.totalDownloads === 'number' && (typeof cur.totalDownloads !== 'number' || it.totalDownloads > cur.totalDownloads)) {
        // 同版本时下载量取较大值（不同源可能不同时点返回，统计口径有差异）
        cur.totalDownloads = it.totalDownloads;
      }
    }
  }
  // 保持服务端返回顺序（与 VS 一致，不擅自二次排序）；
  // 未勾选"包括预发行版"时：去掉 version 是 prerelease 的项（如 "11.0.0-preview.7.26381.103"）
  const allItems = Array.from(map.values());
  const items = includePrerelease
    ? allItems
    : allItems.filter((it) => !it.version || !it.version.includes('-'));
  return { source: srcs, items };
});

NugetPanel.bus.on('queryPackageVersions', async ({ packageId, includePrerelease }: { packageId: string; includePrerelease: boolean }) => {
  const snap = await sourceManager.load();
  const srcs = sourceManager.resolveActiveSources(snap.sources, snap.active);
  const results = await Promise.all(srcs.map((src) => queryPackageVersions(src, packageId, { includePrerelease })));
  // 多个源版本取并集去重，再整体倒序
  const map = new Map<string, { version: string; isPrerelease: boolean }>();
  for (const r of results) {
    for (const v of r.versions) {
      if (!map.has(v.version)) map.set(v.version, v);
    }
  }
  const versions = Array.from(map.values()).sort((a, b) => compareVersions(b.version, a.version));
  return { versions };
});

/** 取包详细元数据 + 自述文件（用于右侧详情面板的「包详细信息 / 自述文件」标签）。 */
NugetPanel.bus.on('getPackageMetadata', async ({ packageId, version }: { packageId: string; version: string }) => {
  const snap = await sourceManager.load();
  const srcs = sourceManager.resolveActiveSources(snap.sources, snap.active);
  // 并行向所有激活源请求：metadata 必须成功；readme 即使失败也不影响 metadata
  const results = await Promise.allSettled(srcs.map(async (src) => {
    const meta = await getPackageDetails(src, packageId, version);
    // 把 projectUrl / nugetGalleryUrl 透传给 readme，避免 readme 内部再次发起 catalog 请求
    let readme = '';
    try { readme = await getPackageReadme(src, packageId, version, meta.projectUrl, meta.nugetGalleryUrl); } catch { /* readme 失败不影响整体 */ }
    return { src, meta, readme };
  }));
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { meta, readme, src } = r.value;
      return { meta, readme, source: src };
    }
  }
  // 所有源都拿不到 metadata
  throw new Error('所有包源均无法读取包元数据');
});

NugetPanel.bus.on('getUpdateCandidates', async ({ includePrerelease }: { includePrerelease: boolean }) => {
  const snap = await sourceManager.load();
  const srcs = sourceManager.resolveActiveSources(snap.sources, snap.active);
  if (!srcs.length || !cachedSolution) return { items: [] as { id: string; current: string; latest: string; isPrerelease?: boolean }[] };

  // 收集已安装包 ID 集合
  const installedIds = new Set<string>();
  for (const p of cachedSolution.projects) {
    for (const r of p.packageReferences) installedIds.add(r.name.toLowerCase());
  }

  // 解决方案级聚合版本：默认取出现过的最长，或首个
  const installedVersion = new Map<string, string>();
  for (const p of cachedSolution.projects) {
    for (const r of p.packageReferences) {
      const k = r.name.toLowerCase();
      const cur = installedVersion.get(k);
      if (!cur || !cur || cur === '*' || (r.version && r.version !== '*')) {
        installedVersion.set(k, r.version || '*');
      }
    }
  }

  // 并行查询每个包在所有激活源中的版本并合并
  async function queryVersionsAll(id: string) {
    const results = await Promise.all(srcs.map((s) => queryPackageVersions(s, id, { includePrerelease })));
    const vmap = new Map<string, { version: string; isPrerelease: boolean }>();
    for (const r of results) {
      for (const v of r.versions) {
        if (!vmap.has(v.version)) vmap.set(v.version, v);
      }
    }
    return Array.from(vmap.values()).sort((a, b) => compareVersions(b.version, a.version));
  }

  const candidates: { id: string; current: string; latest: string; isPrerelease?: boolean }[] = [];
  await Promise.all(Array.from(installedIds).map(async (id) => {
    const verList = await queryVersionsAll(id);
    if (!verList.versions.length) return;
    // 最新稳定版本
    const stable = verList.versions.find((v) => !v.isPrerelease);
    const latest = verList.versions[0]; // 已排序
    const currentRaw = installedVersion.get(id) || '*';
    // 当前版本归一：'*' 视为 latest
    const current = currentRaw === '*' ? latest.version : currentRaw;
    if (compareVersions(latest.version, current) > 0) {
      candidates.push({
        id,
        current,
        latest: latest.version,
        isPrerelease: latest.isPrerelease,
      });
    } else if (stable && currentRaw !== '*' && compareVersions(stable.version, current) > 0) {
      candidates.push({
        id,
        current,
        latest: stable.version,
        isPrerelease: stable.isPrerelease,
      });
    }
  }));
  return { items: candidates };
});

NugetPanel.bus.on('getProjectReferencesForPackage', async ({ packageId }: { packageId: string }) => {
  if (!cachedSolution) return { rows: [] as RefRow[] };
  const rows = await buildRefRows(cachedSolution, packageId);
  return { rows };
});

NugetPanel.bus.on('uninstallPackage', async ({ packageId, project }: { packageId: string; project: string }) => {
  if (!cachedSolution) return { ok: false };
  const p = cachedSolution.projects.find((x) => x.name === project);
  if (!p) return { ok: false };
  const ok = await uninstallPackage(p.absolutePath, packageId);
  if (ok) {
    p.packageReferences = p.packageReferences.filter((r) => r.name.toLowerCase() !== packageId.toLowerCase());
    // 刷新 webview 视图
    NugetPanel.current?.postInstalledChanged();
  }
  return { ok };
});

NugetPanel.bus.on('installPackage', async ({ packageId, version, project }: { packageId: string; version: string; project: string }) => {
  if (!cachedSolution) return { ok: false };
  const p = cachedSolution.projects.find((x) => x.name === project);
  if (!p) return { ok: false };
  await installPackage(p.absolutePath, packageId, version);
  // 同步缓存
  const existing = p.packageReferences.find((r) => r.name.toLowerCase() === packageId.toLowerCase());
  if (existing) existing.version = version;
  else p.packageReferences.push({ name: packageId, version });
  NugetPanel.current?.postInstalledChanged();
  return { ok: true };
});

NugetPanel.bus.on('restore', async () => { await runDotnetRestore(); return { ok: true }; });

NugetPanel.bus.on('reload', async () => {
  if (activeSolutionUri) await loadSolution(activeSolutionUri);
  return { ok: true };
});

/* ============ 包源管理 ============ */

NugetPanel.bus.on('getSources', async () => {
  return await sourceManager.load();
});

NugetPanel.bus.on('probeSource', async ({ source }: { source: SourceConfig }) => {
  return await sourceManager.probe(source);
});

NugetPanel.bus.on('addSource', async ({ source }: { source: SourceConfig }) => {
  const snap = await sourceManager.addSource(source);
  NugetPanel.current?.postSourcesChanged(snap);
  return snap;
});

NugetPanel.bus.on('updateSource', async ({ name, source }: { name: string; source: SourceConfig }) => {
  const snap = await sourceManager.updateSource(name, source);
  NugetPanel.current?.postSourcesChanged(snap);
  return snap;
});

NugetPanel.bus.on('deleteSource', async ({ name }: { name: string }) => {
  const snap = await sourceManager.deleteSource(name);
  NugetPanel.current?.postSourcesChanged(snap);
  return snap;
});

NugetPanel.bus.on('setActiveSource2', async ({ name }: { name: string }) => {
  const snap = await sourceManager.setActive(name);
  NugetPanel.current?.postSourcesChanged(snap);
  return snap;
});

NugetPanel.bus.on('setDefaultSource', async ({ name }: { name: string }) => {
  const snap = await sourceManager.setDefault(name);
  NugetPanel.current?.postSourcesChanged(snap);
  return snap;
});

function serializeSolution(sln: Solution) {
  return {
    name: sln.name,
    absolutePath: sln.absolutePath,
    relativeRoot: sln.relativeRoot,
    projects: sln.projects.map((p) => ({
      name: p.name,
      relativePath: p.relativePath,
      kind: p.kind,
      outputType: p.outputType,
      targetFramework: p.targetFramework,
      targetFrameworks: p.targetFrameworks,
      packageReferences: p.packageReferences.map((r) => ({ ...r })),
    })),
  };
}
