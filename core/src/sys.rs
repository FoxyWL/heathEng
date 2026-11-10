//! Платформенный слой: Windows (kernel32) и Linux (/proc). Только стандартная библиотека.
use std::collections::HashMap;

#[derive(Clone, Default)]
pub struct Tree {
    pub cpu_secs: f64, // суммарное процессорное время дерева, секунды
    pub rss: u64,      // суммарный рабочий набор, байты
    pub procs: u32,    // число процессов в дереве
    pub pids: Vec<u32>, // PID всех процессов дерева
}

pub struct SysInfo {
    pub cores: u32,
    pub total_mem: u64,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::c_void;

    type Handle = *mut c_void;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const TH32CS_SNAPPROCESS: u32 = 0x2;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    #[repr(C)]
    struct MemoryStatusEx {
        dw_length: u32,
        dw_memory_load: u32,
        ull_total_phys: u64,
        ull_avail_phys: u64,
        ull_total_page_file: u64,
        ull_avail_page_file: u64,
        ull_total_virtual: u64,
        ull_avail_virtual: u64,
        ull_avail_extended_virtual: u64,
    }

    #[repr(C)]
    struct SystemInfoRaw {
        w_processor_architecture: u16,
        w_reserved: u16,
        dw_page_size: u32,
        lp_minimum_application_address: *mut c_void,
        lp_maximum_application_address: *mut c_void,
        dw_active_processor_mask: usize,
        dw_number_of_processors: u32,
        dw_processor_type: u32,
        dw_allocation_granularity: u32,
        w_processor_level: u16,
        w_processor_revision: u16,
    }

    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn CloseHandle(h: Handle) -> i32;
        fn GetProcessTimes(h: Handle, creation: *mut FileTime, exit: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
        fn K32GetProcessMemoryInfo(h: Handle, counters: *mut ProcessMemoryCounters, cb: u32) -> i32;
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
        fn Process32FirstW(h: Handle, e: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(h: Handle, e: *mut ProcessEntry32W) -> i32;
        fn GlobalMemoryStatusEx(s: *mut MemoryStatusEx) -> i32;
        fn GetSystemInfo(s: *mut SystemInfoRaw);
        fn SetProcessAffinityMask(h: Handle, mask: usize) -> i32;
    }

    const PROCESS_SET_INFORMATION: u32 = 0x0200;

    /// Привязывает процесс к ядрам из маски (бит 0 = ядро 0). true, если система приняла маску.
    pub fn set_affinity(pid: u32, mask: u64) -> bool {
        unsafe {
            let h = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return false;
            }
            let ok = SetProcessAffinityMask(h, mask as usize);
            CloseHandle(h);
            ok != 0
        }
    }

    fn ft(f: FileTime) -> f64 {
        (((f.high as u64) << 32) | f.low as u64) as f64 / 10_000_000.0
    }

