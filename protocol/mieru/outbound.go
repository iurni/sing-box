package mieru

import (
	"context"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"

	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/adapter/outbound"
	"github.com/sagernet/sing-box/common/dialer"
	C "github.com/sagernet/sing-box/constant"
	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	E "github.com/sagernet/sing/common/exceptions"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
	"github.com/sagernet/sing/service"

	mieruclient "github.com/enfein/mieru/v3/apis/client"
	mierucommon "github.com/enfein/mieru/v3/apis/common"
	mierumodel "github.com/enfein/mieru/v3/apis/model"
	mierutp "github.com/enfein/mieru/v3/apis/trafficpattern"
	mierupb "github.com/enfein/mieru/v3/pkg/appctl/appctlpb"
	"google.golang.org/protobuf/proto"
)

type Outbound struct {
	outbound.Adapter
	dialer N.Dialer
	logger log.ContextLogger
	client mieruclient.Client
}

func RegisterOutbound(registry *outbound.Registry) {
	outbound.Register(registry, C.TypeMieru, NewOutbound)
}

func NewOutbound(ctx context.Context, router adapter.Router, logger log.ContextLogger, tag string, options option.MieruOutboundOptions) (adapter.Outbound, error) {
	outboundDialer, err := dialer.New(ctx, options.DialerOptions, M.IsDomainName(options.Server))
	if err != nil {
		return nil, err
	}

	config, err := buildMieruClientConfig(options, mieruDialer{dialer: outboundDialer})
	if err != nil {
		return nil, fmt.Errorf("failed to build mieru client config: %w", err)
	}
	// Mieru's UDP underlay always resolves the server before invoking PacketDialer.
	// Without an explicit resolver the client API uses NilDNSResolver, so domains
	// fail. Use sing-box's configured DNS transport, never the system resolver.
	if options.Transport == "UDP" && M.IsDomainName(options.Server) {
		queryOptions, err := dialer.NewDNSQueryOptions(ctx, options.DomainResolver, false)
		if err != nil {
			return nil, E.Cause(err, "mieru UDP server resolver")
		}
		// Match the normal sing-box resolver's legacy strategy precedence.
		//nolint:staticcheck
		if options.DomainStrategy != option.DomainStrategy(C.DomainStrategyAsIS) && (options.DomainResolver == nil || options.DomainResolver.Server == "" || options.DomainResolver.Strategy == option.DomainStrategy(C.DomainStrategyAsIS)) {
			//nolint:staticcheck
			queryOptions.Strategy = C.DomainStrategy(options.DomainStrategy)
		}
		dnsRouter := service.FromContext[adapter.DNSRouter](ctx)
		if dnsRouter == nil {
			return nil, E.New("missing DNS router for mieru UDP server")
		}
		config.Resolver = mieruResolver{router: dnsRouter, options: queryOptions}
	}
	c := mieruclient.NewClient()
	if err := c.Store(config); err != nil {
		return nil, fmt.Errorf("failed to store mieru client config: %w", err)
	}
	if err := c.Start(); err != nil {
		return nil, fmt.Errorf("failed to start mieru client: %w", err)
	}
	logger.InfoContext(ctx, "mieru client is started")

	return &Outbound{
		Adapter: outbound.NewAdapterWithDialerOptions(C.TypeMieru, tag, []string{N.NetworkTCP, N.NetworkUDP}, options.DialerOptions),
		dialer:  outboundDialer,
		logger:  logger,
		client:  c,
	}, nil
}

