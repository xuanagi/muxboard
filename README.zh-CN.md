[English](README.md)

# Muxboard

Muxboard 是一个面向 **Codex + tmux 远程开发** 的桌面工作台。它通过 SSH 直接连接开发服务器，在本机集中管理 tmux 会话、终端和文件。

> 项目仍处于早期阶段，欢迎试用和反馈。

## 截图

截图将在此处补充。

## 核心定位

- **远程优先**：开发环境、Codex 和任务都保留在 SSH 服务器上，本机只承担控制与交互。
- **tmux 原生体验**：保留常用快捷键、复制模式、布局和 TUI 交互方式。

## 当前功能

### 针对 Codex 常用操作，增强 tmux

- 支持 `Alt + V` 粘贴图片。
- 支持 `Ctrl + V` 粘贴文本。
- 可直接传输文件和文件夹，不依赖 WinSCP。
- 可自定义 Codex 配置，并一键切换模型源配置。

### tmux 工作区

- 无需了解 tmux 命令，即可完成常用操作。
- 浏览服务器上的 tmux 会话、窗口和 pane。
- 创建、重命名和关闭会话、窗口与 pane。
- 支持水平、垂直分屏，以及在侧边栏中选择窗口或 pane。
- 以多个终端标签同时打开不同服务器或不同 tmux 会话。
- 支持固定会话，并在应用重启后恢复已保存的工作区。
- 可调整终端字体大小，并提供深色、灰色和浅色主题。

## 环境要求

- Windows 10/11（当前主要支持目标）
- [Bun](https://bun.sh/) 1.3 或更新版本
- 用于连接的远程服务器已安装并运行 `tmux`

## 本地开发

```bash
bun install
bun run dev
```

常用检查：

```bash
bun run typecheck
bun test
```

## 构建与打包

```bash
# 仅构建应用
bun run build

# Windows NSIS 安装包，输出到 release/
bun run dist:win

# Linux AppImage
bun run dist:linux
```

Windows 解包产物可使用 `npx electron-builder --win dir` 构建，默认输出在 `release/win-unpacked/`。

## 安全与数据

Muxboard 会在本机保存服务器配置。选择“记住凭据”时，SSH 密码、私钥口令和 Codex API Key 会通过 Electron 的系统安全存储加密保存；它们不会写入项目文件或发送给 Muxboard 的第三方服务。仍请只连接你信任的服务器，并妥善保护本机账户。

安全漏洞请按 [SECURITY.md](SECURITY.md) 中的方式报告，切勿通过公开 Issue 披露凭据或漏洞细节。

## 贡献

欢迎提交 Issue 和 Pull Request。提交前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，并运行类型检查和测试。

## 许可证

[MIT](LICENSE) © Muxboard Contributors
