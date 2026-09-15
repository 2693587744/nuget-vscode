<template>
  <div class="nu-root">
    <!-- 顶栏 -->
    <div class="nu-head">
      <div class="title">NuGet - {{ boot?.solution?.name || '解决方案' }}</div>
      <div class="spacer"></div>

      <label class="nu-source" title="程序包源">
        <span style="color: var(--text-mute)">程序包源:</span>
        <select v-model="activeSource" @change="onSourceChange">
          <option value="__all__">全部</option>
          <option v-for="s in boot?.sources || []" :key="s.name" :value="s.name">
            {{ s.name }}
          </option>
        </select>
      </label>
      <button class="nu-iconbtn" title="管理程序包源" @click="showSourceMgr = true">⚙</button>
      <div style="font-size: 12px; color: var(--text-mute)">管理解决方案包</div>
    </div>

    <!-- 包源管理对话框 -->
    <SourceManagerDialog v-if="showSourceMgr" @close="showSourceMgr = false" @changed="onSourcesChanged" />

    <!-- Tabs -->
    <div class="nu-tabs">
      <div :class="['nu-tab', { active: tab === 'browse' }]" @click="onTab('browse')">浏览</div>
      <div :class="['nu-tab', { active: tab === 'installed' }]" @click="onTab('installed')">
        已安装
        <span v-if="counts.installed > 0" class="badge warn">{{ counts.installed }}</span>
      </div>
      <div :class="['nu-tab', { active: tab === 'updates' }]" @click="onTab('updates')">
        更新
        <span v-if="counts.updates > 0" class="badge update">{{ counts.updates }}</span>
      </div>
      <div :class="['nu-tab', { active: tab === 'consolidate' }]" @click="tab = 'consolidate'">
        合并
        <span v-if="counts.consolidate > 0" class="badge">{{ counts.consolidate }}</span>
      </div>
    </div>

    <!-- Toolbar -->
    <div class="nu-toolbar">
      <div class="nu-search">
        <input
          type="text"
          placeholder="搜索(Ctrl+L)"
          v-model="query"
          @keydown.enter="onSearch"
        />
        <button
          v-if="query"
          class="nu-search-clear"
          title="清空"
          @click="query = ''"
        >✕</button>
      </div>
      <button @click="onSearch" title="刷新"> ↻</button>
      <label class="prerelease">
        <input type="checkbox" v-model="includePrerelease" @change="onPrereleaseChange" />
        <span>包括预发行版</span>
      </label>
    </div>

    <!-- Body -->
    <div class="nu-body">
      <div class="nu-list-pane">
        <!-- Updates -->
        <template v-if="tab === 'updates'">
          <div class="nu-bulk-row">
            <input
              type="checkbox"
              :checked="checked.size > 0 && checked.size === updatesItems.length"
              @change="toggleAll(($event.target as HTMLInputElement).checked)"
            />
            <span>选择所有的包</span>
            <div class="right">
              <button class="primary" :disabled="checked.size === 0" @click="bulkUpdate">更新</button>
            </div>
          </div>
          <div v-if="loadingTab === 'updates'" class="nu-empty col">
            <div class="spinner"></div>
            <span>检查更新中…</span>
          </div>
          <div v-else-if="filteredUpdates.length === 0" class="nu-empty col">
            <span v-if="boot">{{
              updatesItems.length === 0 ? '没有可更新的包' : '没有匹配搜索条件的包'
            }}</span>
            <span v-else>解决方案未加载。右键点击解决方案资源管理器中的 .sln 选择「管理解决方案的 NuGet 程序包」。</span>
          </div>
          <PackageItem
            v-for="it in filteredUpdates"
            :key="it.id"
            :data="it"
            mode="update"
            :selected="selected?.id.toLowerCase() === it.id.toLowerCase()"
            :checked="checked.has(it.id)"
            :onCheckChange="(v: boolean) => toggleOne(it.id, v)"
            @click="select(it)"
          />
        </template>

        <!-- Installed -->
        <template v-else-if="tab === 'installed'">
          <div v-if="filteredInstalled.length === 0" class="nu-empty col">
            <span v-if="boot">{{
              installedItems.length === 0 ? '解决方案没有引用任何包' : '没有匹配搜索条件的包'
            }}</span>
            <span v-else>请先加载解决方案</span>
          </div>
          <PackageItem
            v-for="it in filteredInstalled"
            :key="it.id"
            :data="it"
            mode="installed"
            :selected="selected?.id.toLowerCase() === it.id.toLowerCase()"
            @click="select(it)"
          />
        </template>

        <!-- Browse -->
        <template v-else-if="tab === 'browse'">
          <div v-if="loadingTab === 'browse' && browseItems.length === 0" class="nu-empty col">
            <div class="spinner"></div>
            <span>加载中…</span>
          </div>
          <div v-else-if="filteredBrowse.length === 0" class="nu-empty col">
            <span>未匹配到包</span>
          </div>
          <PackageItem
            v-for="it in filteredBrowse"
            :key="it.id"
            :data="it"
            mode="browse"
            :selected="selected?.id.toLowerCase() === it.id.toLowerCase()"
            @click="select(it)"
          />
          <div ref="browseSentinel" class="nu-sentinel">
            <span v-if="browseLoading">加载中…</span>
            <span v-else-if="browseHasMore">向下滚动加载更多</span>
            <span v-else-if="browseItems.length > 0" class="nu-mute">— 已加载全部 —</span>
          </div>
        </template>

        <!-- Consolidate -->
        <template v-else>
          <div class="nu-empty col">尚无合并项</div>
        </template>
      </div>

      <div v-if="selected" class="nu-detail-pane" style="flex: 0 0 480px">
        <DetailPanel :data="detailData" :onAfterChange="onAfterChange" :onClose="closeDetail" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch, nextTick } from 'vue';
