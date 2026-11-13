# DBX 插件

每个插件在 `plugins/<插件名>/` 下维护源码、安装说明和版本包。

| 插件 | 版本 | 用途 |
| --- | --- | --- |
| [UC 资源变更查询](plugins/uc-resource-audit/) | [0.1.1 签名版](plugins/uc-resource-audit/releases/v0.1.1/) | 查看 UC 资源的操作人、时间和状态变更 |

安装包在各插件的 `releases/v<版本>/` 下。登录 GitHub 后打开对应的 `.dbxp` 文件并下载，再从 DBX 插件中心选择本地安装。首次安装签名包前，在 DBX 中添加同目录 `dbx-trust-key.json` 提供的公钥。

通过 URL 安装时，将同一版本的 `catalog.json` 和签名包放在 DBX 可访问的地址，例如 R2。目录中的安装包链接是相对路径，两个文件需要放在一起。

新增插件时，在 `plugins/` 下创建独立目录，维护该插件的 `manifest.json`、源码和使用说明。签名公钥可随版本保存，私钥由发布者在本机保管。
