package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// Build the frontend before compiling: npm --prefix frontend run build.
//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app, err := NewApp()
	if err != nil {
		log.Fatal(err)
	}
	if err := wails.Run(&options.App{
		Title: "VPNtoProxy", Width: 1280, Height: 840, MinWidth: 800, MinHeight: 600,
		BackgroundColour: &options.RGBA{R: 245, G: 247, B: 246, A: 255},
		AssetServer: &assetserver.Options{Assets: assets},
		Bind: []interface{}{app},
	}); err != nil {
		log.Fatal(err)
	}
}
