# 修复说明：webview 空白

## 原因
- HTML mount 节点是 `<div id="root">`，但前端 Vue `main.ts` 用的 `#app` → 找不到节点，不报错但完全空白
- vite 产物 index.html 不被使用（后端自己拼 HTML），所以 vite base 路径无关

## 修复
1. `nugetPanel.ts`：HTML 改用 `<div id="app">`，去掉 inline 注入脚本，改为直接 `<script src="...">`，加 `<base>` 标签
2. `vite.config.ts`：加 `base: './'`（保险起见，防止以后切到 vite 产物）

## 部署
已重新构建并部署到 `C:\Users\Administrator\.vscode\extensions\nuget-vscode-0.1.0`

## 验证
需要**重新打开 VSCode** 加载新 webview。再次右键 .sln → 管理 NuGet 程序包 即可。
