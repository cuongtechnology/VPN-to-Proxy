package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStorePreservesDataOnInvalidSave(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "config.json"))
	value, err := store.Load()
	if err != nil || value.Version != 1 || len(value.Clients) != 0 {
		t.Fatalf("empty load: %+v, %v", value, err)
	}
	value.Outbounds = append(value.Outbounds, Outbound{ID: "a", Name: "Office", Protocol: "wireguard", Host: "vpn.example.com", Port: 51820})
	if err := store.Save(value); err != nil {
		t.Fatal(err)
	}
	value.Outbounds[0].Port = 0
	if err := store.Save(value); err == nil {
		t.Fatal("invalid config saved")
	}
	saved, err := store.Load()
	if err != nil || saved.Outbounds[0].Port != 51820 {
		t.Fatalf("previous data lost: %+v, %v", saved, err)
	}
	saved.Outbounds[0].Name = "Updated"
	if err := store.Save(saved); err != nil {
		t.Fatalf("replace existing configuration: %v", err)
	}
	updated, err := store.Load()
	if err != nil || updated.Outbounds[0].Name != "Updated" {
		t.Fatalf("update not persisted: %+v, %v", updated, err)
	}
}

func TestCorruptConfigIsNotReplacedOnLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	data := []byte("{corrupt")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewStore(path).Load(); err == nil {
		t.Fatal("corrupt config was accepted")
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(data) {
		t.Fatal("corrupt data was overwritten")
	}
}
