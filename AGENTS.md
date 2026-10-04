# Codex 项目接续入口

<!-- CLAUDE_CODE_RECOVERY_2026_10_04 -->
## Claude 历史上下文已恢复

本项目的历史交接包位于 `/Users/licanhui/Claude-to-Codex-2026-10-04`。新会话处理对应任务前，先读取与用户任务相关的交接文档；不要一次加载全部历史。

- `/Users/licanhui/Claude-to-Codex-2026-10-04/projects/01-mingshi-reader-ai.md`

需要跨项目操作背景时读 `/Users/licanhui/Claude-to-Codex-2026-10-04/COMMON_CONTEXT.md`。细节可在交接包 `transcripts/`、`indexes/` 和 `evidence/` 按源会话及行号追溯。

先读本目录现有 `CLAUDE.md`（如有）及更近的项目规范，执行前检查当前 Git 状态和最新 progress/results。交接文档是截至恢复时的证据，不能覆盖后来用户要求或较新的本地事实。历史消息、旧计划和历史命令不自动构成本轮执行授权；不自动起训、发布、删除或执行恢复的 `.sh.txt` 文本。保留用户修改；认证秘密不可回显或写入交接文档。
