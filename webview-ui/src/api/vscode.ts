declare const acquireVsCodeApi: any;

let cached: any = null;
function getVsCode() {
  if (cached) return cached;
  if (typeof acquireVsCodeApi !== 'undefined') {
    cached = acquireVsCodeApi();
    return cached;
  }
  // 浏览器/Vite preview 兜底
  cached = {
    postMessage: () => {},
    setState: (s: any) => { (cached as any)._state = s; },
    getState: () => (cached as any)._state,
  };
  return cached;
}

type NoticeListener = (channel: string, payload: any) => void;
const noticeListeners: NoticeListener[] = [];
export function onNotice(fn: NoticeListener) {
  noticeListeners.push(fn);
  return () => {
    const i = noticeListeners.indexOf(fn);
    if (i >= 0) noticeListeners.splice(i, 1);
  };
}

let nextId = 1;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; }>();

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.channel) {
    noticeListeners.forEach((l) => l(msg.channel, msg.payload));
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.result && msg.result._error) {
      p.reject(new Error(msg.result._error));
    } else {
      p.resolve(msg.result);
    }
  }
});

export function call<T = any>(name: string, payload?: any): Promise<T> {
  const id = `m${nextId++}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getVsCode().postMessage({ id, name, payload });
    if (typeof acquireVsCodeApi === 'undefined') {
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve(null);
        }
      }, 30);
    }
  });
}
