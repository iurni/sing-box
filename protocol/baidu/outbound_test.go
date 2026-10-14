package baidu

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/adapter/outbound"
	C "github.com/sagernet/sing-box/constant"
	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing/common/json/badoption"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
	"github.com/sagernet/sing/service"
)

const testSecret = "local-test-credential"

// All gateway connections in these tests terminate at loopback or net.Pipe.
func mockGateway(t *testing.T, handle func(net.Conn, string)) M.Socksaddr {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	acceptDone := make(chan struct{})
	go func() {
		defer close(acceptDone)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(2 * time.Second))
				reader := bufio.NewReader(conn)
				var request strings.Builder
				for {
					line, err := reader.ReadString('\n')
					if err != nil {
						return
					}
					request.WriteString(line)
					if line == "\r\n" {
						break
					}
				}
				handle(conn, request.String())
			}()
		}
	}()
	t.Cleanup(func() {
		listener.Close()
		<-acceptDone
		workers.Wait()
	})
	return M.SocksaddrFromNet(listener.Addr())
}

func newTestOutbound(t *testing.T, address M.Socksaddr, alter func(*option.BaiduOutboundOptions)) *Outbound {
	t.Helper()
	options := option.BaiduOutboundOptions{
		ServerOptions: option.ServerOptions{Server: address.AddrString(), ServerPort: address.Port},
		Secret:        testSecret,
	}
	if alter != nil {
		alter(&options)
	}
	value, err := NewOutbound(context.Background(), nil, log.NewNOPFactory().Logger(), "test", options)
	if err != nil {
		t.Fatal(err)
	}
	return value.(*Outbound)
}

func TestCONNECTWireAndBufferedPayload(t *testing.T) {
	for _, destinationText := range []string{"www.example.test:443", "[2001:db8::1]:8443"} {
		for _, status := range []int{200, 201, 299} {
			t.Run(fmt.Sprintf("%s/%d", destinationText, status), func(t *testing.T) {
				requests := make(chan string, 1)
				gateway := mockGateway(t, func(conn net.Conn, request string) {
					requests <- request
					io.WriteString(conn, fmt.Sprintf("HTTP/1.1 %d Tunnel Ready\r\nX-Test: 1\r\n\r\nfirst-tunnel-bytes", status))
				})
				client := newTestOutbound(t, gateway, func(options *option.BaiduOutboundOptions) {
					options.Host = "gateway-host.example:443"
					options.UserAgent = "test-browser/1.0"
				})
				conn, err := client.DialContext(context.Background(), "tcp", M.ParseSocksaddr(destinationText))
				if err != nil {
					t.Fatal(err)
				}
				defer conn.Close()
				payload, err := io.ReadAll(conn)
				if err != nil || string(payload) != "first-tunnel-bytes" {
					t.Fatalf("tunnel payload lost: %q, %v", payload, err)
				}
				want := "CONNECT " + destinationText + " HTTP/1.1\r\nHost: gateway-host.example:443\r\nUser-Agent: test-browser/1.0\r\nX-T5-Auth: " + testSecret + "\r\n\r\n"
				if got := <-requests; got != want {
					t.Fatalf("incorrect wire request: %q", got)
				}
			})
		}
	}
}

func TestCONNECTErrorsAndRetryPolicy(t *testing.T) {
	for _, test := range []struct {
		name         string
		response     string
		wantAttempts int32
		wantStatus   int
	}{
		{"forbidden", "HTTP/1.1 403 Forbidden\r\n\r\n", 1, 403},
		{"unavailable", "HTTP/1.1 503 Unavailable\r\n\r\n", 1, 503},
		{"other-status", "HTTP/1.1 502 Bad Gateway\r\n\r\n", 2, 502},
		{"truncated", "HTTP/1.1 200 OK\r\nHost: incomplete", 2, 0},
		{"malformed", "not an HTTP status\r\n\r\n", 2, 0},
		{"malformed-with-credential", "HTTP/1.1 invalid " + testSecret + "\r\n\r\n", 2, 0},
		{"oversized", "HTTP/1.1 200 OK\r\nX-Large: " + strings.Repeat("x", maxResponseHeaderBytes) + "\r\n\r\n", 2, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			var attempts atomic.Int32
			gateway := mockGateway(t, func(conn net.Conn, request string) {
				attempts.Add(1)
				io.WriteString(conn, test.response)
			})
			client := newTestOutbound(t, gateway, nil)
			conn, err := client.DialContext(context.Background(), "tcp", M.ParseSocksaddr("example.test:443"))
			if conn != nil || err == nil {
				t.Fatalf("expected failed tunnel, got %v, %v", conn, err)
			}
			if attempts.Load() != test.wantAttempts {
				t.Fatalf("attempts = %d, want %d", attempts.Load(), test.wantAttempts)
			}
			if strings.Contains(err.Error(), testSecret) {
				t.Fatal("error exposed authentication credential")
			}
			var statusErr *StatusError
			if test.wantStatus != 0 && (!errors.As(err, &statusErr) || statusErr.StatusCode != test.wantStatus) {
				t.Fatalf("incorrect status error: %v", err)
			}
		})
	}
}

