package main

import (
	"os"
	"path/filepath"

	"github.com/cuongtechnology/VPN-to-Proxy/internal/config"
)

// App exposes configuration operations only. No network engine is active yet.
type App struct {
	store *config.Store
}

func NewApp() (*App, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	return &App{store: config.NewStore(filepath.Join(dir, "VPNtoProxy", "config.json"))}, nil
}

func (a *App) LoadConfig() (config.Config, error) {
	return a.store.Load()
}

func (a *App) SaveConfig(value config.Config) error {
	return a.store.Save(value)
}
