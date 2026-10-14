package baidu

import (
	"context"
	"errors"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/adapter/outbound"
	"github.com/sagernet/sing-box/common/dialer"
	C "github.com/sagernet/sing-box/constant"
	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	E "github.com/sagernet/sing/common/exceptions"
	"github.com/sagernet/sing/common/json/badoption"
	"github.com/sagernet/sing/common/logger"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
	"github.com/sagernet/sing/service"
)

const (
	defaultTimeout     = 10 * time.Second
	gatewayCooldown    = 30 * time.Second
	maxRememberedHosts = 512
)

func RegisterOutbound(registry *outbound.Registry) {
	outbound.Register[option.BaiduOutboundOptions](registry, C.TypeBaidu, NewOutbound)
}

type gateway struct {
	address  M.Socksaddr
	failedAt time.Time
}

type Outbound struct {
	outbound.Adapter
	logger        logger.ContextLogger
	dialer        N.Dialer
	manager       adapter.OutboundManager
	fallbackTag   string
	fallback      adapter.Outbound
	host          string
	secret        string
	userAgent     string
	timeout       time.Duration
	fallbackTTL   time.Duration
	now           func() time.Time
	access        sync.Mutex
	gateways      []gateway
	nextGateway   int
	fallbackHosts map[string]time.Time
}

func NewOutbound(ctx context.Context, router adapter.Router, logger log.ContextLogger, tag string, options option.BaiduOutboundOptions) (adapter.Outbound, error) {
	gateways, err := parseGateways(options)
	if err != nil {
		return nil, err
	}
	if options.Secret == "" {
		return nil, E.New("missing secret: provide your own gateway credential")
	}
	if options.Host == "" {
		options.Host = gateways[0].address.String()
	}
	if options.UserAgent == "" {
		options.UserAgent = "baiduboxapp"
	}
	for name, value := range map[string]string{"secret": options.Secret, "host": options.Host, "user_agent": options.UserAgent} {
		if !validHeaderValue(value) {
			return nil, E.New("invalid ", name, ": control characters are not allowed")
		}
	}
	if options.Fallback != "" && options.Fallback == tag {
		return nil, E.New("fallback cannot refer to this outbound")
	}
	if options.ConnectTimeout < 0 {
		return nil, E.New("connect_timeout must be positive")
	}
	if options.ConnectTimeout == 0 {
		options.ConnectTimeout = badoption.Duration(defaultTimeout)
	}
	remoteIsDomain := false
	for _, gateway := range gateways {
		remoteIsDomain = remoteIsDomain || gateway.address.IsDomain()
	}
	outboundDialer, err := dialer.New(ctx, options.DialerOptions, remoteIsDomain)
	if err != nil {
		return nil, err
	}
	dependencies := make([]string, 0, 2)
	if options.Detour != "" {
		dependencies = append(dependencies, options.Detour)
	}
	if options.Fallback != "" && options.Fallback != options.Detour {
		dependencies = append(dependencies, options.Fallback)
	}
	timeout := time.Duration(options.ConnectTimeout)
	if timeout == 0 {
		timeout = defaultTimeout
	}
	fallbackTTL := time.Duration(0)
	if options.Fallback != "" {
		if options.FallbackHostTTL == 0 {
			fallbackTTL = 300 * time.Second
		} else if options.FallbackHostTTL > 0 {
			fallbackTTL = time.Duration(options.FallbackHostTTL) * time.Second
			if fallbackTTL <= 0 || fallbackTTL/time.Second != time.Duration(options.FallbackHostTTL) {
				return nil, E.New("fallback_host_ttl is too large")
			}
		}
	}
	return &Outbound{
		Adapter: outbound.NewAdapter(C.TypeBaidu, tag, []string{N.NetworkTCP}, dependencies),
		logger:  logger, dialer: outboundDialer,
		manager:     service.FromContext[adapter.OutboundManager](ctx),
		fallbackTag: options.Fallback,
		host:        options.Host, secret: options.Secret, userAgent: options.UserAgent,
		timeout: timeout, fallbackTTL: fallbackTTL, now: time.Now,
		gateways: gateways, fallbackHosts: make(map[string]time.Time),
	}, nil
}

func (h *Outbound) Start(stage adapter.StartStage, scope *adapter.Scope) error {
	if stage != adapter.StartStateStart || h.fallbackTag == "" {
		return nil
	}
	if h.manager == nil {
		return E.New("missing outbound manager for fallback")
	}
	fallback, loaded := h.manager.Outbound(h.fallbackTag)
	if !loaded {
		return E.New("fallback outbound not found: ", h.fallbackTag)
	}
	if fallback.Type() == C.TypeBaidu {
		return E.New("fallback cannot use another baidu outbound")
	}
	if !containsTCP(fallback.Network()) {
		return E.New("fallback outbound does not support TCP: ", h.fallbackTag)
	}
	h.fallback = fallback
	return nil
}

