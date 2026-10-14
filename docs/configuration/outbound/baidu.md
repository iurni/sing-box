# Baidu CONNECT (experimental fork extension)

`baidu` is a TCP-only outbound provided by this fork, not by upstream sing-box.
It implements the CONNECT request format recovered by static inspection of the
user-supplied Android core. It has not been tested against a public gateway.

```json
{
  "type": "baidu",
  "tag": "baidu-out",
  "server": "gateway.example",
  "server_port": 443,
  "secret": "YOUR_OWN_GATEWAY_CREDENTIAL",
  "host": "gateway.example:443",
  "user_agent": "baiduboxapp",
  "connect_timeout": "10s"
}
```

## Request format

The gateway connection uses plain TCP, including on port 443. The destination
comes from the connection being proxied; it is not replaced by a fixed fake target.

```http
CONNECT <destination host:port> HTTP/1.1
Host: <host>
User-Agent: <user_agent>
X-T5-Auth: <secret>

```

The request uses CRLF line endings. A 2xx response establishes the tunnel.
The target application's TLS connection, if any, starts inside that tunnel.
There is no `del_host` option or support for replacing a request line through
the ordinary HTTP outbound's `headers` field.

## Fields

### server and server_port

Gateway address and port. Required unless `dest_addrs` supplies a nonempty pool.
Domain names use the normal [Dial Fields](/configuration/shared/dial/), including
`domain_resolver`. The gateway must not be resolved to a Fake-IP address.

### secret

Required. Use a gateway credential you are authorized to use. This fork does
not embed or distribute the shared credential found in the supplied module.
Unlike that module, an empty credential is rejected during configuration loading.
The credential is sent in the plaintext CONNECT header, so it is visible to
the gateway and the network carrying the gateway connection.

### host

The CONNECT Host header. Defaults to the first gateway's address and port.
It is independent of the real CONNECT destination.

### user_agent

The User-Agent header. Defaults to `baiduboxapp`.

### dest_addrs

Optional array of gateway addresses, for example:

```json
"dest_addrs": ["gateway-one.example:443", "gateway-two.example:8443", "[::1]:443"]
```

This replaces `server` / `server_port` when nonempty. A missing port defaults to
443. Entries are trimmed and validated. The pool rotates between connections;
a TCP dial failure puts that gateway into a 30-second cooldown. If all gateways
are cooling down, they can still be attempted. CONNECT rejection does not mark
the gateway as offline.

The generated JSON schema is permissive like other upstream outbounds; required
credentials and gateway addresses are validated when loading the configuration.

### fallback

Optional tag of another TCP-capable outbound. The fallback is used when gateway
dialing or CONNECT negotiation fails. It must exist, cannot be another `baidu`
outbound, and participates in sing-box's dependency and cycle checks. No fallback
is enabled implicitly. Fallback traffic uses the named outbound's normal route
and may incur different network or subscription usage.

### fallback_host_ttl

Cache duration in integer seconds for destinations rejected with HTTP 403 or 503.
The default is 300. A negative value disables the cache. The cache key includes
the target host and port; a cached target goes directly to `fallback` until expiry.
Other handshake failures can use fallback but are not cached. At most 512 targets
are remembered. No credential or tunneled payload is stored.

### connect_timeout

From [Dial Fields](/configuration/shared/dial/). Defaults to 10 seconds in this
outbound, and applies separately to each gateway TCP dial and CONNECT handshake.
An earlier caller deadline takes precedence. CONNECT negotiation can be attempted
twice for transient failures; 403 and 503 stop that retry immediately.

## TUN use

This outbound does not transport UDP or ICMP. Keep DNS interception separate and
reject unsupported UDP traffic in a TUN configuration. For browser tests, reject
QUIC so the browser can use TCP. The outbound does not alter TUN setup, mobile
network billing, operating-system routing, or the upstream gateway's access policy.

## Deliberate differences from the inspected core

The wire request, gateway pool, success status range, fallback decisions, and
default header values follow the recovered behavior. This implementation requires
an explicit credential, validates request fields against header injection, bounds
response headers to 64 KiB, preserves tunnel bytes received with the response,
and cancels pending handshakes when the caller is cancelled. These are independent
source changes; the unknown Android binary is neither executed nor redistributed.
A missing fallback tag is an error during startup rather than a silent runtime
fallback omission. `connect_timeout` also bounds each handshake, unlike the
inspected core's fixed outer 10-second timeout.