func TestTransientFailureThenSuccess(t *testing.T) {
	var attempts atomic.Int32
	gateway := mockGateway(t, func(conn net.Conn, request string) {
		if attempts.Add(1) == 1 {
			io.WriteString(conn, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
		} else {
			io.WriteString(conn, "HTTP/1.1 200 OK\r\n\r\nready")
		}
	})
	client := newTestOutbound(t, gateway, nil)
	conn, err := client.DialContext(context.Background(), "tcp", M.ParseSocksaddr("example.test:443"))
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	if attempts.Load() != 2 {
		t.Fatalf("attempts = %d", attempts.Load())
	}
}

type partialWriteConn struct {
	net.Conn
	zero bool
}

func (c *partialWriteConn) Write(p []byte) (int, error) {
	if c.zero {
		return 0, nil
	}
	if len(p) > 3 {
		p = p[:3]
	}
	return c.Conn.Write(p)
}

func TestCONNECTPartialAndZeroWrites(t *testing.T) {
	for _, zero := range []bool{false, true} {
		t.Run(fmt.Sprint(zero), func(t *testing.T) {
			local, remote := net.Pipe()
			defer remote.Close()
			serverDone := make(chan struct{})
			go func() {
				defer close(serverDone)
				reader := bufio.NewReader(remote)
				for {
					line, err := reader.ReadString('\n')
					if err != nil {
						return
					}
					if line == "\r\n" {
						break
					}
				}
				io.WriteString(remote, "HTTP/1.1 200 OK\r\n\r\n")
			}()
			conn, err := connect(context.Background(), &partialWriteConn{Conn: local, zero: zero}, M.ParseSocksaddr("example.test:443"), "gateway:443", "test", testSecret, time.Second)
			if zero {
				if !errors.Is(err, io.ErrShortWrite) {
					t.Fatalf("zero write must fail: %v", err)
				}
			} else {
				if err != nil {
					t.Fatalf("partial writes not completed: %v", err)
				}
				conn.Close()
			}
			<-serverDone
		})
	}
}

func TestHandshakeTimeoutAndCancellation(t *testing.T) {
	for _, test := range []string{"timeout", "cancel", "context-deadline"} {
		t.Run(test, func(t *testing.T) {
			local, remote := net.Pipe()
			defer remote.Close()
			readDone := make(chan struct{})
			go func() {
				reader := bufio.NewReader(remote)
				for {
					line, err := reader.ReadString('\n')
					if err != nil || line == "\r\n" {
						close(readDone)
						return
					}
				}
			}()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			timeout := 40 * time.Millisecond
			if test == "cancel" {
				timeout = time.Second
				go func() { <-readDone; cancel() }()
			} else if test == "context-deadline" {
				ctx, cancel = context.WithTimeout(ctx, 40*time.Millisecond)
				defer cancel()
				timeout = time.Second
			}
			started := time.Now()
			conn, err := connect(ctx, local, M.ParseSocksaddr("example.test:443"), "gateway:443", "test", testSecret, timeout)
			if conn != nil || err == nil {
				t.Fatalf("expected aborted handshake: %v, %v", conn, err)
			}
			if time.Since(started) > 500*time.Millisecond {
				t.Fatal("handshake ignored timeout/cancellation")
			}
			remote.SetReadDeadline(time.Now().Add(time.Second))
			if _, err := remote.Read(make([]byte, 1)); err == nil {
				t.Fatal("aborted handshake leaked open connection")
			}
			<-readDone
		})
	}
}

func TestDeliveredTunnelSurvivesDialContextCancellation(t *testing.T) {
	local, remote := net.Pipe()
	defer remote.Close()
	serverReady := make(chan struct{})
	go func() {
		reader := bufio.NewReader(remote)
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				return
			}
			if line == "\r\n" {
				break
			}
		}
		io.WriteString(remote, "HTTP/1.1 200 OK\r\n\r\n")
		close(serverReady)
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn, err := connect(ctx, local, M.ParseSocksaddr("example.test:443"), "gateway:443", "test", testSecret, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	<-serverReady
	cancel()
	writeDone := make(chan error, 1)
	go func() {
		_, err := io.WriteString(remote, "after-cancel")
		writeDone <- err
	}()
	conn.SetReadDeadline(time.Now().Add(time.Second))
	got := make([]byte, len("after-cancel"))
	if _, err := io.ReadFull(conn, got); err != nil || string(got) != "after-cancel" {
		t.Fatalf("delivered tunnel closed by completed dial context: %q, %v", got, err)
	}
	if err := <-writeDone; err != nil {
		t.Fatal(err)
	}
}

func TestHandshakeDeadlineIsCleared(t *testing.T) {
	local, remote := net.Pipe()
	defer remote.Close()
	ready := make(chan struct{})
	go func() {
		reader := bufio.NewReader(remote)
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				return
			}
			if line == "\r\n" {
				break
			}
		}
		io.WriteString(remote, "HTTP/1.1 200 OK\r\n\r\n")
		close(ready)
	}()
	conn, err := connect(context.Background(), local, M.ParseSocksaddr("example.test:443"), "gateway:443", "test", testSecret, 40*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	<-ready
	time.Sleep(60 * time.Millisecond)
	go io.WriteString(remote, "ok")
	got := make([]byte, 2)
	if _, err := io.ReadFull(conn, got); err != nil || string(got) != "ok" {
		t.Fatalf("handshake deadline leaked into tunnel: %q, %v", got, err)
	}
}

