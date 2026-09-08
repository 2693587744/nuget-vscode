import * as vscode from 'vscode';
import { SourceConfig } from './packageSource';

/** 特殊值：表示使用全部源（可被选中为当前激活，也可设为默认） */
export const ALL_SOURCES = '__all__';

export interface SourceManagerSnapshot {
  sources: SourceConfig[];
  /** 当前激活源：源名 或 ALL_SOURCES */
  active: string;
  /** 默认源：源名 或 ALL_SOURCES */
  default: string;
}

/** 解析当前激活对应的源列表：ALL_SOURCES 返回全部，否则返回单个 */
export function resolveActiveSources(sources: SourceConfig[], active: string): SourceConfig[] {
  if (active === ALL_SOURCES) return sources.slice();
  const s = sources.find((x) => x.name === active);
  return s ? [s] : sources.slice();
}

function isValidTarget(sources: SourceConfig[], name: string): boolean {
  return name === ALL_SOURCES || sources.some((x) => x.name === name);
}

/** 读取指定 key 的全局层值（忽略工作区/工作区文件夹层的覆盖） */
function readGlobal<T>(cfg: vscode.WorkspaceConfiguration, key: string): T | undefined {
  const inspect = cfg.inspect<T>(key);
  return inspect?.globalValue ?? inspect?.defaultValue;
}

/** 读配置（仅全局 VSCode 配置，不涉及项目内 nuget.config）：
 *  显式读取全局层 globalValue，避免工作区残留配置干扰；
 *  仅当值失效时兜底到第一个源或全部 */
export async function load(): Promise<SourceManagerSnapshot> {
  const cfg = vscode.workspace.getConfiguration('nuget-vscode');
  const sources = (readGlobal<SourceConfig[]>(cfg, 'sources') || []).filter((s) => s && s.name && s.url);
  let active = readGlobal<string>(cfg, 'activeSource') || '';
  let def = readGlobal<string>(cfg, 'defaultSource') || '';
  if (!isValidTarget(sources, active)) active = isValidTarget(sources, def) ? def : (sources[0]?.name || ALL_SOURCES);
  if (!isValidTarget(sources, def)) def = sources[0]?.name || ALL_SOURCES;
  return { sources, active, default: def };
}

/** 写回全局配置，并清除工作区/工作区文件夹层的残留值（避免优先级更高的残留覆盖全局） */
export async function save(snap: SourceManagerSnapshot): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('nuget-vscode');
  await cfg.update('sources', snap.sources, vscode.ConfigurationTarget.Global);
  await cfg.update('activeSource', snap.active, vscode.ConfigurationTarget.Global);
  await cfg.update('defaultSource', snap.default, vscode.ConfigurationTarget.Global);
  // 清除低优先级来源的残留，确保全局是唯一配置源
  await cfg.update('sources', undefined, vscode.ConfigurationTarget.Workspace);
  await cfg.update('activeSource', undefined, vscode.ConfigurationTarget.Workspace);
  await cfg.update('defaultSource', undefined, vscode.ConfigurationTarget.Workspace);
  await cfg.update('sources', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  await cfg.update('activeSource', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  await cfg.update('defaultSource', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
}

/** 校验一个源是否可用（GET index.json） */
export async function probe(s: SourceConfig): Promise<{ ok: boolean; error?: string; services?: string[] }> {
  try {
    const res = await fetch(s.url, { method: 'GET' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json: any = await res.json();
    const services: string[] = Array.isArray(json?.resources) ? json.resources.map((r: any) => r['@type']) : [];
    return { ok: true, services };
  } catch (err: any) {
    // http 明文拒绝场景
    if (String(err?.message || err).includes('http')) {
      return { ok: false, error: 'http 明文连接被拒绝，请勾选"允许 HTTP 明文"' };
    }
    return { ok: false, error: String(err?.message || err) };
  }
}

/** CRUD 操作 */
export async function addSource(s: SourceConfig): Promise<SourceManagerSnapshot> {
  const snap = await load();
  if (snap.sources.some((x) => x.name === s.name)) throw new Error(`已存在同名源：${s.name}`);
  snap.sources.push(s);
  if (!snap.active) snap.active = s.name;
  if (!snap.default) snap.default = s.name;
  await save(snap);
  return snap;
}

export async function updateSource(name: string, s: SourceConfig): Promise<SourceManagerSnapshot> {
  const snap = await load();
  const idx = snap.sources.findIndex((x) => x.name === name);
  if (idx < 0) throw new Error(`找不到源：${name}`);
  snap.sources[idx] = s;
  if (snap.active === name) snap.active = s.name;
  if (snap.default === name) snap.default = s.name;
  await save(snap);
  return snap;
}

export async function deleteSource(name: string): Promise<SourceManagerSnapshot> {
  const snap = await load();
  snap.sources = snap.sources.filter((x) => x.name !== name);
  if (snap.active === name) snap.active = snap.sources[0]?.name || ALL_SOURCES;
  if (snap.default === name) snap.default = snap.sources[0]?.name || ALL_SOURCES;
  await save(snap);
  return snap;
}

/** 切换当前激活源（支持 ALL_SOURCES） */
export async function setActive(name: string): Promise<SourceManagerSnapshot> {
  const snap = await load();
  if (!isValidTarget(snap.sources, name)) throw new Error(`找不到源：${name}`);
  snap.active = name;
  await save(snap);
  return snap;
}

/** 设置默认源（支持 ALL_SOURCES），同时把当前激活切过去 */
export async function setDefault(name: string): Promise<SourceManagerSnapshot> {
  const snap = await load();
  if (!isValidTarget(snap.sources, name)) throw new Error(`找不到源：${name}`);
  snap.default = name;
  snap.active = name;
  await save(snap);
  return snap;
}
