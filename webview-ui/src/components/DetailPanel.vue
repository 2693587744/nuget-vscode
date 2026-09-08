<template>
  <div class="nu-detail">
    <div class="nu-detail-head">
      <div class="icon" v-if="meta?.iconUrl"><img :src="meta.iconUrl" alt="" /></div>
      <div class="icon" v-else>📦</div>
      <div class="name">{{ meta?.title || data?.id || '' }}</div>
      <span v-if="meta?.version" class="nu-detail-version">{{ meta.version }}</span>
    </div>

    <div v-if="!data" class="nu-empty col">
      <span>在左侧选择一个包以查看详细信息</span>
    </div>

    <template v-else>
      <!-- 项目引用（始终展示，VS 风格） -->
      <div class="nu-detail-section" style="flex: 0 0 auto; max-height: 40%; overflow: auto;">
        <div class="label">引用此包的项目</div>
        <table>
          <thead>
            <tr>
              <th style="width: 22px"></th>
              <th>项目</th>
              <th>已安装</th>
              <th style="width: 60px">包级别</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="rows.length === 0">
              <td :colspan="4" style="text-align: center; color: var(--text-mute);">加载中…</td>
            </tr>
            <tr v-for="r in rows" :key="r.project">
              <td>
                <input
                  type="checkbox"
                  :disabled="r.level === '间接' || busy !== null"
                  :checked="r.level === '顶级'"
                  @change="onProjectCheck(r, ($event.target as HTMLInputElement).checked)"
                />
              </td>
              <td>{{ r.project }}</td>
              <td>{{ r.installed || '–' }}</td>
              <td :class="r.level === '顶级' ? 'lv-top' : r.level === '间接' ? 'lv-trans' : 'lv-none'">
                {{ r.level }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 操作区（已安装 + 版本下拉） -->
      <div class="nu-detail-section">
        <div class="nu-row-install">
          <label>已安装:</label>
          <span style="flex: 1" :title="installHint">{{ installLabel }}</span>
          <button
            class="primary"
            :disabled="installLevel !== '顶级' || busy !== null"
            :title="installLevel === '顶级' ? '从顶级引用的项目中卸载' : '此包未在任何项目中直接引用，无法卸载'"
            @click="doUninstall(installTop?.project || '')"
          >卸载</button>
        </div>
        <div v-if="installLevel === '间接'" class="nu-hint-warn">
          此包为间接安装（通过其它包依赖传递引入），不支持直接卸载。
        </div>
      </div>
      <div class="nu-detail-section">
        <div class="nu-row-install">
          <label>版本:</label>
          <select v-model="version" :disabled="busy !== null">
            <option v-if="(versions || []).length === 0" value="">(加载中)</option>
            <option
              v-for="v in versions"
              :key="v.version"
              :value="v.version"
            >
              {{ v.isPrerelease ? ` ${v.version}` : ` ${v.version}` }}
            </option>
          </select>
          <button class="primary" :disabled="busy !== null || !version" @click="doInstall">安装</button>
        </div>
      </div>

      <!-- 详情 Tab：包详细信息 / 自述文件（VS 风格） -->
      <div class="nu-detail-tabs">
        <div :class="['nu-tab', { active: tab === 'details' }]" @click="tab = 'details'">包详细信息</div>
        <div :class="['nu-tab', { active: tab === 'readme' }]" @click="tab = 'readme'">自述文件</div>
      </div>
      <div class="nu-detail-body" style="flex: 1; min-height: 0; overflow: auto;">
        <!-- 包详细信息 -->
        <div v-if="tab === 'details'" class="nu-meta">
          <!-- 有 metaPreview 时立即渲染；无 preview 时显示加载态 -->
          <div v-if="metaLoading && !meta" class="nu-empty">加载中…</div>
          <div v-else-if="!meta" class="nu-empty">未能加载元数据</div>
          <template v-else>
            <h3 class="meta-h">{{ meta.title || meta.id }}</h3>
            <p v-if="meta.description" class="meta-desc">{{ meta.description }}</p>

            <table class="meta-table">
              <tbody>
                <tr v-if="meta.authors?.length"><th>作者</th><td>{{ meta.authors.join(', ') }}</td></tr>
                <tr v-if="readme">
                  <th>自述文件</th>
                  <td><a v-if="meta.nugetGalleryUrl" :href="meta.nugetGalleryUrl + '#show-readme-container'" target="_blank">查看自述文件</a></td>
                </tr>
                <tr v-if="typeof meta.totalDownloads === 'number'">
                  <th>下载</th>
                  <td>{{ formatDownloads(meta.totalDownloads) }}（{{ meta.totalDownloads.toLocaleString() }}）</td>
                </tr>
                <tr v-if="meta.published"><th>发布日期</th><td>{{ formatDate(meta.published) }}</td></tr>
                <tr v-if="meta.projectUrl"><th>项目 URL</th><td><a :href="meta.projectUrl" target="_blank">{{ meta.projectUrl }}</a></td></tr>
                <tr v-if="meta.reportAbuseUrl"><th>报告滥用情况</th><td><a :href="meta.reportAbuseUrl" target="_blank">{{ meta.reportAbuseUrl }}</a></td></tr>
                <tr v-if="meta.licenseName || meta.licenseUrl"><th>许可证</th><td>
                  <a v-if="meta.licenseUrl" :href="meta.licenseUrl" target="_blank">{{ meta.licenseName || meta.licenseUrl }}</a>
                  <span v-else>{{ meta.licenseName }}</span>
                </td></tr>
                <tr v-if="meta.tags?.length"><th>标记</th><td>{{ meta.tags.join(', ') }}</td></tr>
                <tr v-if="meta.dependencyGroups?.length">
                  <th>依赖项</th>
                  <td>
                    <details v-for="(g, gi) in meta.dependencyGroups" :key="gi" class="meta-dep-group">
                      <summary>{{ g.targetFramework || '默认' }}</summary>
                      <ul class="meta-deps">
                        <li v-for="d in g.dependencies" :key="d.id">
                          {{ d.id }} <span class="meta-dep-ver">{{ d.range || '无依赖项' }}</span>
                        </li>
                      </ul>
                    </details>
                  </td>
                </tr>
                <tr v-if="!meta.dependencyGroups?.length && meta.dependencies?.length">
                  <th>依赖项</th>
                  <td>
                    <ul class="meta-deps">
                      <li v-for="d in meta.dependencies" :key="d.id">{{ d.id }} <span class="meta-dep-ver">{{ d.range || '' }}</span></li>
                    </ul>
                  </td>
                </tr>
                <tr v-if="meta.source"><th>源</th><td class="meta-source">{{ meta.source }}</td></tr>
              </tbody>
            </table>
          </template>
        </div>

        <!-- 自述文件（NuGet Gallery README，HTML 渲染，与 VS 一致） -->
        <div v-else-if="tab === 'readme'" class="nu-readme">
          <div v-if="readmeLoading" class="nu-empty">加载中…</div>
          <div v-else-if="!readme" class="nu-empty">该包未提供自述文件</div>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div v-else class="readme-body" v-html="readme"></div>
        </div>
      </div>

      <details class="options-block">
        <summary>选项</summary>
        <button @click="call('restore')" style="margin-top: 8px;" title="dotnet restore">dotnet restore</button>
      </details>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { call } from '../api/vscode';
import type { RefRow, PackageVersionsResult, PackageMetadata } from '../api/types';

interface PackageDetailData {
  id: string;
  installedVersion?: string;
  selectedVersion?: string;
  refreshKey?: number;
  /** 搜索结果自带的元数据（立即展示，不等后端 getPackageMetadata） */
  metaPreview?: Partial<PackageMetadata> | null;
}

const props = defineProps<{
  data: PackageDetailData | null;
  onAfterChange: () => void;
}>();

const rows = ref<RefRow[]>([]);
const versions = ref<PackageVersionsResult[]>([]);
const version = ref<string>('');
const busy = ref<'uninstall' | 'install' | null>(null);
const error = ref<string | null>(null);

const tab = ref<'details' | 'readme'>('details');
const meta = ref<PackageMetadata | null>(null);
const readme = ref<string>('');
const metaLoading = ref(false);
const readmeLoading = ref(false);
let metaSeq = 0;

const installedVersion = computed(() => props.data?.installedVersion);

/** 安装级别：'顶级' | '间接' | '未使用'（来自 getProjectReferencesForPackage 返回的 rows.level） */
const installTop = computed(() => rows.value.find((r) => r.level === '顶级'));
const installTransitive = computed(() => rows.value.find((r) => r.level === '间接'));
/** 已安装栏显示文本 + tooltip */
const installLevel = computed<'顶级' | '间接' | '未安装'>(() => {
  if (installTop.value) return '顶级';
  if (installTransitive.value) return '间接';
  // rows 还没加载完时，用 props.data.installedVersion 兜底
  if (rows.value.length === 0 && installedVersion.value) return '顶级';
  return '未安装';
});
const installLabel = computed(() => {
  if (installLevel.value === '顶级') {
    const v = installTop.value!.installed || installedVersion.value;
    return v ? `${v} (顶级)` : '(顶级)';
  }
  if (installLevel.value === '间接') {
    const v = installTransitive.value?.installed;
    return v ? `${v} (间接)` : '(间接安装)';
  }
  return '(未安装)';
});
const installHint = computed(() => {
  if (installLevel.value === '顶级') return `已在 ${installTop.value!.project} 中直接引用`;
  if (installLevel.value === '间接') return installTransitive.value?.installed
    ? `此包被其它包依赖传递引入（已解析到版本 ${installTransitive.value.installed}），不支持直接卸载`
    : '此包被其它包依赖传递引入，未在任何项目中直接引用';
  return '此包尚未安装';
});

/** 数字简洁化 */
function formatDownloads(n: number): string {
  if (n < 10_000) return String(n);
  if (n < 1_000_000) return `${(n / 10_000).toFixed(n < 100_000 ? 2 : 1)}万`;
  if (n < 100_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}百万`;
  if (n < 1_000_000_000) return `${(n / 100_000_000).toFixed(2)}亿`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}



async function loadFor(id: string) {
  error.value = null;
  try {
    const r = await call<{ rows: RefRow[] }>('getProjectReferencesForPackage', { packageId: id });
    rows.value = r?.rows || [];
    // 优先用搜索结果自带的 versions（含每版本下载量），拉不到再走 queryPackageVersions
    const pre = props.data?.metaPreview?.versions;
    let vs: PackageVersionsResult[] = [];
    if (pre?.length) {
      vs = pre.map((v) => ({ version: v.version, isPrerelease: v.version.includes('-') }));
    } else {
      const v = await call<{ versions: PackageVersionsResult[] }>('queryPackageVersions', {
        packageId: id,
        includePrerelease: true,
      });
      vs = v?.versions || [];
    }
    // 版本倒序排列（最新版本在前，与 VS 一致）
    vs.sort((a, b) => {
      const an = a.version.split('-')[0];
      const bn = b.version.split('-')[0];
      const segs = (s: string) => s.split('.').map((x) => parseInt(x, 10) || 0);
      const A = segs(an);
      const B = segs(bn);
      for (let i = 0; i < Math.max(A.length, B.length); i++) {
        const da = A[i] || 0, db = B[i] || 0;
        if (da !== db) return db - da;
      }
      // 同主版本（如 13.0.4 vs 13.0.4-beta1）：预发行排后面
      return (a.isPrerelease ? 1 : 0) - (b.isPrerelease ? 1 : 0);
    });
    versions.value = vs;
    // 每次选中/刷新包时，版本下拉默认选中「当前已安装版本」；
    // 未安装的包则回退到更新候选列表版本，最后取列表最新版本。
    const prefer = props.data?.installedVersion
      || props.data?.selectedVersion
      || versions.value[0]?.version;
    if (prefer) {
      const inList = versions.value.some((v) => v.version === prefer);
      version.value = inList ? prefer : (versions.value[0]?.version || prefer);
    }
  } catch (e: any) {
    error.value = e?.message || '加载失败';
  }
}

async function loadMetadata(id: string, ver: string) {
  const seq = ++metaSeq;
  metaLoading.value = true;
  readmeLoading.value = true;
  try {
    const r = await call<{ meta: PackageMetadata; readme: string }>('getPackageMetadata', { packageId: id, version: ver });
    if (seq !== metaSeq) return;
    meta.value = r?.meta;
    readme.value = r?.readme || '';
  } catch {
    if (seq === metaSeq) {
      meta.value = null;
      readme.value = '';
    }
  } finally {
    if (seq === metaSeq) {
      metaLoading.value = false;
      readmeLoading.value = false;
    }
  }
}

watch(
  () => [props.data?.id, props.data?.refreshKey] as const,
  async ([id]) => {
    if (!id) {
      rows.value = [];
      versions.value = [];
      meta.value = null;
      readme.value = '';
      return;
    }
    // 1. 立即用搜索结果自带的元数据渲染（不等网络请求）
    if (props.data?.metaPreview) {
      meta.value = props.data.metaPreview as PackageMetadata;
    }
    // 2. 后台加载项目引用 + 版本列表
    await loadFor(id);
    // 3. 等版本确定后再拉完整元数据 + readme 覆盖（metaPreview 只有搜索字段，可能缺 dependencyGroups/published）
    const ver = version.value || versions.value[0]?.version;
    if (ver) loadMetadata(id, ver);
  },
  { immediate: true },
);

// 当用户切换版本时，重新加载 metadata
watch(version, (ver) => {
  if (props.data?.id && ver) loadMetadata(props.data.id, ver);
});

async function doUninstall(project: string) {
  if (!props.data || !project) return;
  busy.value = 'uninstall';
  try {
    await call('uninstallPackage', { packageId: props.data.id, project });
    props.onAfterChange();
    const r = await call<{ rows: RefRow[] }>('getProjectReferencesForPackage', { packageId: props.data.id });
    rows.value = r?.rows || [];
  } catch (e: any) {
    error.value = e?.message || '卸载失败';
  } finally {
    busy.value = null;
  }
}

async function doInstall() {
  if (!props.data || !version.value) return;
  busy.value = 'install';
  try {
    const top = rows.value.find((r) => r.level === '顶级');
    const projectToInstall = top?.project || rows.value.find((r) => r.level !== '未使用')?.project;
    if (!projectToInstall) { error.value = '未找到可安装的项目'; return; }
    await call('installPackage', { packageId: props.data.id, version: version.value, project: projectToInstall });
    props.onAfterChange();
    const r = await call<{ rows: RefRow[] }>('getProjectReferencesForPackage', { packageId: props.data.id });
    rows.value = r?.rows || [];
  } catch (e: any) {
    error.value = e?.message || '安装失败';
  } finally {
    busy.value = null;
  }
}

async function onProjectCheck(row: RefRow, checked: boolean) {
  if (!props.data || busy.value) return;
  busy.value = checked ? 'install' : 'uninstall';
  try {
    if (checked) {
      await call('installPackage', { packageId: props.data.id, version: version.value || props.data.installedVersion || '', project: row.project });
    } else {
      await call('uninstallPackage', { packageId: props.data.id, project: row.project });
    }
    props.onAfterChange();
    const r = await call<{ rows: RefRow[] }>('getProjectReferencesForPackage', { packageId: props.data.id });
    rows.value = r?.rows || [];
  } catch (e: any) {
    error.value = e?.message || '操作失败';
  } finally {
    busy.value = null;
  }
}
</script>

<style scoped>
.nu-detail-section {
  margin-bottom: 6px;
}
.nu-hint-warn {
  color: var(--text-mute);
  font-size: 11px;
  margin: 4px 2px;
}
.nu-detail-head {
  display: flex; align-items: center; gap: 8px;
}
.nu-detail-head .icon img {
  width: 24px; height: 24px; display: block;
}
.nu-detail-version {
  color: var(--text-mute); font-size: 12px;
}
.nu-detail-tabs {
  display: flex; gap: 0;
  border-bottom: 1px solid var(--vscode-panel-border, #444);
  flex: 0 0 auto;
}
.nu-detail-tabs .nu-tab {
  padding: 6px 14px;
  cursor: pointer;
  color: var(--text-mute);
  border-bottom: 2px solid transparent;
  font-size: 13px;
}
.nu-detail-tabs .nu-tab.active {
  color: var(--text-strong);
  border-bottom-color: var(--vscode-button-background, #0e639c);
}
.nu-detail-body {
  padding: 10px 4px;
}
.nu-meta h3.meta-h { margin: 0 0 4px; font-size: 14px; }
.nu-meta .meta-desc { color: var(--text-mute); font-size: 12px; margin: 0 0 10px; white-space: pre-wrap; }
.meta-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.meta-table th { text-align: left; padding: 4px 8px 4px 0; color: var(--text-mute); width: 80px; vertical-align: top; font-weight: 500; }
.meta-table td { padding: 4px 0; vertical-align: top; word-break: break-word; }
.meta-deps { margin: 0; padding-left: 16px; }
.meta-deps li { line-height: 1.6; }
.meta-dep-ver { color: var(--text-mute); margin-left: 4px; font-size: 11.5px; }
.meta-dep-group { margin: 2px 0; font-size: 11.5px; }
.meta-dep-group summary { cursor: pointer; color: var(--text-mute); }
.meta-source { color: var(--text-mute); font-size: 11px; word-break: break-all; }
.nu-readme .readme-body {
  word-break: break-word;
  font-size: 12px; line-height: 1.55;
  padding: 8px 4px;
  color: var(--text-strong);
}
.nu-readme .readme-body .md-h { margin: 14px 0 6px; font-weight: 600; }
.nu-readme .readme-body h1.md-h { font-size: 18px; }
.nu-readme .readme-body h2.md-h { font-size: 15px; }
.nu-readme .readme-body h3.md-h, .nu-readme .readme-body h4.md-h { font-size: 13px; }
.nu-readme .readme-body .md-p { margin: 6px 0; }
.nu-readme .readme-body .md-code {
  background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.2));
  padding: 1px 4px; border-radius: 3px;
  font-family: var(--vscode-editor-fontFamily, monospace);
  font-size: 11px;
}
.nu-readme .readme-body .md-pre {
  background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.2));
  padding: 8px; border-radius: 4px; overflow: auto;
  font-family: var(--vscode-editor-fontFamily, monospace);
  font-size: 11px; line-height: 1.5;
}
.nu-readme .readme-body .md-li { margin: 2px 0 2px 8px; }
.nu-readme .readme-body .md-quote {
  margin: 6px 0; padding: 2px 10px;
  border-left: 3px solid var(--vscode-panel-border, #444);
  color: var(--text-mute);
}
.nu-readme .readme-body .md-hr { border: none; border-top: 1px solid var(--vscode-panel-border, #444); margin: 10px 0; }
.nu-readme .readme-body .md-table { border-collapse: collapse; margin: 8px 0; }
.nu-readme .readme-body .md-table th, .nu-readme .readme-body .md-table td {
  border: 1px solid var(--vscode-panel-border, #444);
  padding: 4px 8px; font-size: 11px;
}
.nu-readme .readme-body a { color: var(--text-link, #4ec9b0); }
</style>