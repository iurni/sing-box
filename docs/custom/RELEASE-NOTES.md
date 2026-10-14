本版本由官方正式稳定版及百度出站补丁的源码构建，提供上游图形界面的定制安装包：

- Windows amd64：下载 `SFW-…-x64.exe` 安装图形客户端，包含本 fork 的百度 daemon。
- Android arm64-v8a：下载 `SFA-Baidu-…-arm64-v8a.apk`，最低 Android 7，包含本 fork 的 libbox。
- 原有 Windows / Android / Linux 命令行核心压缩包仍保留。
- SHA256 值见 `SHA256SUMS`；核心与客户端源码提交、签名证书指纹、检查记录见 `VALIDATION.json` 及三个平台的验证 JSON。

客户端采用独立的安装和配置身份，可保留官方客户端。Android 使用持久自有签名，可由之后的本 fork APK 更新；Windows 使用持久自签证书，首次安装可能出现未知发行者或 SmartScreen 提示。GUI、daemon 和原有安全校验保持启用。

发布前所有核心测试与模拟网关验证、Windows 原生构建/签名/daemon 校验、Android APK 签名/身份/架构验证均须通过；任一项失败均停止稳定版同步和发布。附件不含签名私钥、真实节点凭据或原 ATP 模块的预编译内核。

模拟网关验证不代表真实百度入口始终可用，也不证明任何运营商计费效果。配置字段及维护流程见定制协议文档和 `docs/custom/BAIDU-MAINTENANCE.md`。
