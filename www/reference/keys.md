# Keys

| Key | Effect |
|---|---|
| F2 | Rename the selected element, or edit a note |
| F12 | Open in…: open the element in another pane: Source at its statement, Model at its row, or a Canvas that shows it. With nothing selected on a canvas: the view |
| F8, Ctrl+T | Find an element. Enter adds it to the current view. Ctrl+Enter adds it and keeps the picker open. Alt+Enter shows it instead |
| F3 / Shift+F3 | Next / previous occurrence of the element in views |
| Del | Remove the placement from the view. The model does not change |
| Ctrl+Del | Delete the elements of the window selection from the model, after confirmation |
| Ctrl+C / Ctrl+X / Ctrl+V | Copy, cut and paste placements between canvases |
| Ctrl+D | Duplicate the selected elements |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo (shared model history, outside text inputs) |
| Ctrl+Enter | Commit a note |
| Escape | Cancel the current edit. It never commits |

On macOS, use Cmd where this table says Ctrl.

## Command line

`pnpm -s catenary` controls a running backend from a terminal: read the model, run edit commands, run UI commands and answer prompts. See the [readme](https://github.com/cristianvasquez/catenary#command-line-interface).