import { call, onNotice } from './api/vscode';
import type {
  Bootstrap,
  PackageItemData,
  RefRow,
} from './api/types';
import PackageItem from './components/PackageItem.vue';
import DetailPanel from './components/DetailPanel.vue';
import SourceManagerDialog from './components/SourceManagerDialog.vue';

type Tab = 'browse' | 'installed' | 'updates' | 'consolidate';

const boot = ref<Bootstrap | null>(null);
const tab = ref<Tab>('updates');
const showSourceMgr = ref(false);
const query = ref('');
const includePrerelease = ref(false);
const activeSource = ref('');

const browseItems = ref<PackageItemData[]>([]);
const installedItems = ref<PackageItemData[]>([]);
const updatesItems = ref<PackageItemData[]>([]);

// 分页加载状态
const PAGE_SIZE = 30;
const browseSkip = ref(0);
const browseHasMore = ref(false);
const browseLoading = ref(false);
const browseSentinel = ref<HTMLElement | null>(null);
let browseObserver: IntersectionObserver | null = null;

function setupBrowseObserver() {
  if (browseObserver) browseObserver.disconnect();
  if (!browseSentinel.value) return;
  browseObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) loadMoreBrowse();
      }
    },
    { rootMargin: '120px' },
  );
  browseObserver.observe(browseSentinel.value);
}

const selected = ref<PackageItemData | null>(null);
const detailRefreshKey = ref(0);
const loadingTab = ref<Tab | null>(null);

const checked = ref<Set<string>>(new Set());

let unsubNotice: (() => void) | null = null;

onMounted(async () => {
  // 先注册通知监听，避免在 await bootstrap 期间错过 sourcesChanged
  unsubNotice = onNotice((channel, payload: any) => {
    if (channel === 'solutionChanged' || channel === 'installedChanged') {
      reloadAll();
      // 安装/卸载/恢复后，间接依赖信息依赖 asset.json 的重建结果；刷新已选中详情面板
      if (selected.value) detailRefreshKey.value += 1;
    } else if (channel === 'sourcesChanged') {
      // 顶栏 ↔ 对话框 ↔ 列表 三方联动：保证两个控件选中始终一致
      if (payload) {
        if (boot.value) {
          if (Array.isArray(payload.sources)) boot.value.sources = payload.sources;
          if (typeof payload.active === 'string') boot.value.activeSource = payload.active;
        }
        if (typeof payload.active === 'string') activeSource.value = payload.active;
        refreshBrowse();
        refreshUpdates();
      }
    }
  });
  const b = await call<Bootstrap>('getBootstrapData');
  if (b) {
    boot.value = b;
    activeSource.value = b.activeSource;
    includePrerelease.value = !!b.includePrerelease;
    // 打开面板时默认激活的页签（用户可在设置中配置：浏览 / 已安装 / 更新）
    if (b.defaultTab === 'browse' || b.defaultTab === 'installed' || b.defaultTab === 'updates') {
      tab.value = b.defaultTab;
    }
    await refreshInstalled();
    await refreshUpdates();
    await refreshBrowse();
  }
});

onUnmounted(() => {
  if (unsubNotice) unsubNotice();
});

async function reloadAll() {
  const b = await call<Bootstrap>('getBootstrapData');
  if (b) {
    boot.value = b;
    activeSource.value = b.activeSource;
    includePrerelease.value = !!b.includePrerelease;
    await refreshInstalled();
    await refreshUpdates();
  }
}

