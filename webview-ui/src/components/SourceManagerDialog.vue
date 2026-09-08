<template>
  <div class="src-mgr-mask" @click.self="$emit('close')">
    <div class="src-mgr-dialog">
      <div class="src-mgr-header">
        <div class="src-mgr-title">程序包源</div>
        <span class="src-mgr-hint">配置仅保存到用户全局设置，不写入项目内 nuget.config</span>
        <button class="src-mgr-close" title="关闭" @click="$emit('close')">✕</button>
      </div>

      <div class="src-mgr-toolbar">
        <button class="src-mgr-add" @click="onAdd">+ 添加</button>
      </div>

      <table class="src-mgr-table">
        <thead>
          <tr>
            <th style="width: 60px" title="当前使用">当前</th>
            <th style="width: 60px">默认</th>
            <th>名称</th>
            <th>源 URL</th>
            <th style="width: 90px">HTTP 允许</th>
            <th style="width: 120px">状态</th>
            <th style="width: 280px"></th>
          </tr>
        </thead>
        <tbody>
          <!-- 全部 -->
          <tr :class="{ active: active === ALL }">
            <td>
              <span v-if="active === ALL" class="src-mgr-badge primary">当前</span>
            </td>
            <td>
              <span v-if="defaultSource === ALL" class="src-mgr-badge ok">默认</span>
            </td>
            <td>全部（使用所有源）</td>
            <td class="src-mgr-url">—</td>
            <td>—</td>
            <td>{{ sources.length }} 个源</td>
            <td class="src-mgr-actions">
              <button class="src-mgr-btn" @click="onSetDefault(ALL)" :disabled="defaultSource === ALL">
                设为默认
              </button>
            </td>
          </tr>

          <!-- 单个源 -->
          <tr v-for="s in sources" :key="s.name" :class="{ active: s.name === active }">
            <td>
              <span v-if="s.name === active" class="src-mgr-badge primary">当前</span>
            </td>
            <td>
              <span v-if="defaultSource === s.name" class="src-mgr-badge ok">默认</span>
            </td>
            <td>
              <input v-if="editing === s.name" v-model="draft.name" />
              <span v-else>{{ s.name }}</span>
            </td>
            <td>
              <input v-if="editing === s.name" v-model="draft.url" placeholder="https://.../v3/index.json" />
              <span v-else class="src-mgr-url">{{ s.url }}</span>
            </td>
            <td>
              <label v-if="editing === s.name">
                <input type="checkbox" v-model="draft.allowInsecureConnections" />
              </label>
              <span v-else>{{ s.allowInsecureConnections ? '是' : '否' }}</span>
            </td>
            <td>
              <span :class="['src-mgr-badge', probeResults[s.name]?.ok === true ? 'ok' : (probeResults[s.name]?.ok === false ? 'fail' : '')]">
                {{ statusOf(s.name) }}
              </span>
            </td>
            <td class="src-mgr-actions">
              <template v-if="editing === s.name">
                <button class="src-mgr-btn" @click="onSave(s.name)">保存</button>
                <button class="src-mgr-btn ghost" @click="editing = ''">取消</button>
              </template>
              <template v-else>
                <button class="src-mgr-btn" @click="onSetDefault(s.name)" :disabled="defaultSource === s.name">设为默认</button>
                <button class="src-mgr-btn ghost" @click="onEdit(s)">编辑</button>
                <button class="src-mgr-btn ghost" @click="onProbe(s)">验证</button>
                <button class="src-mgr-btn danger" @click="onDelete(s.name)" :disabled="sources.length <= 1">删除</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="src-mgr-footer">
        <span class="src-mgr-hint">"当前"切换由顶部下拉框承担；"设为默认"后下次打开面板自动选中。"全部"指同时使用所有已配置的源。勾选 HTTP 允许后可连接 http:// 内网包源（Baget、nexus 等）。</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue';
import { call, onNotice } from '../api/vscode';
import type { SourceConfig, SourceManagerSnapshot } from '../api/types';

const ALL = '__all__';

const emit = defineEmits<{ (e: 'close'): void; (e: 'changed'): void }>();

const sources = ref<SourceConfig[]>([]);
const active = ref<string>('');
const defaultSource = ref<string>('');
const editing = ref<string>('');
const draft = reactive<SourceConfig>({ name: '', url: '', allowInsecureConnections: false });
const probeResults = reactive<Record<string, { ok: boolean; error?: string; services?: string[] } | undefined>>({});
const probing = ref<Record<string, boolean>>({});

async function refresh() {
  const snap: SourceManagerSnapshot = await call('getSources');
  sources.value = snap.sources.slice();
  active.value = snap.active;
  defaultSource.value = snap.default;
}

function statusOf(name: string): string {
  if (probing.value[name]) return '检测中…';
  const r = probeResults[name];
  if (!r) return name === active.value ? '当前' : '未验证';
  if (r.ok) return `${r.services?.length ?? 0} 项服务`;
  return r.error || '失败';
}

