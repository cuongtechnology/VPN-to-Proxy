package routing

import "github.com/cuongtechnology/VPN-to-Proxy/internal/config"

// Decision is a configuration preview, not evidence of a live network path.
type Decision struct {
	Action     string
	OutboundID string
	Reason     string
}

func Evaluate(c config.Config, clientID string, available map[string]bool) Decision {
	if c.Validate() != nil {
		return Decision{Action: "block", Reason: "invalidConfig"}
	}
	for _, client := range c.Clients {
		if client.ID != clientID {
			continue
		}
		if client.OutboundID == "" {
			return Decision{Action: "block", Reason: "unassigned"}
		}
		if !available[client.OutboundID] {
			return Decision{Action: "block", OutboundID: client.OutboundID, Reason: "unavailable"}
		}
		return Decision{Action: "forward", OutboundID: client.OutboundID, Reason: "assigned"}
	}
	return Decision{Action: "block", Reason: "unknownClient"}
}
