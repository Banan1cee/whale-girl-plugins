(module
  (import "whale" "input_size" (func $size (result i32)))
  (func (export "run") (result i32) call $size))