function onSetActive(_name: string) {
  // 保留以兼容潜在旧调用，实际切源已统一由顶部下拉承担
}

function onSetDefault(name: string) {
  call('setDefaultSource', { name }).then((snap: SourceManagerSnapshot) => {
    active.value = snap.active;
    defaultSource.value = snap.default;
    emit('changed');
  });
}

function onAdd() {
  editing.value = '__new__';
  draft.name = '';
  draft.url = '';
  draft.allowInsecureConnections = false;
}

function onEdit(s: SourceConfig) {
  editing.value = s.name;
  draft.name = s.name;
  draft.url = s.url;
  draft.allowInsecureConnections = !!s.allowInsecureConnections;
}

async function onSave(originalName: string) {
  if (!draft.name.trim() || !draft.url.trim()) return;
  const payload: SourceConfig = {
    name: draft.name.trim(),
    url: draft.url.trim(),
    allowInsecureConnections: !!draft.allowInsecureConnections,
  };
  const snap: SourceManagerSnapshot = originalName === '__new__'
    ? await call('addSource', { source: payload })
    : await call('updateSource', { name: originalName, source: payload });
  sources.value = snap.sources.slice();
  active.value = snap.active;
  defaultSource.value = snap.default;
  editing.value = '';
  emit('changed');
}

async function onDelete(name: string) {
  const snap: SourceManagerSnapshot = await call('deleteSource', { name });
  sources.value = snap.sources.slice();
  active.value = snap.active;
  defaultSource.value = snap.default;
  emit('changed');
}

async function onProbe(s: SourceConfig) {
  probing.value = { ...probing.value, [s.name]: true };
  const r = await call('probeSource', { source: s });
  probeResults[s.name] = r as any;
  probing.value = { ...probing.value, [s.name]: false };
}

onMounted(refresh);

const off = onNotice((ch, p) => {
  if (ch === 'sourcesChanged') {
    sources.value = p.sources.slice();
    active.value = p.active;
    defaultSource.value = p.default;
  }
});
onUnmounted(() => off());
</script>

<style scoped>
.src-mgr-mask {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.35);
  display: flex; align-items: center; justify-content: center;
  z-index: 100;
}
.src-mgr-dialog {
  width: 960px; max-width: 94vw; max-height: 80vh;
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-foreground, #ddd);
  border: 1px solid var(--vscode-panel-border, #444);
  border-radius: 6px;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.src-mgr-header {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border, #444);
}
.src-mgr-title { font-size: 14px; font-weight: 600; }
.src-mgr-close {
  margin-left: auto;
  background: transparent; color: inherit; border: none; cursor: pointer; font-size: 14px;
}
.src-mgr-toolbar {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 14px; border-bottom: 1px solid var(--vscode-panel-border, #444);
}
.src-mgr-add {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none; padding: 4px 10px; cursor: pointer; border-radius: 3px;
}
.src-mgr-hint { font-size: 11px; opacity: 0.75; }
.src-mgr-table {
  width: 100%; border-collapse: collapse; font-size: 12px;
  overflow: auto; flex: 1;
}
.src-mgr-table th,
.src-mgr-table td {
  text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a);
  vertical-align: middle;
}
.src-mgr-table tr.active td { background: rgba(14,99,156,0.18); }
.src-mgr-url { color: var(--vscode-textLink-foreground, #4ec9b0); word-break: break-all; }
.src-mgr-actions { white-space: nowrap; }
.src-mgr-btn {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none; padding: 3px 8px; margin-right: 4px; cursor: pointer; border-radius: 3px; font-size: 11px;
}
.src-mgr-btn.ghost {
  background: transparent; color: var(--vscode-foreground, #ccc);
  border: 1px solid var(--vscode-panel-border, #555);
}
.src-mgr-btn.danger { background: transparent; color: var(--vscode-error-foreground, #f48771); border: 1px solid var(--vscode-error-foreground, #f48771); }
.src-mgr-btn[disabled] { opacity: 0.4; cursor: not-allowed; }
.src-mgr-badge {
  padding: 1px 6px; border-radius: 9px; font-size: 10px;
  background: var(--vscode-badge-background, #444); color: var(--vscode-badge-foreground, #ddd);
}
.src-mgr-badge.ok { background: #1b5e20; color: #c8e6c9; }
.src-mgr-badge.fail { background: #7f1d1d; color: #f8d7da; }
.src-mgr-badge.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
.src-mgr-footer {
  padding: 8px 14px; border-top: 1px solid var(--vscode-panel-border, #444);
}
input[type="text"], input:not([type]) {
  background: var(--vscode-input-background, #252526);
  color: var(--vscode-input-foreground, #ddd);
  border: 1px solid var(--vscode-input-border, #444);
  padding: 2px 5px; font-size: 12px; width: 100%; box-sizing: border-box;
}
</style>
