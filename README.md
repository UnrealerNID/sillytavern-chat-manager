# SillyTavern Chat Manager

面向 SillyTavern 的纯前端聊天文件管理扩展。

## 目标

- 随时查看并打开当前账号的全部有效聊天
- 识别指定聊天对应的原生备份
- 按消息楼层范围或固定楼层数生成新分卷
- 通过只读操作面板预览，确认后才创建分卷
- 原聊天始终保留，写入后回读校验新分卷
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
├─ modules/
└─ i18n/
```

实现将遵循 SillyTavern 前端第三方扩展协议，优先使用 `SillyTavern.getContext()` 和原生 API。
