---
icon: material/new-box
---

### 结构

```json
{
  "type": "mieru",
  "tag": "mieru-out",

  "server": "127.0.0.1",
  "server_port": 1080,
  "server_ports": [
    "9000-9010",
    "9020-9030"
  ],
  "transport": "TCP",
  "username": "asdf",
  "password": "hjkl",
  "multiplexing": "MULTIPLEXING_LOW",
  "traffic_pattern": "GgQIARAK",

  ... // 拨号字段
}
```

### 字段

#### server

==必填==

服务器地址。

#### server_port

服务器端口。

必须填写 `server_port` 和 `server_ports` 中至少一项。

#### server_ports

服务器端口范围列表。

必须填写 `server_port` 和 `server_ports` 中至少一项。

#### transport

==必填==

通信协议。可设为 `TCP` 或 `UDP`。

#### username

==必填==

mieru 用户名。

#### password

==必填==

mieru 密码。

#### multiplexing

多路复用设置。可以设为 `MULTIPLEXING_OFF`，`MULTIPLEXING_LOW`，`MULTIPLEXING_MIDDLE`，`MULTIPLEXING_HIGH`。其中 `MULTIPLEXING_OFF` 会关闭多路复用功能。

#### traffic_pattern

一个 base64 字符串用于微调网络行为。

当 `transport` 为 `UDP` 且服务器使用域名时，mieru 会先使用 sing-box 的 DNS（`domain_resolver` 或默认解析器）解析，再通过 detour 发送 UDP。请确保 DNS 路由和前置节点支持 UDP。TCP 使用标准拨号器解析行为。

mieru UDP 目前只使用解析结果中的第一个 IP，连接失败时不会自动切换其他地址；双栈环境可以用 `domain_resolver.strategy` 指定所需地址族。

### 拨号字段

参阅 [拨号字段](/zh/configuration/shared/dial/)。


## Source attribution

The mieru adapter is based on [enfein/mbox](https://github.com/enfein/mbox/tree/1c5b39718ebcd05e6adb31f95246fbf056be9bd7), and uses [enfein/mieru](https://github.com/enfein/mieru). See their LICENSE files and this repository’s LICENSE for the applicable terms.