async function refreshInstalled() {
  if (!boot.value) return;
  // key 用小写（保证查重），value 同时保留原大小写 id 用于列表展示
  const map = new Map<string, { id: string; version: string }>();
  for (const p of boot.value.solution.projects) {
    for (const r of p.packageReferences) {
      const key = r.name.toLowerCase();
      const cur = map.get(key);
      if (!cur || cur.version === '*') {
        map.set(key, { id: r.name, version: r.version });
      } else if (r.version !== '*') {
        // 多个项目用不同版本时，保留先遇到的"显式版本"，丢弃 '*'
        cur.version = r.version;
      }
    }
  }
  const list = Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
  installedItems.value = list.map((v) => ({ id: v.id, version: v.version } as PackageItemData));
  // 后台补包图标（flat-container 模板 URL，无网络请求；404 时列表自动回退默认图标）
  await attachIcons(list.map((v) => ({ id: v.id, version: v.version })), installedItems.value);
}

/** 为列表项按 id 补充 iconUrl（后端按 flat-container 模板构造，加载失败由行内回退默认图） */
async function attachIcons(versions: { id: string; version?: string }[], items: PackageItemData[]) {
  try {
    const r = await call<{ icons: Record<string, string | null> }>('getPackageIcons', {
      packages: versions.filter((v) => v.version && v.version !== '*') as { id: string; version: string }[],
    });
    const icons = r?.icons || {};
    for (const it of items) {
      const url = icons[it.id];
      if (url) it.iconUrl = url;
    }
  } catch { /* 图标获取失败则保持默认占位图 */ }
}

async function refreshUpdates() {
  if (!boot.value) return;
  loadingTab.value = 'updates';
  try {
    const r = await call<{ items: { id: string; current: string; latest: string; isPrerelease?: boolean }[] }>(
      'getUpdateCandidates',
      { includePrerelease: includePrerelease.value },
    );
    const list = r?.items || [];
    updatesItems.value = list
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((u) => ({
        id: u.id,
        current: u.current,
        latest: u.latest,
        isPrerelease: u.isPrerelease,
      }));
    // 后台补包图标（用当前已装版本构造）
    await attachIcons(list.map((u) => ({ id: u.id, version: u.current })), updatesItems.value);
  } finally {
    loadingTab.value = null;
  }
}

/** 序列号：每次 refreshBrowse 自增，并发请求靠它筛选过期响应 */
let browseRequestSeq = 0;

/** 重置并加载首页 */
async function refreshBrowse() {
  if (browseLoading.value) return;
  browseItems.value = [];
  browseSkip.value = 0;
  browseHasMore.value = false;
  await loadBrowsePage();
}

/** 加载下一页（滚动到底触发） */
async function loadMoreBrowse() {
  if (browseLoading.value || !browseHasMore.value) return;
  await loadBrowsePage();
}

async function loadBrowsePage() {
  // 整段加锁，并发的请求直接丢弃
  if (browseLoading.value) return;
  loadingTab.value = 'browse';
  browseLoading.value = true;
  const seq = ++browseRequestSeq;
  const skipAtCall = browseSkip.value;
  try {
    const r = await call<{ items: PackageItemData[] }>(
      'queryPackages',
      { includePrerelease: includePrerelease.value, query: query.value, take: PAGE_SIZE, skip: skipAtCall },
    );
    // 期间用户可能触发了新的 refreshBrowse（skip 被改回 0），本响应已过期，丢弃
    if (seq !== browseRequestSeq) return;
    const list = (r?.items || []);
    // 全量透传：搜索结果本身就带 title/summary/iconUrl/licenseUrl/projectUrl/tags/owners/versions 等
    const append = list.map((b) => ({ ...b } as PackageItemData));
    if (skipAtCall === 0) {
      browseItems.value = dedupById(append);
    } else {
      browseItems.value = dedupById(browseItems.value.concat(append));
    }
    browseSkip.value = skipAtCall + list.length;
    // 如果返回的数量等于 PAGE_SIZE，说明可能有下一页
    browseHasMore.value = list.length >= PAGE_SIZE;
  } finally {
    if (seq === browseRequestSeq) loadingTab.value = null;
    browseLoading.value = false;
  }
}

/** 按 id（不区分大小写）去重，保留首次出现的项 */
function dedupById(items: PackageItemData[]): PackageItemData[] {
  const seen = new Set<string>();
  const out: PackageItemData[] = [];
  for (const it of items) {
    const k = it.id.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function onTab(t: Tab) {
  tab.value = t;
  if (t === 'browse') refreshBrowse();
}

/** 刷新按钮 / 回车：重载当前激活面板的数据 */
async function onSearch() {
  if (tab.value === 'browse') {
    // 浏览：重新按当前关键词搜索
    await refreshBrowse();
    return;
  }
  if (!boot.value) return;
  // 已安装 / 更新 / 合并 的数据均源自解决方案：
  // 通知后端重新解析 csproj（捕获外部改动），后端随后广播 solutionChanged → 前端 reloadAll 重载当前面板
  await call('reload');
}

// 边输入边查（仅在浏览 tab）。debounce 300ms。
let searchTimer: number | undefined;
watch(query, () => {
  if (tab.value !== 'browse') return;
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    refreshBrowse();
  }, 300);
});

