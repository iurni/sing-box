此版本从正式稳定版的源码合并、测试和构建，增加定制的 `baidu` TCP 出站。

- Windows amd64：下载 ZIP 中的 `sing-box.exe`。
- Android arm64：下载 tar.gz 中的 `sing-box` 命令行核心；不是 Android App 安装包。
- Linux amd64：用于命令行使用和复现 CI。
- 每个附件对应的 SHA256 值见 `SHA256SUMS`；Go 版本、构建标签和源码提交见 `BUILD-INFO.json`。

发布前已通过上游根模块 Go 测试、百度出站 race 测试、配置检查和真实编译核心的回环模拟网关测试。二进制沿用该上游版本 `DEFAULT_BUILD_TAGS_OTHERS` 的非 Naive 功能集合。

附件不含真实凭据或原模块的预编译内核。模拟网关通过不代表真实百度入口一直可用，也不能证明运营商计费效果。配置字段及维护说明见仓库中的定制协议文档和 `docs/custom/BAIDU-MAINTENANCE.md`。
