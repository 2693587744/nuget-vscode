/**
 * 极简的 XML 解析器，用于解析 csproj / fsproj。
 * csproj 通常包含一些 VS 特有的元素（MSBuild 条件、XML namespaces），
 * 标准 DOM 也能处理，但 dom 库体积太大；这里用一个能处理的轻量解析器。
 */
export interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  text?: string; // 文本内容（合并子文本节点）
}

/** 解析 XML 文本并返回真正的根元素（不做 csproj 专用兜底）。容错：忽略 <??>，跳过 DOCTYPE、注释；不依赖外部库 */
export function parseDocument(xml: string): Node {
  // 去除 BOM
  xml = xml.replace(/^\uFEFF/, '');
  let i = 0;
  const len = xml.length;

  const skipWs = () => { while (i < len && /\s/.test(xml[i])) i++; };

  const readComment = () => { /* <!-- ... --> */
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      i = end < 0 ? len : end + 3;
    }
  };

  const readPI = () => {
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2);
      i = end < 0 ? len : end + 2;
    }
  };

  const readDoctype = () => {
    if (xml.toLowerCase().startsWith('<!doctype', i)) {
      const end = xml.indexOf('>', i);
      i = end < 0 ? len : end + 1;
    }
  };

  const readCData = (): string => {
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9);
      const text = xml.slice(i + 9, end < 0 ? len : end);
      i = end < 0 ? len : end + 3;
      return text;
    }
    return '';
  };

  const readElement = (): Node => {
    if (xml[i] !== '<') throw new Error(`expect '<' at ${i}`);
    i++;
    // end tag
    if (xml[i] === '/') {
      const end = xml.indexOf('>', i);
      const name = xml.slice(i + 1, end).trim();
      i = end + 1;
      // 用 0x00 哨兵识别"结束哨兵"
      return { tag: '/' + name, attrs: {}, children: [] };
    }

    // 读取 tag 名称
    const nameStart = i;
    while (i < len && !/[\s/>]/.test(xml[i])) i++;
    const tag = xml.slice(nameStart, i);
    const node: Node = { tag, attrs: {}, children: [] };

    // 读属性
    skipWs();
    while (i < len && xml[i] !== '/' && xml[i] !== '>') {
      skipWs();
      const aStart = i;
      while (i < len && !/[\s=]/.test(xml[i])) i++;
      const aName = xml.slice(aStart, i);
      if (!aName) break;
      skipWs();
      if (xml[i] !== '=') { node.attrs[aName] = ''; continue; }
      i++;
      skipWs();
      const q = xml[i];
      let aVal = '';
      if (q === '"' || q === '\'') {
        i++;
        const vStart = i;
        while (i < len && xml[i] !== q) i++;
        aVal = xml.slice(vStart, i);
        i++;
      }
      node.attrs[aName] = aVal;
      skipWs();
    }

    // 自闭合
    if (xml[i] === '/') {
      i++;
      if (xml[i] === '>') i++;
      return node;
    }
    if (xml[i] === '>') i++;

    // 读子节点 / 文本
    while (i < len) {
      if (xml.startsWith('</', i)) {
        const end = xml.indexOf('>', i);
        i = end + 1;
        return node;
      }
      if (xml.startsWith('<!--', i)) { readComment(); continue; }
      if (xml.startsWith('<?', i)) { readPI(); continue; }
      if (xml.startsWith('<![CDATA[', i)) {
        const t = readCData();
        node.text = (node.text || '') + t;
        continue;
      }
      if (xml[i] === '<') {
        node.children.push(readElement());
        continue;
      }
      // 文本
      const tStart = i;
      while (i < len && xml[i] !== '<') i++;
      const txt = xml.slice(tStart, i).trim();
      if (txt) node.text = (node.text || '') + txt;
    }
    return node;
  };

  // 跳过声明 / doc / 注释
  while (i < len) {
    if (xml.startsWith('<?', i)) { readPI(); continue; }
    if (xml.startsWith('<!--', i)) { readComment(); continue; }
    if (xml.toLowerCase().startsWith('<!doctype', i)) { readDoctype(); continue; }
    break;
  }
  skipWs();
  return readElement();
}

/** 兼容 csproj：若根节点不是 <Project>（例如被外层元素包裹），退回到第一个子节点 */
function nodeOrRealRoot(n: Node): Node {
  if (!n.children.length) return n;
  // 通常根节点就是 <Project>
  if (n.tag === 'Project') return n;
  return n.children[0];
}

/** 解析 csproj/fsproj 文本（保留历史行为：尽量返回 <Project> 根节点） */
export function parse(xml: string): Node {
  return nodeOrRealRoot(parseDocument(xml));
}

/** 按路径查找第一个节点，例如 "PropertyGroup/TargetFramework" */
export function findPath(n: Node, path: string): Node | null {
  if (!path) return null;
  const parts = path.split('/');
  let cur: Node | undefined = n;
  for (const p of parts) {
    if (!cur) return null;
    cur = cur.children.find((c) => c.tag === p);
  }
  return cur || null;
}

/** 查找所有同名节点（DFS） */
export function findAll(n: Node, tag: string): Node[] {
  const out: Node[] = [];
  const walk = (x: Node) => {
    if (x.tag === tag) out.push(x);
    for (const c of x.children) walk(c);
  };
  walk(n);
  return out;
}

/** 查找所有同名节点（仅一层） */
export function findChildren(n: Node, tag: string): Node[] {
  return n.children.filter((c) => c.tag === tag);
}
