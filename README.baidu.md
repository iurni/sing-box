# 百度 CONNECT 扩展

这是基于 SagerNet/sing-box 的个人 fork，工作分支为 `codex/baidu`。
它新增 `type: "baidu"` 出站，保留上游内核功能。当前上游稳定版记录在
[版本标记](.github/baidu-upstream-version) 中。

协议根据用户提供的 Android 核心进行静态分析，再独立编写源码。
请求会发送真实目标地址，以及 `Host`、`User-Agent` 和 `X-T5-Auth` 三个头。
普通 HTTP 出站的 `del_host` 或自定义请求行不能替代这个出站。

## 获取与测试

从本仓库的 Releases 下载 Windows amd64 或 Android arm64 核心。
Actions 的 `Baidu - test and build` 也可以手动执行，生成包含校验值的构建包。
Android 包是命令行核心，不是 APK；官方客户端内置的核心不会因此自动改变。

下面是只监听本机的最小测试配置，使用前填入自己的网关和凭据：

```json
{
  "log": { "level": "info" },
  "inbounds": [
    { "type": "mixed", "listen": "127.0.0.1", "listen_port": 18849 }
  ],
  "outbounds": [
    {
      "type": "baidu",
      "tag": "baidu-out",
      "server": "YOUR_GATEWAY_IP",
      "server_port": 443,
      "secret": "YOUR_OWN_GATEWAY_CREDENTIAL",
      "host": "YOUR_HOST_HEADER",
      "user_agent": "baiduboxapp"
    }
  ],
  "route": { "final": "baidu-out" }
}
```

保存为 `baidu-test.json`，先检查配置，再启动：

```powershell
.\sing-box.exe check -c .\baidu-test.json
.\sing-box.exe run -c .\baidu-test.json
```

另一个窗口可以通过本地代理测试：

```powershell
curl.exe --proxy http://127.0.0.1:18849 --connect-timeout 10 --max-time 30 -I https://www.baidu.com/
```

支持网关地址池、连接超时和失败后切换其他出站，完整字段见
[出站文档](docs/configuration/outbound/baidu.md)。仅支持 TCP；用于 TUN 时要单独处理 DNS，
并拒绝 UDP/QUIC，让浏览器改用 TCP。

## 验证与更新

本地模拟测试验证请求字节、隧道数据、超时取消、网关重试、失败切换和缓存。
编译后的核心还经过本机代理入口到模拟网关的端到端测试。
这些测试不请求公共网关；实际可用性仍取决于网关、凭据和接入网络。
仓库和构建包不包含用户模块里的凭据，也不分发其中未知的二进制。

自动同步只跟随官方稳定版，合并冲突、测试或任一目标构建失败时停止，保留当前分支。
时间、手动触发方法和失败处理见
[维护说明](docs/custom/BAIDU-MAINTENANCE.md)。