func (o *Outbound) DialContext(ctx context.Context, network string, destination M.Socksaddr) (net.Conn, error) {
	ctx, metadata := adapter.ExtendContext(ctx)
	metadata.Outbound = o.Tag()
	metadata.Destination = destination
	switch N.NetworkName(network) {
	case N.NetworkTCP:
		o.logger.InfoContext(ctx, "outbound connection to ", destination)
		d, err := socksAddrToNetAddrSpec(destination, "tcp")
		if err != nil {
			return nil, E.Cause(err, "failed to convert destination address")
		}
		return o.client.DialContext(ctx, d)
	case N.NetworkUDP:
		o.logger.InfoContext(ctx, "outbound UoT packet connection to ", destination)
		d, err := socksAddrToNetAddrSpec(destination, "udp")
		if err != nil {
			return nil, E.Cause(err, "failed to convert destination address")
		}
		streamConn, err := o.client.DialContext(ctx, d)
		if err != nil {
			return nil, err
		}
		return &streamer{
			PacketConn: mierucommon.NewUDPAssociateWrapper(mierucommon.NewPacketOverStreamTunnel(streamConn)),
			Remote:     destination,
		}, nil
	default:
		return nil, os.ErrInvalid
	}
}

func (o *Outbound) ListenPacket(ctx context.Context, destination M.Socksaddr) (net.PacketConn, error) {
	ctx, metadata := adapter.ExtendContext(ctx)
	metadata.Outbound = o.Tag()
	metadata.Destination = destination
	o.logger.InfoContext(ctx, "outbound UoT packet connection to ", destination)
	d, err := socksAddrToNetAddrSpec(destination, "udp")
	if err != nil {
		return nil, E.Cause(err, "failed to convert destination address")
	}
	streamConn, err := o.client.DialContext(ctx, d)
	if err != nil {
		return nil, err
	}
	return mierucommon.NewUDPAssociateWrapper(mierucommon.NewPacketOverStreamTunnel(streamConn)), nil
}

func (o *Outbound) Close() error {
	return o.client.Stop()
}

// mieruResolver uses sing-box's DNS router for UDP server hostnames.
type mieruResolver struct {
	router  adapter.DNSRouter
	options adapter.DNSQueryOptions
}

func (r mieruResolver) LookupIP(ctx context.Context, network, host string) ([]net.IP, error) {
	options := r.options
	switch network {
	case "ip4":
		options.Strategy = C.DomainStrategyIPv4Only
	case "ip6":
		options.Strategy = C.DomainStrategyIPv6Only
	case "", "ip":
	default:
		return nil, net.UnknownNetworkError(network)
	}
	addresses, err := r.router.Lookup(ctx, host, options)
	if err != nil {
		return nil, err
	}
	result := make([]net.IP, 0, len(addresses))
	for _, address := range addresses {
		result = append(result, net.IP(address.AsSlice()))
	}
	return result, nil
}

// mieruDialer is an adapter to mieru dialer interface.
type mieruDialer struct {
	dialer N.Dialer
}

func (md mieruDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	addr := M.ParseSocksaddr(address)
	return md.dialer.DialContext(ctx, network, addr)
}

func (md mieruDialer) ListenPacket(ctx context.Context, network, laddr, raddr string) (net.PacketConn, error) {
	addr := M.ParseSocksaddr(raddr)
	return md.dialer.ListenPacket(ctx, addr)
}

var (
	_ mierucommon.Dialer       = (*mieruDialer)(nil)
	_ mierucommon.PacketDialer = (*mieruDialer)(nil)
)

// streamer converts a net.PacketConn to a net.Conn.
type streamer struct {
	net.PacketConn
	Remote net.Addr
}

var _ net.Conn = (*streamer)(nil)

func (s *streamer) Read(b []byte) (n int, err error) {
	n, _, err = s.PacketConn.ReadFrom(b)
	return
}

func (s *streamer) Write(b []byte) (n int, err error) {
	return s.WriteTo(b, s.Remote)
}

func (s *streamer) RemoteAddr() net.Addr {
	return s.Remote
}

// socksAddrToNetAddrSpec converts a Socksaddr object to NetAddrSpec, and overrides the network.
func socksAddrToNetAddrSpec(sa M.Socksaddr, network string) (mierumodel.NetAddrSpec, error) {
	var nas mierumodel.NetAddrSpec
	if err := nas.From(sa); err != nil {
		return nas, err
	}
	nas.Net = network
	return nas, nil
}

