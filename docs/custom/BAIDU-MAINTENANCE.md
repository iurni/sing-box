# 百度出站分支的更新和构建

维护分支和仓库默认分支是 `codex/baidu`。原来的上游分支及工作流保留；两个新增的 `baidu-*.yml` 工作流负责定制功能的测试、构建与更新。当前合入的官方版本记录在 `.github/baidu-upstream-version`，初始值为 `v1.14.3`。

上游的 Docker、Linux 发布和 Stale 工作流文件仍然保留，但已在本仓库的 Actions 设置中禁用，避免自动构建与本次需求无关的镜像、发布包或管理议题。日常使用这里的两个 Baidu 工作流；如以后需要上游发布功能，可以单独重新启用对应工作流。

## 自动更新

`Baidu - sync official stable release` 每天检查一次，也可在 GitHub 的 Actions 页面手动运行。时间为 UTC 21:17，即日本时间次日 06:17。GitHub 的定时任务可能延迟；它需要在仓库默认分支上启用 Actions，定时任务才会运行。

流程只读取 `SagerNet/sing-box` 正式发布的 release：排除草稿、预发布和 `vX.Y.Z` 以外的标签，再按数字版本选取最新版本。多次更新之间不要求逐个手动合并；Git 保留完整历史，一次合并到最新稳定版。

1. 从当前 `codex/baidu` 创建临时候选分支，合并官方 release 提交。
2. 如果发生冲突，立即中止合并。远端和原来的 `codex/baidu` 都不会改变。
3. 使用合并后 `go.mod` 要求的 Go 版本，运行同步脚本的隔离 Git 测试、上游根模块 Go 测试和百度协议的 race 测试。
4. 从源码构建 Linux amd64、Windows amd64、Android arm64。Linux 构建还会检查仅含回环地址和虚拟凭据的百度配置，并通过本地模拟网关验证实际数据传输。
5. 版本记录先提交到本地候选分支，构建与验证对应这个确切提交。每一项通过后，才普通推送同一提交到 `codex/baidu`。不使用强推，不重置远端。若测试期间有人更新了远端分支，停止本次推送。
6. 同一任务上传构建包、SHA256 校验值和验证记录，再创建定制 Release，使用 `vX.Y.Z-baidu.<运行编号>` 的独立标签，并指向通过检查的已推送提交，不覆盖官方标签。

合并、测试或构建失败会保留原来的可用版本，在下一次检查时重新尝试。查看失败任务的日志后处理补丁，不会自动忽略失败。成功验证并推送后，若附件上传或 Release 创建失败，分支已经更新；可以手动重新构建并发布，步骤见下方。GitHub Actions 的工作流设置需要允许 `GITHUB_TOKEN` 写入仓库内容；推送权限被禁止时，更新任务会失败并保持远端不变。没有配置个人访问令牌。

GitHub 不会为 `GITHUB_TOKEN` 的推送再次触发普通 push 工作流，所以同步任务本身已包含全部测试、构建和附件上传，不依赖下游工作流。

## 下载构建

`Baidu - test and build` 在定制分支的代码或构建脚本改变时运行，也支持手动运行；面向该分支的 pull request 同样只读测试。进入成功任务底部的 Artifacts 下载附件，解开 GitHub 的外层 ZIP 后即可找到：

- Windows amd64 的 ZIP，内含 `sing-box.exe`。
- Android arm64 的 tar.gz，内含命令行核心 `sing-box`，不是 Android App 安装包。
- Linux amd64 的 tar.gz，便于复现 CI 测试。
- `SHA256SUMS`、`VALIDATION.json` 和每个包里的 `BUILD-INFO.json`。

Actions 附件默认保留 30 天，可以手动重新构建。自动同步成功后，还会在 GitHub Releases 保留同样的构建附件，并将最新定制 Release 设置为 Latest；Release 标签与官方版本标签分开，也不包含真实的节点凭据或原压缩包的二进制。普通代码 push 和默认的手动构建只上传 Actions 附件。

如果需要首次发布，或者同步已经推送但发布附件失败：在 Actions 的 `Baidu - test and build` 页面点击 Run workflow，选择默认分支 `codex/baidu`，勾选 `publish_release` 后运行。它重新完成全部检查和构建，再由独立发布任务下载本次构建的确切附件、验证提交和归档校验值，发布到本次验证的 `github.sha`。若期间分支前进则停止发布，重新运行即可。这个恢复步骤不合并上游，也不修改分支；pull request 和普通 push 永远不会取得该发布任务的写入权限。

构建标签每次从候选版本的 `release/DEFAULT_BUILD_TAGS_OTHERS` 读取，链接参数从 `release/LDFLAGS` 读取，沿用上游非 Naive 的功能集合，而不是固定少量协议。当前 Windows 和 Android 命令行核心使用 `CGO_ENABLED=0`；它们是交叉编译检查，并未在 CI 中实测 Android Root/TUN 或 Windows TUN。根模块测试范围与上游 `.github/workflows/test.yml` 相同；独立的 `test/` Docker 集成模块不在这个维护任务中。

## 本地预检

Node.js 20 及以上、Git 和已登录的 GitHub CLI 可以在干净的本地 `codex/baidu` 分支上查询更新：

```sh
node tools/baidu-sync.mjs --dry-run
```

此操作会获取官方 Git 对象以验证版本的历史关系，但不切换分支、不修改配置、不推送。如果要准备合并以供人工检查：

```sh
node tools/baidu-sync.mjs --prepare
```

准备后仍不会推送，当前 checkout 位于候选分支，版本记录已经提交，工作区保持干净。在 Linux amd64 主机上，可安装 Go（版本参见候选 `go.mod`）、C 编译器、sudo、tcpdump、zip 后运行完整检查：

```sh
node tools/baidu-build.mjs
```

只有本次候选的全部检查通过并生成匹配的验证记录后，发布步骤才允许执行。通常直接使用 GitHub Actions 手动触发同步即可。本地检查失败时保留候选供诊断；不要丢弃其他未保存修改，可以用新的干净 checkout 再次准备。

同步算法可以离线验证；这些测试只创建临时本地仓库，包含合并冲突、测试失败、构建矩阵缺失、验证后修改和他人并发推送等场景，不访问用户的远端：

```sh
node --test tools/baidu-sync.test.mjs
```

这些检查验证补丁的行为和构建兼容性，不保证真实百度网关始终可用，也不能证明任何运营商计费效果。
