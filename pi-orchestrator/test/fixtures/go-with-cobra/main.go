// go-with-cobra fixture for GoDetector / ProjectAnalyzer tests.
// Mirrors the dependency surface of awp (cobra + bubbletea TUI stack).
package main

import (
	"github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/spf13/cobra"
)

type model struct {
	input textinput.Model
}

func (m model) Init() bubbletea.Cmd { return nil }
func (m model) Update(msg bubbletea.Msg) (bubbletea.Model, bubbletea.Cmd) {
	return m, nil
}
func (m model) View() string {
	return lipgloss.NewStyle().Render(m.input.View())
}

func main() {
	var rootCmd = &cobra.Command{Use: "fixture"}
	rootCmd.Execute()
}