func buildMieruClientConfig(options option.MieruOutboundOptions, dialer mieruDialer) (*mieruclient.ClientConfig, error) {
	if err := validateMieruOptions(options); err != nil {
		return nil, fmt.Errorf("failed to validate mieru options: %w", err)
	}

	var transportProtocol *mierupb.TransportProtocol
	switch options.Transport {
	case "TCP":
		transportProtocol = mierupb.TransportProtocol_TCP.Enum()
	case "UDP":
		transportProtocol = mierupb.TransportProtocol_UDP.Enum()
	}
	server := &mierupb.ServerEndpoint{}
	if options.ServerPort != 0 {
		server.PortBindings = append(server.PortBindings, &mierupb.PortBinding{
			Port:     proto.Int32(int32(options.ServerPort)),
			Protocol: transportProtocol,
		})
	}
	for _, pr := range options.ServerPortRanges {
		server.PortBindings = append(server.PortBindings, &mierupb.PortBinding{
			PortRange: proto.String(pr),
			Protocol:  transportProtocol,
		})
	}
	if M.IsDomainName(options.Server) {
		server.DomainName = proto.String(options.Server)
	} else {
		server.IpAddress = proto.String(options.Server)
	}
	config := &mieruclient.ClientConfig{
		Profile: &mierupb.ClientProfile{
			ProfileName: proto.String("sing-box"),
			User: &mierupb.User{
				Name:     proto.String(options.UserName),
				Password: proto.String(options.Password),
			},
			Servers: []*mierupb.ServerEndpoint{server},
		},
		Dialer:       dialer,
		PacketDialer: dialer,
		DNSConfig: &mierucommon.ClientDNSConfig{
			BypassDialerDNS: true,
		},
	}
	if multiplexing, ok := mierupb.MultiplexingLevel_value[options.Multiplexing]; ok {
		config.Profile.Multiplexing = &mierupb.MultiplexingConfig{
			Level: mierupb.MultiplexingLevel(multiplexing).Enum(),
		}
	}
	if options.TrafficPattern != "" {
		trafficPattern, _ := mierutp.Decode(options.TrafficPattern)
		config.Profile.TrafficPattern = trafficPattern
	}
	return config, nil
}

func validateMieruOptions(options option.MieruOutboundOptions) error {
	if options.Server == "" {
		return fmt.Errorf("server is empty")
	}
	if options.ServerPort == 0 && len(options.ServerPortRanges) == 0 {
		return fmt.Errorf("either server_port or server_ports must be set")
	}
	for _, pr := range options.ServerPortRanges {
		begin, end, err := beginAndEndPortFromPortRange(pr)
		if err != nil {
			return fmt.Errorf("invalid server_ports format")
		}
		if begin < 1 || begin > 65535 {
			return fmt.Errorf("begin port must be between 1 and 65535")
		}
		if end < 1 || end > 65535 {
			return fmt.Errorf("end port must be between 1 and 65535")
		}
		if begin > end {
			return fmt.Errorf("begin port must be less than or equal to end port")
		}
	}
	if options.Transport != "TCP" && options.Transport != "UDP" {
		return fmt.Errorf("transport must be TCP or UDP")
	}
	if options.UserName == "" {
		return fmt.Errorf("username is empty")
	}
	if options.Password == "" {
		return fmt.Errorf("password is empty")
	}
	if options.Multiplexing != "" {
		if _, ok := mierupb.MultiplexingLevel_value[options.Multiplexing]; !ok {
			return fmt.Errorf("invalid multiplexing level: %s", options.Multiplexing)
		}
	}
	if options.TrafficPattern != "" {
		trafficPattern, err := mierutp.Decode(options.TrafficPattern)
		if err != nil {
			return fmt.Errorf("failed to decode traffic pattern %q: %w", options.TrafficPattern, err)
		}
		if err := mierutp.Validate(trafficPattern); err != nil {
			return fmt.Errorf("invalid traffic pattern %q: %w", options.TrafficPattern, err)
		}
	}
	return nil
}

func beginAndEndPortFromPortRange(portRange string) (int, int, error) {
	parts := strings.Split(portRange, "-")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return 0, 0, fmt.Errorf("invalid port range %q", portRange)
	}
	begin, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, err
	}
	end, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, err
	}
	return begin, end, nil
}
