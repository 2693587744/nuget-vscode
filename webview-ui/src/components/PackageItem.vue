<template>
  <div
    class="nu-item"
    :class="{ selected }"
    @click="onClick"
  >
    <div class="icon" :class="{ update: isUpdate }">
      <span style="font-size: 20px;">📦</span>
    </div>
    <div class="meta">
      <div class="top">
        <span class="name">{{ data.id }}</span>
        <span v-if="data.author" class="author">作者 {{ data.author }}</span>
        <span v-if="typeof data.totalDownloads === 'number'" class="downloads" :title="`总下载量 ${data.totalDownloads.toLocaleString()}`">
          {{ formatDownloads(data.totalDownloads) }} 下载
        </span>
      </div>
      <div class="desc">{{ data.description || 'Package Description' }}</div>
      <div v-if="data.isPrerelease" class="pre-badge">预发行版</div>
    </div>
    <div class="versions" @click.stop>
      <template v-if="mode === 'browse'">
        <div v-if="data.version" class="ver">{{ data.version }}</div>
        <div v-if="data.latestPrerelease && data.latestPrerelease !== data.version" class="ver prerelease">{{ data.latestPrerelease }}</div>
      </template>

      <template v-else-if="mode === 'installed'">
        <div v-if="data.version" class="ver">{{ data.version }}</div>
      </template>

      <template v-else-if="mode === 'update'">
        <div v-if="data.current" class="ver outdated">{{ data.current }}</div>
        <div v-if="data.latest" class="ver target">{{ data.latest }}</div>
      </template>

      <template v-else-if="mode === 'consolidate'">
        <div v-if="data.current" class="ver">已安装：{{ data.current }}</div>
        <div v-if="data.latest" class="ver target">可用：{{ data.latest }}</div>
      </template>

      <label v-if="!!onCheckChange" style="margin-top: 4px;">
        <input
          type="checkbox"
          :checked="!!checked"
          @change="onCheckChange!(($event.target as HTMLInputElement).checked)"
        />
      </label>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PackageItemData } from '../api/types';
import { computed } from 'vue';

const props = defineProps<{
  data: PackageItemData;
  mode: 'browse' | 'installed' | 'update' | 'consolidate';
  selected?: boolean;
  checked?: boolean;
  onCheckChange?: (v: boolean) => void;
  onClick?: () => void;
}>();

const emit = defineEmits<{
  (e: 'click'): void;
  (e: 'checkChange', value: boolean): void;
}>();

const isUpdate = computed(() => props.mode === 'update');

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
