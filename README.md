# SillyTavern Chat Archive Optimizer

面向 SillyTavern 的纯前端聊天归档优化扩展。

## 目标

- 可靠识别原生备份所属的角色卡、群聊及原聊天
- 对过大的单聊、群聊和备份执行无损分割
- 在任意酒馆页面随时浏览、筛选并打开当前账号的全部聊天
- 默认保留原文件，并在写入分卷后进行回读校验
- 不修改或补丁化 SillyTavern 源码

## 当前状态

项目处于设计阶段，尚未提供可安装扩展。

完整方案见 [docs/design.md](docs/design.md)。

## 计划结构

```text
.
├─ docs/
│  └─ design.md
├─ manifest.json
├─ index.js
├─ style.css
├─ settings.html
├─ modules/
└─ i18n/
```

实现将遵循 SillyTavern 前端第三方扩展协议，优先使用 `SillyTavern.getContext()` 和原生 API。
