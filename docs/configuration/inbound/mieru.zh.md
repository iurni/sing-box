---
icon: material/new-box
---

### 结构

```json
{
  "type": "mieru",
  "tag": "mieru-in",

  "listen": "127.0.0.1",
  "listen_port": 1080,

  "transport": "TCP",
  "users": [
    {
      "name": "asdf",
      "password": "hjkl"
    }
  ],
  "traffic_pattern": "GgQIARAK"
}
```

mieru 服务自行创建监听器，仅支持 `listen` 和 `listen_port`，不接受其他通用监听字段。

### 字段

#### transport

==必填==

通信协议。可设为 `TCP` 或 `UDP`。

#### users

==必填==

一组 mieru 用户名和密码。

#### traffic_pattern

一个 base64 字符串用于微调网络行为。

#### user_hint_is_mandatory

客户端若不发送用户提示，代理服务器将拒绝连接。


Implementation based on [enfein/mbox](https://github.com/enfein/mbox/tree/1c5b39718ebcd05e6adb31f95246fbf056be9bd7) and [enfein/mieru](https://github.com/enfein/mieru); see their licenses and this repository’s LICENSE.
