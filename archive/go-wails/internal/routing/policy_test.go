package routing

import (
	"testing"

	"github.com/cuongtechnology/VPN-to-Proxy/internal/config"
)

func TestClientIsolationAndFailure(t *testing.T) {
	c := config.Config{Version: 1,
		Outbounds: []config.Outbound{
			{ID: "a", Name: "A", Protocol: "wireguard", Host: "a.example.com", Port: 51820},
			{ID: "b", Name: "B", Protocol: "socks5", Host: "b.example.com", Port: 1080},
		},
		Clients: []config.Client{
			{ID: "phone", Name: "Phone", Kind: "vpn", Identity: "phone", OutboundID: "a"},
			{ID: "browser", Name: "Browser", Kind: "proxy", Identity: "browser", OutboundID: "b"},
		},
	}
	available := map[string]bool{"a": true, "b": true}
	if got := Evaluate(c, "phone", available); got.Action != "forward" || got.OutboundID != "a" {
		t.Fatalf("wrong phone route: %+v", got)
	}
	available["a"] = false
	if got := Evaluate(c, "phone", available); got.Action != "block" {
		t.Fatalf("unavailable outbound leaked: %+v", got)
	}
	if got := Evaluate(c, "browser", available); got.Action != "forward" || got.OutboundID != "b" {
		t.Fatalf("wrong browser route: %+v", got)
	}
	if got := Evaluate(c, "unknown", available); got.Action != "block" {
		t.Fatalf("unknown client accepted: %+v", got)
	}
}