type fakeOutbound struct {
	outbound.Adapter
	dial func(context.Context, string, M.Socksaddr) (net.Conn, error)
}

func (f *fakeOutbound) DialContext(ctx context.Context, network string, destination M.Socksaddr) (net.Conn, error) {
	return f.dial(ctx, network, destination)
}

func (f *fakeOutbound) ListenPacket(context.Context, M.Socksaddr) (net.PacketConn, error) {
	return nil, os.ErrInvalid
}

type fakeManager struct {
	adapter.OutboundManager
	entries map[string]adapter.Outbound
}

func (m *fakeManager) Outbound(tag string) (adapter.Outbound, bool) {
	value, loaded := m.entries[tag]
	return value, loaded
}

func TestFallbackCacheExpiryAndPortIsolation(t *testing.T) {
	for _, status := range []int{403, 503, 502} {
		for _, ttl := range []time.Duration{time.Minute, 0} {
			t.Run(fmt.Sprintf("%d/%s", status, ttl), func(t *testing.T) {
				var gatewayCalls, fallbackCalls atomic.Int32
				gateway := mockGateway(t, func(conn net.Conn, request string) {
					gatewayCalls.Add(1)
					io.WriteString(conn, fmt.Sprintf("HTTP/1.1 %d Failed\r\n\r\n", status))
				})
				client := newTestOutbound(t, gateway, nil)
				clock := time.Now()
				client.now = func() time.Time { return clock }
				client.fallbackTTL = ttl
				client.fallback = &fakeOutbound{Adapter: outbound.NewAdapter("test", "fallback", []string{N.NetworkTCP}, nil), dial: func(ctx context.Context, network string, destination M.Socksaddr) (net.Conn, error) {
					fallbackCalls.Add(1)
					local, remote := net.Pipe()
					remote.Close()
					return local, nil
				}}
				dial := func(port uint16) {
					t.Helper()
					conn, err := client.DialContext(context.Background(), "tcp", M.ParseSocksaddrHostPort("example.test", port))
					if err != nil {
						t.Fatal(err)
					}
					conn.Close()
				}
				dial(443)
				initial := gatewayCalls.Load()
				dial(443)
				cached := ttl > 0 && (status == 403 || status == 503)
				if cached && gatewayCalls.Load() != initial {
					t.Fatal("cached rejected target still contacted gateway")
				}
				if !cached && gatewayCalls.Load() != 2*initial {
					t.Fatal("transient/disabled cache unexpectedly remembered target")
				}
				beforePort := gatewayCalls.Load()
				dial(8443)
				if gatewayCalls.Load() == beforePort {
					t.Fatal("fallback cache ignored destination port")
				}
				clock = clock.Add(2 * time.Minute)
				beforeExpiry := gatewayCalls.Load()
				dial(443)
				if gatewayCalls.Load() == beforeExpiry {
					t.Fatal("expired target did not retry gateway")
				}
				if fallbackCalls.Load() != 4 {
					t.Fatal("fallback not invoked for each destination")
				}
			})
		}
	}
}

