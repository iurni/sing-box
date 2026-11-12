package mieru

import (
	"github.com/sagernet/sing-box/option"
	"testing"
)

func TestValidateMieruOutbound(t *testing.T) {
	valid := option.MieruOutboundOptions{
		ServerOptions: option.ServerOptions{Server: "127.0.0.1", ServerPort: 12345},
		Transport:     "TCP", UserName: "test", Password: "test-password",
	}
	cases := []struct {
		name   string
		change func(*option.MieruOutboundOptions)
		valid  bool
	}{
		{"valid", func(o *option.MieruOutboundOptions) {}, true},
		{"udp", func(o *option.MieruOutboundOptions) { o.Transport = "UDP" }, true},
		{"ranges", func(o *option.MieruOutboundOptions) { o.ServerPort = 0; o.ServerPortRanges = []string{"100-200"} }, true},
		{"missing server", func(o *option.MieruOutboundOptions) { o.Server = "" }, false},
		{"missing port", func(o *option.MieruOutboundOptions) { o.ServerPort = 0 }, false},
		{"range suffix", func(o *option.MieruOutboundOptions) { o.ServerPortRanges = []string{"100-200junk"} }, false},
		{"bad range", func(o *option.MieruOutboundOptions) { o.ServerPortRanges = []string{"200-100"} }, false},
		{"invalid transport", func(o *option.MieruOutboundOptions) { o.Transport = "tcp" }, false},
		{"missing credentials", func(o *option.MieruOutboundOptions) { o.Password = "" }, false},
		{"invalid multiplexing", func(o *option.MieruOutboundOptions) { o.Multiplexing = "HIGH" }, false},
		{"invalid traffic pattern", func(o *option.MieruOutboundOptions) { o.TrafficPattern = "%" }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			o := valid
			tc.change(&o)
			err := validateMieruOptions(o)
			if (err == nil) != tc.valid {
				t.Fatalf("validation error: %v", err)
			}
		})
	}
}

func TestValidateMieruInbound(t *testing.T) {
	options := option.MieruInboundOptions{ListenPort: 12345, Transport: "TCP", Users: []option.MieruUser{{Name: "test", Password: "test-password"}}}
	if _, _, err := buildMieruServerConfig(nil, options); err != nil {
		t.Fatal(err)
	}
	options.ListenPort = 0
	if _, _, err := buildMieruServerConfig(nil, options); err == nil {
		t.Fatal("missing port accepted")
	}
	options.ListenPort = 12345
	options.Users[0].Password = ""
	if _, _, err := buildMieruServerConfig(nil, options); err == nil {
		t.Fatal("missing password accepted")
	}
}
