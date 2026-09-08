import * as vscode from 'vscode';
import * as path from 'path';
import type { SourceConfig } from '../nuget/packageSource';

/** 共享消息总线（extension 端 ↔ webview 桥） */
type Handler = (payload: any) => Promise<any> | any;

class MessageBus {
  private handlers = new Map<string, Handler>();
  on(name: string, fn: Handler) { this.handlers.set(name, fn); }
  async dispatch(name: string, payload: any): Promise<any> {
    const h = this.handlers.get(name);
    if (!h) return null;
    try { return await h(payload); } catch (e) { return { _error: (e as Error).message }; }
  }
}

export class NugetPanel {
  static current?: NugetPanel;
  static bus = new MessageBus();

  readonly panel: vscode.WebviewPanel;

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
  }

  static showOrCreate(context: vscode.ExtensionContext) {
    if (NugetPanel.current) {
      NugetPanel.current.panel.reveal(vscode.ViewColumn.Two);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'nuget.solutionManager',
      'NuGet - 解决方案',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, 'dist', 'webview')),
        ],
      },
    );
    const inst = new NugetPanel(panel);
    NugetPanel.current = inst;
    panel.webview.html = inst.htmlForWebview(context);
    panel.webview.onDidReceiveMessage((msg) => inst.handleMessage(msg));
    panel.onDidDispose(() => { NugetPanel.current = undefined; });
  }

  postSolutionChanged() {
    this.panel.webview.postMessage({ channel: 'solutionChanged', payload: null });
  }
  postInstalledChanged() {
    this.panel.webview.postMessage({ channel: 'installedChanged', payload: null });
  }
  postSourcesChanged(snap: { sources: SourceConfig[]; active: string; default: string }) {
    this.panel.webview.postMessage({ channel: 'sourcesChanged', payload: snap });
  }
  focus() { this.panel.reveal(); }

  private async handleMessage(msg: any) {
    if (!msg || typeof msg !== 'object') return;
    const { id, name, payload } = msg;
    const result = await NugetPanel.bus.dispatch(name, payload);
    this.panel.webview.postMessage({ id, result });
  }

  private htmlForWebview(ctx: vscode.ExtensionContext): string {
    const distDir = path.join(ctx.extensionPath, 'dist', 'webview');
    const scriptUri = this.panel.webview.asWebviewUri(vscode.Uri.file(path.join(distDir, 'assets', 'index.js')));
    const cssUri    = this.panel.webview.asWebviewUri(vscode.Uri.file(path.join(distDir, 'assets', 'index.css')));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; img-src ${this.panel.webview.cspSource} data: https: http:; script-src ${this.panel.webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <base href="${this.panel.webview.asWebviewUri(vscode.Uri.file(distDir))}/" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>NuGet - 解决方案</title>
</head>
<body>
  <div id="app"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
