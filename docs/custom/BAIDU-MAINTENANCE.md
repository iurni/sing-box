# 百度分支：稳定版同步、Windows GUI 与 Android APK

维护分支和默认分支为 `codex/baidu`。官方稳定版本记录在 `.github/baidu-upstream-version`。自动任务只跟随 `SagerNet/sing-box` 的正式稳定 Release，排除草稿、预发布及非 `vX.Y.Z` 标签。

## 下载与安装

完整构建同时提供上游界面的两个定制 App：

- `SFW-<版本>-x64.exe`：Windows amd64 图形客户端安装程序，包含从本分支源码编译的百度 daemon。
- `SFA-Baidu-<版本>-arm64-v8a.apk`：Android arm64-v8a 图形客户端，包含本分支 libbox；最低 Android 7。
- Windows amd64、Android arm64 和 Linux amd64 的原有命令行核心压缩包。
- `SHA256SUMS`、`VALIDATION.json` 及每个平台的验证记录。

App 采用独立安装身份、配置目录和更新来源。Android 的应用 ID 和 Windows 的服务、IPC、安装注册表身份独立于官方客户端，可保留原客户端；它们不会自动继承官方客户端的配置。Windows 使用本 fork 的持久自签代码签名证书，首次安装仍可能显示 Windows 的未知发行者或 SmartScreen 提示；签名身份和 daemon 的校验保持启用。Android 也使用持久自有签名，可由后续本 fork APK 原地更新，不能作为官方 APK 的同签更新包。

Windows、Android 的客户端源码固定为候选稳定提交中的 `clients/desktop`、`clients/android` gitlink，不切换到浮动的 main/dev。构建脚本对版本、安装身份及更新源做有明确匹配数量的补丁；上游结构改变时补丁失败，停止同步，等待人工处理。公开验证记录包含客户端提交和补丁摘要，不含任何签名私钥、节点凭据或原 ATP 二进制。

## 自动稳定版更新

`Baidu - sync official stable release` 每天 UTC 21:17（日本时间次日 06:17）检查，也支持手动运行。GitHub 定时任务可能延迟，需要工作流在默认分支上启用。

1. 在干净 checkout 从当前维护分支创建临时候选，正常合并最新稳定版。冲突立即停止，原分支与远端不变。
2. 候选的版本标记先提交。将这个未推送提交及完整历史导出为 Git bundle，并记录 SHA、tree、运行编号和 SHA256。
3. Linux 核心、Android App、Windows App 三个独立 job 都导入同一 bundle，验证相同的提交和 tree。Linux 使用候选 `go.mod` 的 Go；Windows 使用固定客户端要求的 Node、pnpm、Go、Rust；Android SDK/NDK 由固定客户端元数据读取。
4. 核心运行同步和跨 job 验证的隔离 Git 测试、上游根模块 Go 测试、百度 race 测试、配置检查、本地模拟网关端到端测试，并编译三份核心。
5. Android 编译 libbox，生成仅 arm64-v8a 的 APK，检查 ELF64/AArch64、版本、应用身份、百度协议包含性及持久签名。Windows 原生构建安装 EXE，检查 AMD64、GUI/daemon 版本、源码编译的百度 daemon、产品与包布局、全部组件签名，并用真实上游 daemon 的证书校验逻辑验证自签身份。
6. 只有三个 job 全部通过，汇总 job 才验证提交、客户端 gitlink、版本、证书指纹和每个附件的 SHA256，生成 schema 2 总验证记录并上传完整安装包集合。
7. 同步任务普通推送经过验证的同一提交。远端若在构建期间前进，停止推送。不强推，不重置远端，不忽略失败。
8. 创建独立 `vX.Y.Z-baidu.<运行编号>` Release，目标是已验证提交，保留官方标签。

任一核心/App 的补丁、测试、编译、签名或验收失败，都不更新维护分支和 Release。旧 schema 1 核心验证记录不能单独批准同步。GitHub 的 `GITHUB_TOKEN` 推送不会再触发普通 push 工作流，所以同步任务自己完成三个构建与发布。原有上游工作流文件保留；本 fork 的 Docker/Linux/Stale 工作流在 Actions 设置中单独禁用，避免运行无关发布任务。

通过全部检查并推送后若 Release 创建失败，分支已经更新；按下方手动恢复重新构建并发布。不会为了恢复附件而重新合并或强推。

## 手动构建与恢复发布

`Baidu - test and build apps` 在维护分支的代码/客户端/构建脚本改变时运行，并上传 Actions 附件，默认不创建 Release。面向维护分支的 pull request 只运行只读核心验证，不取得签名私钥，不运行签名 App 发布。

在该工作流页面点击 Run workflow，选择默认分支 `codex/baidu`，勾选 `publish_release`。它重新完成核心、Windows 和 Android 全部验证，下载本次运行的确切附件，检查提交和校验值，再发布。若远端分支已前进则停止，重新运行即可。Artifacts 默认保留 30 天；候选源码 bundle 保留 3 天。

## 持久签名材料

仓库配置以下 Actions Secrets，正常构建不生成临时签名身份，也不降级为未签名包：

- `BAIDU_ANDROID_KEYSTORE_BASE64`
- `BAIDU_ANDROID_STORE_PASSWORD`
- `BAIDU_ANDROID_KEY_ALIAS`
- `BAIDU_ANDROID_KEY_PASSWORD`
- `BAIDU_WINDOWS_PFX_BASE64`
- `BAIDU_WINDOWS_PFX_PASSWORD`

公开 Actions Variables `BAIDU_ANDROID_CERT_SHA256` 和 `BAIDU_WINDOWS_CERT_SHA256` 固定证书 SHA256 指纹。私钥仅在受信任默认分支的 App 构建 job 注入，runner 本地忽略文件用完清理，不进入附件。请保存持久材料的私人备份；随意更换 Android key 会使已有 APK 不能原地升级，更换 Windows key 也会改变 daemon 的签名信任关系。不要把 key/password 提交到仓库。

## 本地检查

在干净维护分支用 Git、Node 24 以上及已登录的 GitHub CLI 查询：

```sh
node tools/baidu-sync.mjs --dry-run
```

它只获取官方历史并验证版本关系，不合并、不推送。隔离 Git 测试不访问用户远端：

```sh
node --test tools/baidu-sync.test.mjs tools/baidu-pipeline.test.mjs
```

`node tools/baidu-build.mjs` 仅进行 Linux amd64 环境的核心测试和三平台核心交叉编译，其 schema 1 验证记录不足以批准发布。完整 App 构建及总验证由 `baidu-apps.yml` 在 Ubuntu 和 Windows 原生 runner 执行。

核心包功能标签和链接参数从候选上游的 release 文件读取；Windows daemon 沿用客户端所需标签，Android libbox 沿用官方 Android 构建路径。根模块测试范围与上游 `.github/workflows/test.yml` 相同；独立 `test/` Docker 集成模块不包含在本维护任务中。

构建和模拟测试验证兼容性、签名、包含的源码及协议行为，未在真实手机、Windows TUN 或百度入口上自动联网测试，不证明运营商计费效果。
