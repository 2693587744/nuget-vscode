# NuGet-VSCode 扩展 — 使用说明

## 已安装
扩展已安装到你的 VSCode 中：
- 目录：`C:\Users\Administrator\.vscode\extensions\nuget-vscode-0.1.0`
- 名称：`nuget-vscode`
- 版本：`0.1.0`

## 启动 VSCode
打开 VSCode 加载你的 .NET 解决方案工作区（包含一个或多个 .sln 的文件夹）。

## 触发方式
1. 在 VSCode 资源管理器中**右键 .sln 文件**
2. 选择 **"管理解决方案的 NuGet 程序包(N)..."**
3. 扩展会解析 .sln 和所有 .csproj，弹出 NuGet 管理器

## 主要功能（仿 VS 2026 NuGet UI）
- **浏览**：搜索远程包，勾选安装（需要配置 nuget.org 源；离线时回退到内置 mock）
- **已安装**：列出解决方案已引用的所有包及版本，可卸载
- **更新**：勾选多个包一键更新，右上"选择所有的包"主复选框
- **合并**：空 tab（VS 2026 中用于多版本冲突，本版本未实现完整检测）
- **程序包源下拉**：左上角切换源
- **包括预发行版**开关：右上角
- **右侧详情面板**：
  - 显示该包在每个项目中的引用
  - **顶级**（绿色）/ **间接**（黄色）级别标签
  - 卸载按钮（仅顶级）
  - 版本下拉框：可选择"最新预发行版"或任意历史版本，一键安装

## 离线/无网络时
扩展内置 mock 数据集，可正常浏览、查看引用、卸载/安装（即修改 .csproj），无需 nuget.org。

## 重新构建
修改源码后：
```bash
cd C:\Users\Administrator\.qclaw\workspace\nuget-vscode
npm install
cd webview-ui && npm install && cd ..
npm run build
npx vsce package --no-dependencies
```
然后把 `nuget-vscode-0.1.0.vsix` 拖到 VSCode 扩展视图，或：
```bash
code --install-extension nuget-vscode-0.1.0.vsix
```

## 卸载
VSCode → 扩展视图 → 搜 "nuget-vscode" → 卸载。
或删除目录：`C:\Users\Administrator\.vscode\extensions\nuget-vscode-0.1.0`

## 调试运行（不打包）
```bash
cd C:\Users\Administrator\.qclaw\workspace\nuget-vscode
code .
# VSCode 内按 F5 → 启动扩展开发宿主
```