func TestFallbackDependencyValidation(t *testing.T) {
	for _, test := range []struct {
		name      string
		fallback  adapter.Outbound
		wantError bool
	}{
		{"missing", nil, true},
		{"baidu", &fakeOutbound{Adapter: outbound.NewAdapter(C.TypeBaidu, "fallback", []string{N.NetworkTCP}, nil)}, true},
		{"udp-only", &fakeOutbound{Adapter: outbound.NewAdapter("test", "fallback", []string{N.NetworkUDP}, nil)}, true},
		{"valid", &fakeOutbound{Adapter: outbound.NewAdapter("test", "fallback", []string{N.NetworkTCP}, nil)}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			manager := &fakeManager{entries: map[string]adapter.Outbound{}}
			if test.fallback != nil {
				manager.entries["fallback"] = test.fallback
			}
			ctx := service.ContextWith[adapter.OutboundManager](context.Background(), manager)
			value, err := NewOutbound(ctx, nil, log.NewNOPFactory().Logger(), "test", option.BaiduOutboundOptions{
				ServerOptions: option.ServerOptions{Server: "127.0.0.1", ServerPort: 443}, Secret: testSecret, Fallback: "fallback",
			})
			if err != nil {
				t.Fatal(err)
			}
			client := value.(*Outbound)
			if got := client.Dependencies(); len(got) != 1 || got[0] != "fallback" {
				t.Fatalf("fallback not declared as dependency: %v", got)
			}
			err = client.Start(adapter.StartStateStart, nil)
			if (err != nil) != test.wantError {
				t.Fatalf("unexpected dependency validation: %v", err)
			}
		})
	}
}

