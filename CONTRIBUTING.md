# 贡献指南

感谢你对 Muxboard 的关注。提交 Issue 前，请先搜索是否已有相同问题；提交 Pull Request 前，请说明变更目的和测试方式。

## 开发流程

1. Fork 本仓库并从 `main` 创建功能分支。
2. 保持改动聚焦，并为行为变更补充或更新测试。
3. 在提交前运行：

   ```bash
   bun run typecheck
   bun test
   ```

4. Pull Request 请描述问题、解决方案、测试结果；UI 改动请附截图或录屏。

## 提交与安全

- 不要提交 SSH 私钥、密码、API Key、服务器地址或本地配置文件。
- 不要提交 `node_modules/`、构建产物或 `release/` 内容。
- 安全问题请不要创建公开 Issue，改按 [SECURITY.md](SECURITY.md) 报告。
