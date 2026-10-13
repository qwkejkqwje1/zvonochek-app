package web

import _ "embed"

// IndexHTML holds the embedded single-page application frontend.
// Placing go:embed inside package web avoids invalid "../" parent traversal paths.
//
//go:embed index.html
var IndexHTML []byte
