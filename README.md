# DBX 插件

每个插件在 `plugins/<插件名>/` 下维护源码、安装说明和版本包。

| 插件 | 版本 | 用途 |
| --- | --- | --- |
| [UC 资源变更查询](plugins/uc-resource-audit/) | [0.1.3 签名版](plugins/uc-resource-audit/releases/v0.1.3/) | 查看 UC 资源的操作人、时间和状态变更 |

## 在 DBX 安装

1. 打开 DBX「插件中心 → 设置 → 插件仓库」。仓库 ID 填 `uc-resource-audit-r2`，名称填「UC 资源工具」，地址填 [catalog.json](https://cdn.jsdelivr.net/gh/lidachui1998/dbx-plugins@main/catalog.json)。
2. 添加仓库后，展开「第三方与开发者选项」，在「自定义仓库信任」中填写 [签名密钥 ID 和公钥](plugins/uc-resource-audit/releases/v0.1.1/dbx-trust-key.json)。
3. 回到「插件商店」，刷新后选择「UC 资源工具」，即可安装插件。

也可以在各插件的 `releases/v<版本>/` 下下载签名 `.dbxp`，在 DBX 中选择本地安装。

新增插件时，在 `plugins/` 下创建独立目录，维护源码和使用说明。将签名包放入该插件的 `releases/v<版本>/`，并在根目录 `catalog.json` 的 `plugins` 数组里添加对应条目。使用已信任的密钥签名时，用户可刷新插件商店查看新插件。jsDelivr 缓存更新后，新条目会出现在插件商店。签名私钥由发布者在本机保管。
