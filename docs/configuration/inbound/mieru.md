---
icon: material/new-box
---

### Structure

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

The mieru server owns its listener; only `listen` and `listen_port` are supported. Other common listen fields are not accepted.

### Fields

#### transport

==Required==

Transmission protocol. Allowed values are `TCP` and `UDP`.

#### users

==Required==

A list of mieru user name and password.

#### traffic_pattern

A base64 string to fine tune network behavior.

#### user_hint_is_mandatory

If proxy client doesn't sent user hint, proxy server will refuse the connection.


Implementation based on [enfein/mbox](https://github.com/enfein/mbox/tree/1c5b39718ebcd05e6adb31f95246fbf056be9bd7) and [enfein/mieru](https://github.com/enfein/mieru); see their licenses and this repository’s LICENSE.
