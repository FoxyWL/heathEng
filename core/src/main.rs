//! hearth-core: метрики процессов для Hearth.
//!
//! Протокол (stdin → stdout, строки):
//!   `watch 123 456`  — задать набор отслеживаемых PID (заменяет предыдущий)
//!   `limit 123 0xF0` — привязать дерево процессов 123 к ядрам из маски (0 снимает привязку из учёта)
//!   `sys`            — один раз вывести сведения о системе
//!   `quit`           — выйти
//! Раз в `--interval` мс (по умолчанию 2000) выводится строка JSON:
//!   {"t":"stats","items":[{"pid":123,"cpu":12.3,"rss":456789,"procs":3,"aff":240}]}
//! aff — маска ядер, успешно применённая ко всему дереву (0, если привязка не задана или не удалась).
//! cpu — проценты от всех логических ядер по всему дереву процессов, rss — байты рабочего набора.
//! Процесс завершается, когда закрыт stdin (родитель умер).

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

mod sys;

struct Prev {
    cpu_secs: f64,
    at: Instant,
}

fn json_escape_free(v: f64) -> String {
    if v.is_finite() { format!("{:.1}", v) } else { "0.0".to_string() }
}

fn main() {
    let mut interval = 2000u64;
    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--interval" if i + 1 < args.len() => {
                interval = args[i + 1].parse().unwrap_or(2000).clamp(250, 60000);
                i += 1;
            }
            "--once" => {
                // разовый замер для указанных PID: hearth-core --once 123 456
                let pids: Vec<u32> = args[i + 1..].iter().filter_map(|s| s.parse().ok()).collect();
                let first = sys::snapshot_tree(&pids);
                std::thread::sleep(Duration::from_millis(500));
                let second = sys::snapshot_tree(&pids);
                println!("{}", render(&pids, &first, &second, 0.5));
                return;
            }
            "--selftest" => {
                // грузим одно ядро и держим ~64 МБ, затем меряем собственный процесс
                let mem = vec![1u8; 64 * 1024 * 1024];
                let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                let s2 = stop.clone();
                let h = std::thread::spawn(move || {
                    let mut x = 0u64;
                    while !s2.load(std::sync::atomic::Ordering::Relaxed) {
                        x = x.wrapping_add(1);
                        std::hint::black_box(x);
                    }
                });
                let pids = [std::process::id()];
                let first = sys::snapshot_tree(&pids);
                std::thread::sleep(Duration::from_millis(1000));
                let second = sys::snapshot_tree(&pids);
                stop.store(true, std::sync::atomic::Ordering::Relaxed);
                let _ = h.join();
                std::hint::black_box(&mem);
                println!("{}", render(&pids, &first, &second, 1.0));
                println!("{{\"t\":\"sys\",\"cores\":{},\"totalMem\":{}}}", sys::system_info().cores, sys::system_info().total_mem);
                return;
            }
            "--version" | "-V" => {
                println!("hearth-core {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            _ => {}
        }
        i += 1;
    }

    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(l) => {
                    if tx.send(l).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send("quit".to_string());
    });

    let out = std::io::stdout();
    let mut pids: Vec<u32> = Vec::new();
    let mut prev: HashMap<u32, Prev> = HashMap::new();
    let mut masks: HashMap<u32, u64> = HashMap::new();
    let mut next_tick = Instant::now();
    loop {
        let wait = next_tick.saturating_duration_since(Instant::now());
        match rx.recv_timeout(wait) {
            Ok(line) => {
                let mut parts = line.split_whitespace();
                match parts.next() {
                    Some("watch") => {
                        pids = parts.filter_map(|p| p.parse().ok()).collect();
                        prev.retain(|k, _| pids.contains(k));
                        masks.retain(|k, _| pids.contains(k));
                        next_tick = Instant::now(); // сразу первый замер
                    }
                    Some("limit") => {
                        let pid: Option<u32> = parts.next().and_then(|p| p.parse().ok());
                        let raw = parts.next().unwrap_or("0");
                        let mask = if let Some(h) = raw.strip_prefix("0x") { u64::from_str_radix(h, 16).unwrap_or(0) } else { raw.parse().unwrap_or(0) };
                        if let Some(pid) = pid {
                            if mask == 0 { masks.remove(&pid); } else { masks.insert(pid, mask); }
                            next_tick = Instant::now();
                        }
                    }
                    Some("sys") => {
                        let s = sys::system_info();
                        let mut o = out.lock();
                        let _ = writeln!(o, "{{\"t\":\"sys\",\"cores\":{},\"totalMem\":{},\"os\":\"{}\"}}", s.cores, s.total_mem, std::env::consts::OS);
                        let _ = o.flush();
                    }
                    Some("quit") => return,
                    _ => {}
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let now = Instant::now();
                let snap = sys::snapshot_tree(&pids);
                let cores = sys::system_info().cores.max(1) as f64;
                let mut items = Vec::new();
                for pid in &pids {
                    match snap.get(pid) {
                        Some(t) => {
                            let cpu = match prev.get(pid) {
                                Some(p) => {
                                    let dt = now.duration_since(p.at).as_secs_f64().max(0.001);
                                    ((t.cpu_secs - p.cpu_secs).max(0.0) / dt / cores * 100.0).min(100.0)
                                }
                                None => 0.0,
                            };
                            prev.insert(*pid, Prev { cpu_secs: t.cpu_secs, at: now });
                            // маска ядер применяется ко всему дереву на каждом замере: процессы, запущенные позже, тоже попадут под неё
                            let mut aff = 0u64;
                            if let Some(&m) = masks.get(pid) {
                                let all = t.pids.iter().map(|p| sys::set_affinity(*p, m)).fold(true, |a, b| a && b);
                                if all { aff = m; }
                            }
                            items.push(format!("{{\"pid\":{},\"cpu\":{},\"rss\":{},\"procs\":{},\"aff\":{}}}", pid, json_escape_free(cpu), t.rss, t.procs, aff));
                        }
                        None => {
                            prev.remove(pid);
                            items.push(format!("{{\"pid\":{},\"gone\":true}}", pid));
                        }
                    }
                }
                {
                    let mut o = out.lock();
                    if writeln!(o, "{{\"t\":\"stats\",\"items\":[{}]}}", items.join(",")).is_err() {
                        return;
                    }
                    let _ = o.flush();
                }
                next_tick = Instant::now() + Duration::from_millis(interval);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn render(pids: &[u32], a: &HashMap<u32, sys::Tree>, b: &HashMap<u32, sys::Tree>, dt: f64) -> String {
    let cores = sys::system_info().cores.max(1) as f64;
    let mut items = Vec::new();
    for pid in pids {
        if let (Some(x), Some(y)) = (a.get(pid), b.get(pid)) {
            let cpu = ((y.cpu_secs - x.cpu_secs).max(0.0) / dt / cores * 100.0).min(100.0);
            items.push(format!("{{\"pid\":{},\"cpu\":{},\"rss\":{},\"procs\":{}}}", pid, json_escape_free(cpu), y.rss, y.procs));
        } else {
            items.push(format!("{{\"pid\":{},\"gone\":true}}", pid));
        }
    }
    format!("{{\"t\":\"stats\",\"items\":[{}]}}", items.join(","))
}