func (h *Outbound) DialContext(ctx context.Context, network string, destination M.Socksaddr) (net.Conn, error) {
	if N.NetworkName(network) != N.NetworkTCP {
		return nil, os.ErrInvalid
	}
	if !validAddress(destination) {
		return nil, E.New("invalid destination")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	ctx, metadata := adapter.ExtendContext(ctx)
	metadata.Outbound = h.Tag()
	metadata.Destination = destination
	h.logger.InfoContext(ctx, "outbound connection to ", destination)
	if h.fallback != nil && h.useFallback(destination.String()) {
		return h.fallback.DialContext(ctx, N.NetworkTCP, destination)
	}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		conn, err := h.dialGateway(ctx)
		if err != nil {
			lastErr = err
			break
		}
		conn, err = connect(ctx, conn, destination, h.host, h.userAgent, h.secret, h.timeout)
		if err == nil {
			return conn, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var statusErr *StatusError
		if errors.As(err, &statusErr) && (statusErr.StatusCode == 403 || statusErr.StatusCode == 503) {
			if h.fallback != nil {
				h.rememberFallback(destination.String())
			}
			break
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if h.fallback != nil {
		h.logger.DebugContext(ctx, "gateway failed; using fallback ", h.fallbackTag)
		conn, err := h.fallback.DialContext(ctx, N.NetworkTCP, destination)
		if err != nil {
			return nil, E.Errors(lastErr, E.Cause(err, "fallback"))
		}
		return conn, nil
	}
	return nil, lastErr
}

func (h *Outbound) ListenPacket(context.Context, M.Socksaddr) (net.PacketConn, error) {
	return nil, os.ErrInvalid
}

func (h *Outbound) dialGateway(ctx context.Context) (net.Conn, error) {
	var lastErr error
	for range h.gateways {
		index, address := h.pickGateway()
		dialCtx, cancel := context.WithTimeout(ctx, h.timeout)
		conn, err := h.dialer.DialContext(dialCtx, N.NetworkTCP, address)
		cancel()
		if err == nil {
			return conn, nil
		}
		lastErr = err
		h.access.Lock()
		h.gateways[index].failedAt = h.now()
		h.access.Unlock()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return nil, E.Cause(lastErr, "dial baidu gateway")
}

func (h *Outbound) pickGateway() (int, M.Socksaddr) {
	h.access.Lock()
	defer h.access.Unlock()
	start := h.nextGateway % len(h.gateways)
	h.nextGateway = (start + 1) % len(h.gateways)
	now := h.now()
	for step := range h.gateways {
		index := (start + step) % len(h.gateways)
		entry := h.gateways[index]
		if entry.failedAt.IsZero() || now.Sub(entry.failedAt) >= gatewayCooldown {
			h.nextGateway = (index + 1) % len(h.gateways)
			return index, entry.address
		}
	}
	return start, h.gateways[start].address
}

func (h *Outbound) useFallback(host string) bool {
	h.access.Lock()
	defer h.access.Unlock()
	expires, loaded := h.fallbackHosts[host]
	if loaded && !h.now().Before(expires) {
		delete(h.fallbackHosts, host)
		return false
	}
	return loaded
}

func (h *Outbound) rememberFallback(host string) {
	if h.fallbackTTL <= 0 {
		return
	}
	h.access.Lock()
	defer h.access.Unlock()
	now := h.now()
	if len(h.fallbackHosts) >= maxRememberedHosts {
		for host, expires := range h.fallbackHosts {
			if !now.Before(expires) {
				delete(h.fallbackHosts, host)
			}
		}
		if len(h.fallbackHosts) >= maxRememberedHosts {
			clear(h.fallbackHosts)
		}
	}
	h.fallbackHosts[host] = now.Add(h.fallbackTTL)
}

func containsTCP(networks []string) bool {
	for _, network := range networks {
		if network == N.NetworkTCP {
			return true
		}
	}
	return false
}

func parseGateways(options option.BaiduOutboundOptions) ([]gateway, error) {
	var addresses []M.Socksaddr
	for index, raw := range options.DestAddrs {
		raw = strings.TrimSpace(raw)
		address, err := parseGateway(raw)
		if err != nil {
			return nil, E.Cause(err, "invalid dest_addrs[", index, "]")
		}
		addresses = append(addresses, address)
	}
	if len(addresses) == 0 {
		address := options.ServerOptions.Build()
		if !validAddress(address) {
			return nil, E.New("missing or invalid server/server_port")
		}
		addresses = append(addresses, address)
	}
	gateways := make([]gateway, 0, len(addresses))
	for _, address := range addresses {
		gateways = append(gateways, gateway{address: address})
	}
	return gateways, nil
}

func parseGateway(raw string) (M.Socksaddr, error) {
	if raw == "" {
		return M.Socksaddr{}, E.New("empty address")
	}
	var address M.Socksaddr
	if host, portText, err := net.SplitHostPort(raw); err == nil {
		port, err := strconv.ParseUint(portText, 10, 16)
		if err != nil || port == 0 {
			return M.Socksaddr{}, E.New("invalid port")
		}
		address = M.ParseSocksaddrHostPort(host, uint16(port))
	} else {
		address = M.ParseSocksaddrHostPort(raw, 443)
	}
	if !validAddress(address) {
		return M.Socksaddr{}, E.New("invalid address")
	}
	return address, nil
}

func validAddress(address M.Socksaddr) bool {
	if !address.IsValid() || address.Port == 0 {
		return false
	}
	if address.IsDomain() {
		for _, c := range address.Fqdn {
			if c <= ' ' || c == 127 || strings.ContainsRune("/\\:#?@[]", c) {
				return false
			}
		}
	}
	return true
}

func validHeaderValue(value string) bool {
	for _, c := range value {
		if c < 32 && c != '\t' || c == 127 {
			return false
		}
	}
	return true
}
