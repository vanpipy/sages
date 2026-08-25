// go-with-viper fixture for GoDetector Viper-specific tests.
// Minimal: declares viper dependency in go.mod and imports it.
package main

import "github.com/spf13/viper"

func main() {
	_ = viper.Get("key")
}