    // (cpu_secs, rss) одного процесса
    fn one(pid: u32) -> Option<(f64, u64)> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let (mut c, mut e, mut k, mut u) = (FileTime::default(), FileTime::default(), FileTime::default(), FileTime::default());
            let ok = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u);
            let mut m: ProcessMemoryCounters = std::mem::zeroed();
            m.cb = std::mem::size_of::<ProcessMemoryCounters>() as u32;
            let mem_ok = K32GetProcessMemoryInfo(h, &mut m, m.cb);
            CloseHandle(h);
            if ok == 0 {
                return None;
            }
            // процесс уже завершился (GetProcessTimes успешен и для завершённых): отличаем по времени выхода
            if e.low != 0 || e.high != 0 {
                return None;
            }
            Some((ft(k) + ft(u), if mem_ok != 0 { m.working_set_size as u64 } else { 0 }))
        }
    }

    fn parent_map() -> HashMap<u32, Vec<u32>> {
        let mut map: HashMap<u32, Vec<u32>> = HashMap::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap.is_null() || snap as isize == -1 {
                return map;
            }
            let mut e: ProcessEntry32W = std::mem::zeroed();
            e.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut e);
            while ok != 0 {
                map.entry(e.th32_parent_process_id).or_default().push(e.th32_process_id);
                ok = Process32NextW(snap, &mut e);
            }
            CloseHandle(snap);
        }
        map
    }

    pub fn snapshot_tree(pids: &[u32]) -> HashMap<u32, Tree> {
        let children = parent_map();
        let mut out = HashMap::new();
        for &root in pids {
            if one(root).is_none() {
                continue;
            }
            let mut t = Tree::default();
            let mut stack = vec![root];
            let mut seen = std::collections::HashSet::new();
            while let Some(p) = stack.pop() {
                if !seen.insert(p) {
                    continue;
                }
                if let Some((cpu, rss)) = one(p) {
                    t.cpu_secs += cpu;
                    t.rss += rss;
                    t.procs += 1;
                    t.pids.push(p);
                }
                if let Some(ch) = children.get(&p) {
                    stack.extend(ch.iter().copied());
                }
            }
            out.insert(root, t);
        }
        out
    }

    pub fn system_info() -> SysInfo {
        unsafe {
            let mut si: SystemInfoRaw = std::mem::zeroed();
            GetSystemInfo(&mut si);
            let mut ms: MemoryStatusEx = std::mem::zeroed();
            ms.dw_length = std::mem::size_of::<MemoryStatusEx>() as u32;
            let total = if GlobalMemoryStatusEx(&mut ms) != 0 { ms.ull_total_phys } else { 0 };
            SysInfo { cores: si.dw_number_of_processors.max(1), total_mem: total }
        }
    }
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::fs;

    const PAGE: u64 = 4096;
    const TICKS: f64 = 100.0;

    fn stat(pid: u32) -> Option<(u32, f64)> {
        let s = fs::read_to_string(format!("/proc/{}/stat", pid)).ok()?;
        // поле comm в скобках может содержать пробелы: ищем последнюю ')'
        let rest = &s[s.rfind(')')? + 2..];
        let f: Vec<&str> = rest.split_whitespace().collect();
        // f[0]=state, f[1]=ppid, f[11]=utime, f[12]=stime
        if f.len() < 13 || f[0] == "Z" {
            return None;
        }
        let ppid: u32 = f[1].parse().ok()?;
        let cpu = (f[11].parse::<f64>().ok()? + f[12].parse::<f64>().ok()?) / TICKS;
        Some((ppid, cpu))
    }

    fn rss(pid: u32) -> u64 {
        fs::read_to_string(format!("/proc/{}/statm", pid))
            .ok()
            .and_then(|s| s.split_whitespace().nth(1).and_then(|x| x.parse::<u64>().ok()))
            .unwrap_or(0)
            * PAGE
    }

    extern "C" {
        fn sched_setaffinity(pid: i32, size: usize, mask: *const u64) -> i32;
    }

    /// Привязывает процесс (все его потоки) к ядрам из маски. Для задач с несколькими потоками
    /// ядро применяет маску и к каждому потоку из /proc/<pid>/task.
    pub fn set_affinity(pid: u32, mask: u64) -> bool {
        let words = [mask, 0u64, 0u64, 0u64];
        let mut ok = true;
        let mut any = false;
        if let Ok(rd) = fs::read_dir(format!("/proc/{}/task", pid)) {
            for e in rd.flatten() {
                if let Some(tid) = e.file_name().to_str().and_then(|n| n.parse::<i32>().ok()) {
                    any = true;
                    if unsafe { sched_setaffinity(tid, 32, words.as_ptr()) } != 0 {
                        ok = false;
                    }
                }
            }
        }
        any && ok
    }

    pub fn snapshot_tree(pids: &[u32]) -> HashMap<u32, Tree> {
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut cpu: HashMap<u32, f64> = HashMap::new();
        if let Ok(rd) = fs::read_dir("/proc") {
            for e in rd.flatten() {
                if let Some(pid) = e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) {
                    if let Some((ppid, c)) = stat(pid) {
                        children.entry(ppid).or_default().push(pid);
                        cpu.insert(pid, c);
                    }
                }
            }
        }
        let mut out = HashMap::new();
        for &root in pids {
            if !cpu.contains_key(&root) {
                continue;
            }
            let mut t = Tree::default();
            let mut stack = vec![root];
            let mut seen = std::collections::HashSet::new();
            while let Some(p) = stack.pop() {
                if !seen.insert(p) {
                    continue;
                }
                if let Some(c) = cpu.get(&p) {
                    t.cpu_secs += c;
                    t.rss += rss(p);
                    t.procs += 1;
                    t.pids.push(p);
                }
                if let Some(ch) = children.get(&p) {
                    stack.extend(ch.iter().copied());
                }
            }
            out.insert(root, t);
        }
        out
    }

    pub fn system_info() -> SysInfo {
        let cores = fs::read_to_string("/proc/cpuinfo").map(|s| s.lines().filter(|l| l.starts_with("processor")).count() as u32).unwrap_or(1).max(1);
        let total = fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|s| s.lines().find(|l| l.starts_with("MemTotal:")).and_then(|l| l.split_whitespace().nth(1).and_then(|x| x.parse::<u64>().ok())))
            .unwrap_or(0)
            * 1024;
        SysInfo { cores, total_mem: total }
    }
}

pub use imp::{set_affinity, snapshot_tree, system_info};