func TestDialFailureFallbackAndCallerCancellation(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := M.SocksaddrFromNet(listener.Addr())
	listener.Close()
	client := newTestOutbound(t, address, nil)
	var fallbackCalls atomic.Int32
	client.fallback = &fakeOutbound{Adapter: outbound.NewAdapter("test", "fallback", []string{N.NetworkTCP}, nil), dial: func(ctx context.Context, network string, destination M.Socksaddr) (net.Conn, error) {
		fallbackCalls.Add(1)
		return nil, errors.New("local test fallback unavailable")
	}}
	conn, err := client.DialContext(context.Background(), "tcp", M.ParseSocksaddr("example.test:443"))
	if conn != nil || err == nil || !strings.Contains(err.Error(), "fallback unavailable") || fallbackCalls.Load() != 1 {
		t.Fatalf("dial failure did not preserve fallback error: %v", err)
	}
	if len(client.fallbackHosts) != 0 {
		t.Fatal("TCP dial failure must not populate denied-host cache")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = client.DialContext(ctx, "tcp", M.ParseSocksaddr("example.test:443"))
	if !errors.Is(err, context.Canceled) || fallbackCalls.Load() != 1 {
		t.Fatalf("cancelled caller dialled fallback: %v", err)
	}
}

func TestValidationAndDefaults(t *testing.T) {
	options := option.BaiduOutboundOptions{ServerOptions: option.ServerOptions{Server: "127.0.0.1", ServerPort: 443}, Secret: testSecret}
	value, err := NewOutbound(context.Background(), nil, log.NewNOPFactory().Logger(), "test", options)
	if err != nil {
		t.Fatal(err)
	}
	client := value.(*Outbound)
	if client.host != "127.0.0.1:443" || client.userAgent != "baiduboxapp" || client.timeout != 10*time.Second {
		t.Fatal("wrong recovered protocol defaults")
	}
	for _, test := range []struct {
		name   string
		change func(*option.BaiduOutboundOptions)
	}{
		{"empty-secret", func(o *option.BaiduOutboundOptions) { o.Secret = "" }},
		{"secret-injection", func(o *option.BaiduOutboundOptions) { o.Secret = "x\r\nInjected: x" }},
		{"host-injection", func(o *option.BaiduOutboundOptions) { o.Host = "x\nInjected: x" }},
		{"ua-control", func(o *option.BaiduOutboundOptions) { o.UserAgent = "x\x00" }},
		{"empty-server", func(o *option.BaiduOutboundOptions) { o.Server = "" }},
		{"zero-port", func(o *option.BaiduOutboundOptions) { o.ServerPort = 0 }},
		{"self-fallback", func(o *option.BaiduOutboundOptions) { o.Fallback = "test" }},
		{"negative-timeout", func(o *option.BaiduOutboundOptions) { o.ConnectTimeout = badoption.Duration(-time.Second) }},
		{"malformed-pool", func(o *option.BaiduOutboundOptions) { o.DestAddrs = []string{"https://127.0.0.1:443"} }},
		{"overflow-port", func(o *option.BaiduOutboundOptions) { o.DestAddrs = []string{"127.0.0.1:70000"} }},
		{"nonnumeric-port", func(o *option.BaiduOutboundOptions) { o.DestAddrs = []string{"127.0.0.1:abc"} }},
	} {
		t.Run(test.name, func(t *testing.T) {
			copyOptions := options
			test.change(&copyOptions)
			if _, err := NewOutbound(context.Background(), nil, log.NewNOPFactory().Logger(), "test", copyOptions); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
	if _, err := client.DialContext(context.Background(), "udp", M.ParseSocksaddr("example.test:443")); !errors.Is(err, os.ErrInvalid) {
		t.Fatal("UDP must be rejected")
	}
	if _, err := client.ListenPacket(context.Background(), M.ParseSocksaddr("example.test:443")); !errors.Is(err, os.ErrInvalid) {
		t.Fatal("packet connections must be rejected")
	}
	if _, err := client.DialContext(context.Background(), "tcp", M.ParseSocksaddrHostPort("good\r\nInjected: x", 443)); err == nil {
		t.Fatal("destination injection accepted")
	}
}

func TestPoolAndCooldown(t *testing.T) {
	var calls atomic.Int32
	live := mockGateway(t, func(conn net.Conn, request string) {
		calls.Add(1)
		io.WriteString(conn, "HTTP/1.1 200 OK\r\n\r\n")
	})
	// Reserve an unused loopback port, then close it to force a local dial error.
	unavailable, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dead := unavailable.Addr().String()
	unavailable.Close()
	client := newTestOutbound(t, live, func(options *option.BaiduOutboundOptions) {
		options.DestAddrs = []string{dead, " " + live.String() + " "}
		options.ConnectTimeout = badoption.Duration(100 * time.Millisecond)
	})
	if client.host != dead {
		t.Fatal("default Host should be first gateway even after rotation")
	}
	for range 2 {
		conn, err := client.DialContext(context.Background(), "tcp", M.ParseSocksaddr("example.test:443"))
		if err != nil {
			t.Fatal(err)
		}
		conn.Close()
	}
	if calls.Load() != 2 || client.gateways[0].failedAt.IsZero() {
		t.Fatal("pool did not fail over from unavailable gateway")
	}
	index, _ := client.pickGateway()
	if index != 1 {
		t.Fatal("cooling gateway was selected while healthy one exists")
	}
	client.gateways[0].failedAt = time.Now().Add(-time.Minute)
	client.nextGateway = 0
	index, _ = client.pickGateway()
	if index != 0 {
		t.Fatal("gateway remained disabled after cooldown")
	}
	for _, text := range []string{"127.0.0.1", "[::1]", "[::1]:443", "gateway.example:8443"} {
		if _, err := parseGateway(text); err != nil {
			t.Fatalf("valid gateway rejected: %s: %v", text, err)
		}
	}
}

func TestConcurrentFallbackMemoryIsBounded(t *testing.T) {
	client := newTestOutbound(t, M.ParseSocksaddr("127.0.0.1:443"), nil)
	client.fallbackTTL = time.Minute
	var workers sync.WaitGroup
	for worker := range 8 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for item := range 200 {
				host := fmt.Sprintf("target-%d-%d.test:443", worker, item)
				client.rememberFallback(host)
				client.useFallback(host)
				client.pickGateway()
			}
		}()
	}
	workers.Wait()
	if len(client.fallbackHosts) > maxRememberedHosts {
		t.Fatal("unbounded rejected-host memory")
	}
}
