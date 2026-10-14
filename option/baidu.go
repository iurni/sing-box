package option

// BaiduOutboundOptions describes the experimental, non-upstream CONNECT dialect.
type BaiduOutboundOptions struct {
	DialerOptions
	ServerOptions
	Secret          string   `json:"secret"`
	Host            string   `json:"host,omitempty"`
	UserAgent       string   `json:"user_agent,omitempty"`
	DestAddrs       []string `json:"dest_addrs,omitempty"`
	Fallback        string   `json:"fallback,omitempty" reference:"outbound"`
	FallbackHostTTL int      `json:"fallback_host_ttl,omitempty"`
}
