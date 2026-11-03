//! ZVONochek для ПК: точка входа. Всё приложение — в lib.rs (общий код с Android).

#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

fn main() {
    zvonochek_lib::run();
}
