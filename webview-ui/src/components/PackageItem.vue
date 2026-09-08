<template>
  <div
    class="nu-item"
    :class="{ selected }"
    @click="onClick"
  >
    <div class="icon" :class="{ update: isUpdate }">
      <img
        v-if="data.iconUrl && !iconFailed"
        :src="data.iconUrl"
        alt=""
        @error="iconFailed = true"
      />
      <span v-else style="font-size: 20px;">📦</span>
    </div>
    <div class="meta">
      <div class="top">
        <span class="name">{{ data.id }}</span>
        <span
          v-if="data.verified"
          class="badge-verified"
          title="NuGet 已验证发布者：由官方或已验证的所有者发布，可信度高"
        >已验证</span>
        <span v-if="authorText" class="author" :title="authorText">{{ authorText }}</span>
        <span v-if="typeof data.totalDownloads === 'number'" class="downloads" :title="`总下载量 ${data.totalDownloads.toLocaleString()}`">
          {{ formatDownloads(data.totalDownloads) }} 下载
        </span>
        <!-- 版本号与包名/下载量同一行，靠右 -->
        <div class="vers" @click.stop>
          <template v-if="mode === 'browse'">
            <span v-if="data.version" class="ver">{{ data.version }}</span>
            <span v-if="data.latestPrerelease && data.latestPrerelease !== data.version" class="ver prerelease">{{ data.latestPrerelease }}</span>
          </template>

          <template v-else-if="mode === 'installed'">
            <span v-if="data.version" class="ver">{{ data.version }}</span>
          </template>

          <template v-else-if="mode === 'update'">
            <span v-if="data.current" class="ver outdated" :title="`当前版本 ${data.current}`">{{ data.current }}</span>
            <span v-if="data.latest" class="ver target" :title="`可更新到 ${data.latest}`">→ {{ data.latest }}</span>
          </template>

          <template v-else-if="mode === 'consolidate'">
            <span v-if="data.current" class="ver">已安装：{{ data.current }}</span>
            <span v-if="data.latest" class="ver target">可用：{{ data.latest }}</span>
          </template>

          <label v-if="!!onCheckChange">
            <input
              type="checkbox"
              :checked="!!checked"
              @change="onCheckChange!(($event.target as HTMLInputElement).checked)"
            />
          </label>
        </div>
      </div>
      <div
        ref="descEl"
        class="desc"
        @mouseenter="onDescEnter"
        @mousemove="onDescMove"
        @mouseleave="onDescLeave"
      >{{ data.description || 'Package Description' }}</div>
      <div v-if="data.isPrerelease" class="pre-badge">预发行版</div>
    </div>
  </div>

  <Teleport to="body">
    <div
      v-if="tip.visible"
      ref="tipEl"
      class="nu-tip"
      :style="{ left: tip.x + 'px', top: tip.y + 'px' }"
    >{{ tip.text }}</div>
  </Teleport>
</template>

<script setup lang="ts">
import type { PackageItemData } from '../api/types';
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';

const props = defineProps<{
  data: PackageItemData;
  mode: 'browse' | 'installed' | 'update' | 'consolidate';
  selected?: boolean;
  checked?: boolean;
  onCheckChange?: (v: boolean) => void;
  onClick?: () => void;
}>();

/** 描述 DOM + 是否被两行截断（截断时才弹 tooltip，短描述悬停不弹提示） */
const descEl = ref<HTMLElement | null>(null);
const truncated = ref(false);
const tipEl = ref<HTMLElement | null>(null);
/** 包图标加载失败时回退到默认占位图 */
const iconFailed = ref(false);

/** 自定义 tooltip：VS Code Webview 会禁用原生 title，必须用 DOM 浮层 */
const tip = reactive({ visible: false, text: '', x: 0, y: 0 });

function measureDesc() {
  const el = descEl.value;
  if (!el) return;
  truncated.value = el.scrollHeight > el.clientHeight + 1;
}

function descText(): string {
  return props.data.description || 'Package Description';
}

/** 跟随鼠标定位，自动翻转避免超出视口 */
function placeTip(e: MouseEvent) {
  const el = tipEl.value;
  const pad = 12;
  const tw = el ? el.offsetWidth : 220;
  const th = el ? el.offsetHeight : 40;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + tw + pad > window.innerWidth) x = e.clientX - tw - pad;
  if (y + th + pad > window.innerHeight) y = e.clientY - th - pad;
  tip.x = x;
  tip.y = y;
}

async function onDescEnter(e: MouseEvent) {
  measureDesc();
  if (!truncated.value) return;
  tip.text = descText();
  tip.visible = true;
  await nextTick();
  placeTip(e);
}

function onDescMove(e: MouseEvent) {
  if (!tip.visible) return;
  placeTip(e);
}

function onDescLeave() {
  tip.visible = false;
}

onMounted(async () => {
  await nextTick();
  measureDesc();
  window.addEventListener('resize', measureDesc);
});

watch(
  () => props.data,
  () => {
    // 切换包时重置图标加载状态，重新尝试加载该包的真实图标
    iconFailed.value = false;
    nextTick(measureDesc);
  },
);

onUnmounted(() => window.removeEventListener('resize', measureDesc));

const emit = defineEmits<{
  (e: 'click'): void;
  (e: 'checkChange', value: boolean): void;
}>();

const isUpdate = computed(() => props.mode === 'update');

/** 作者显示：优先搜索结果自带的 authors 数组；兼容单数 author 字段 */
const authorText = computed(() => {
  const arr = props.data.authors?.filter((a) => typeof a === 'string' && a.trim());
  return arr && arr.length ? arr.join(', ') : (props.data.author || '');
});

/** 数字简洁化：9078 / 6.2万 / 1.38亿 */
function formatDownloads(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 10_000).toFixed(n < 100_000 ? 2 : 1)}万`;
  if (n < 100_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}百万`;
  if (n < 1_000_000_000) return `${(n / 100_000_000).toFixed(2)}亿`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function onClick() {
  emit('click');
}
</script>