// tab 切换 + 列表变化时重新装 IntersectionObserver
watch([tab, browseItems], () => {
  if (tab.value !== 'browse') return;
  nextTick(() => setupBrowseObserver());
});

onUnmounted(() => {
  if (browseObserver) browseObserver.disconnect();
});

async function onPrereleaseChange() {
  await call('setIncludePrerelease', { value: includePrerelease.value });
  await refreshBrowse();
  await refreshUpdates();
}

async function onSourceChange() {
  const snap = await call<{ sources: any[]; active: string }>('setActiveSource', { name: activeSource.value });
  if (snap?.active) {
    activeSource.value = snap.active;
    if (boot.value) boot.value.activeSource = snap.active;
  }
  await refreshBrowse();
  await refreshUpdates();
}

async function onSourcesChanged() {
  const snap = await call<{ sources: any[]; active: string }>('getSources');
  if (snap) {
    if (boot.value) {
      boot.value.sources = snap.sources;
      boot.value.activeSource = snap.active;
    }
    activeSource.value = snap.active;
    await refreshBrowse();
    await refreshUpdates();
  }
}

function select(it: PackageItemData) {
  selected.value = it;
}

/** 关闭详情面板（右侧栏收起，列表铺满） */
function closeDetail() {
  selected.value = null;
}

async function onAfterChange() {
  detailRefreshKey.value += 1;
  await refreshInstalled();
  await refreshUpdates();
}

const filteredBrowse = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return browseItems.value;
  return browseItems.value.filter((i) => i.id.toLowerCase().includes(q));
});

const filteredInstalled = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return installedItems.value;
  return installedItems.value.filter((i) => i.id.toLowerCase().includes(q));
});

const filteredUpdates = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return updatesItems.value;
  return updatesItems.value.filter((i) => i.id.toLowerCase().includes(q));
});

const counts = computed(() => ({
  installed: installedItems.value.length,
  updates: updatesItems.value.length,
  consolidate: 0,
}));

function toggleAll(v: boolean) {
  checked.value = v ? new Set(updatesItems.value.map((u) => u.id)) : new Set();
}

function toggleOne(id: string, v: boolean) {
  const next = new Set(checked.value);
  if (v) next.add(id);
  else next.delete(id);
  checked.value = next;
}

async function bulkUpdate() {
  for (const id of Array.from(checked.value)) {
    const upd = updatesItems.value.find((u) => u.id === id);
    if (!upd) continue;
    const target = boot.value?.solution.projects.find((p) =>
      p.packageReferences.some((r) => r.name.toLowerCase() === id.toLowerCase()),
    );
    if (!target) continue;
    await call('installPackage', { packageId: id, version: upd.latest, project: target.name });
  }
  checked.value = new Set();
  await onAfterChange();
}

const detailData = computed(() => {
  if (!selected.value) return null;
  const selId = selected.value.id;
  const selIdLower = selId.toLowerCase();
  // 1) 精确匹配；2) 不区分大小写匹配
  const installed = installedItems.value.find((i) => i.id === selId)
    ?? installedItems.value.find((i) => i.id.toLowerCase() === selIdLower);
  // updatesItems 是从后端拉来的"可更新候选"，最新版本字段是 latest
  const upd = updatesItems.value.find((i) => i.id.toLowerCase() === selIdLower);
  // 浏览列表项自带完整元数据（搜索结果），优先取它传给详情面板
  const browseItem = browseItems.value.find((i) => i.id.toLowerCase() === selIdLower);
  return {
    id: selId,
    installedVersion: installed?.version,
    // 优先级：有可更新候选 latest > 浏览列表 version > 选中项 version
    selectedVersion: upd?.latest || browseItem?.version || selected.value.version,
    refreshKey: detailRefreshKey.value,
    // 搜索结果自带的元数据（立即展示，不等 getPackageMetadata 返回）
    metaPreview: browseItem ? {
      title: browseItem.title,
      description: browseItem.description,
      summary: browseItem.summary,
      authors: browseItem.authors,
      owners: browseItem.owners,
      iconUrl: browseItem.iconUrl,
      licenseUrl: browseItem.licenseUrl,
      projectUrl: browseItem.projectUrl,
      tags: browseItem.tags,
      totalDownloads: browseItem.totalDownloads,
      verified: browseItem.verified,
      versions: browseItem.versions,
      packageTypes: browseItem.packageTypes,
      vulnerabilities: browseItem.vulnerabilities,
    } : null,
  };
});
</script>
