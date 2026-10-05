package config

import (
	"errors"
	"net"
	"strings"
	"unicode/utf16"
)

type Outbound struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
}

type Client struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Identity   string `json:"identity"`
	OutboundID string `json:"outboundId"`
}

type Config struct {
	Version   int        `json:"version"`
	Outbounds []Outbound `json:"outbounds"`
	Clients   []Client   `json:"clients"`
}

func Empty() Config {
	return Config{Version: 1, Outbounds: []Outbound{}, Clients: []Client{}}
}

func validText(s string, limit int) bool {
	if strings.TrimSpace(s) == "" || len(utf16.Encode([]rune(s))) > limit {
		return false
	}
	for _, r := range s {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}

func validHost(s string) bool {
	if len(s) == 0 || len(s) > 253 || strings.ContainsAny(s, " /@?#\t\r\n") {
		return false
	}
	if net.ParseIP(s) != nil {
		return true
	}
	if strings.Contains(s, ":") {
		return false
	}
	allNumeric := true
	for _, c := range s {
		if (c < '0' || c > '9') && c != '.' {
			allNumeric = false
		}
	}
	if allNumeric {
		return false
	}
	for _, label := range strings.Split(s, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-') {
				return false
			}
		}
	}
	return true
}

func (c Config) Validate() error {
	if c.Version != 1 || c.Outbounds == nil || c.Clients == nil || len(c.Outbounds) > 1000 || len(c.Clients) > 10000 {
		return errors.New("invalidConfig")
	}
	outbounds := make(map[string]bool)
	for _, o := range c.Outbounds {
		if !validText(o.ID, 100) || outbounds[o.ID] {
			return errors.New("invalidConfig")
		}
		outbounds[o.ID] = true
		if !validText(o.Name, 100) {
			return errors.New("invalidName")
		}
		if (o.Protocol != "wireguard" && o.Protocol != "http" && o.Protocol != "socks5") || !validHost(o.Host) || o.Port < 1 || o.Port > 65535 {
			return errors.New("invalidEndpoint")
		}
	}
	ids, identities := make(map[string]bool), make(map[string]bool)
	for _, client := range c.Clients {
		if !validText(client.ID, 100) || ids[client.ID] || !validText(client.Identity, 256) || (client.Kind != "vpn" && client.Kind != "proxy") {
			return errors.New("invalidConfig")
		}
		ids[client.ID] = true
		if !validText(client.Name, 100) {
			return errors.New("invalidName")
		}
		identity := client.Kind + ":" + client.Identity
		if identities[identity] {
			return errors.New("duplicateIdentity")
		}
		identities[identity] = true
		if client.OutboundID != "" && !outbounds[client.OutboundID] {
			return errors.New("missingOutbound")
		}
	}
	return nil
}
