---
icon: material/new-box
---

### Structure

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

  ... // Dial Fields
}
```

### Fields

#### server

==Required==

The server address.

#### server_port

The server port.

Must set at least one field between `server_port` and `server_ports`.

#### server_ports

Server port range list.

Must set at least one field between `server_port` and `server_ports`.

#### transport

==Required==

Transmission protocol. Allowed values are `TCP` and `UDP`.

#### username

==Required==

mieru user name.

#### password

==Required==

mieru password.

#### multiplexing

Multiplexing level. Supported values are `MULTIPLEXING_OFF`, `MULTIPLEXING_LOW`, `MULTIPLEXING_MIDDLE`, `MULTIPLEXING_HIGH`. `MULTIPLEXING_OFF` disables multiplexing.

#### traffic_pattern

A base64 string to fine tune network behavior.

With `transport` set to `UDP` and a domain server, mieru first resolves the server through sing-box DNS (`domain_resolver` or the default resolver), then sends UDP through the detour. Ensure the DNS route and detour support UDP. TCP follows the normal dialer resolution behavior.

Mieru UDP currently uses only the first resolved IP and does not retry another address on failure. In dual-stack networks, set `domain_resolver.strategy` to the desired address family.

### Dial Fields

See [Dial Fields](/configuration/shared/dial/) for details.


## Source attribution

The mieru adapter is based on [enfein/mbox](https://github.com/enfein/mbox/tree/1c5b39718ebcd05e6adb31f95246fbf056be9bd7), and uses [enfein/mieru](https://github.com/enfein/mieru). See their LICENSE files and this repository’s LICENSE for the applicable terms.
