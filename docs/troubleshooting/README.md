# Troubleshooting

这个目录收集 Vibedeckx 运行过程中已经确认的问题、诊断方法和解决办法，方便用户用错误原文快速检索。

## Agent 与运行环境

- [Codex Review 在 Ubuntu 上报 `bwrap: loopback: Failed RTM_NEWADDR`](./codex-bwrap-apparmor-userns.md)

## 新增文档约定

每篇故障文档尽量包含：

1. 用户可见的症状和完整错误原文；
2. 受影响与不受影响的环境；
3. 根因，以及如何确认而不是猜测；
4. 推荐修复、验收和回滚步骤；
5. 有安全代价或已经弃用的替代方案。

文件名使用稳定的技术关键词，避免只使用版本号或内部 issue 编号，确保用户能通过错误信息搜索到文档。
