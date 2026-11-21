//! Darwin's public LP64 KERN_PROC_PID ABI (sys/{sysctl,proc,time,vm}.h).
//! Explicit declarations keep Linux -> macOS cross-builds SDK-independent.
//! These are named public fields, NOT offsets into opaque provider data. Kernel
//! pointers/locks and all unused fields are layout only and never interpreted.
//! scripts/rex-here-kinfo-abi.c independently checks the SDK layout on both Macs.
const std = @import("std");
const builtin = @import("builtin");
const Timeval = extern struct { tv_sec: i64, tv_usec: i32 };
const Itimerval = extern struct { it_interval: Timeval, it_value: Timeval };
const ExternProc = extern struct {
    p_un: extern union { p_st1: extern struct { p_forw: u64, p_back: u64 }, p_starttime: Timeval },
    p_vmspace: u64,
    p_sigacts: u64,
    p_flag: i32,
    p_stat: u8,
    p_pid: i32,
    p_oppid: i32,
    p_dupfd: i32,
    user_stack: u64,
    exit_thread: u64,
    p_debugger: i32,
    sigwait: i32,
    p_estcpu: u32,
    p_cpticks: i32,
    p_pctcpu: u32,
    p_wchan: u64,
    p_wmesg: u64,
    p_swtime: u32,
    p_slptime: u32,
    p_realtimer: Itimerval,
    p_rtime: Timeval,
    p_uticks: u64,
    p_sticks: u64,
    p_iticks: u64,
    p_traceflag: i32,
    p_tracep: u64,
    p_siglist: i32,
    p_textvp: u64,
    p_holdcnt: i32,
    p_sigmask: u32,
    p_sigignore: u32,
    p_sigcatch: u32,
    p_priority: u8,
    p_usrpri: u8,
    p_nice: i8,
    p_comm: [17]u8, // MAXCOMLEN + 1
    p_pgrp: u64,
    p_addr: u64,
    p_xstat: u16,
    p_acflag: u16,
    p_ru: u64,
};
const Pcred = extern struct {
    pc_lock: [72]u8, // public _pcred declares this exact array; never decoded
    pc_ucred: u64,
    p_ruid: u32,
    p_svuid: u32,
    p_rgid: u32,
    p_svgid: u32,
    p_refcnt: i32,
};
const Ucred = extern struct { cr_ref: i32, cr_uid: u32, cr_ngroups: i16, cr_groups: [16]u32 }; // NGROUPS
const Vmspace = extern struct { dummy: i32, dummy2: u64, dummy3: [5]i32, dummy4: [3]u64 };
const Eproc = extern struct {
    e_paddr: u64,
    e_sess: u64,
    e_pcred: Pcred,
    e_ucred: Ucred,
    e_vm: Vmspace,
    e_ppid: i32,
    e_pgid: i32,
    e_jobc: i16,
    e_tdev: i32,
    e_tpgid: i32,
    e_tsess: u64,
    e_wmesg: [8]u8, // WMESGLEN + 1
    e_xsize: i32,
    e_xrssize: i16,
    e_xccount: i16,
    e_xswrss: i16,
    e_flag: i32,
    e_login: [12]u8, // COMAPT_MAXLOGNAME
    e_spare: [4]i32,
};
pub const KinfoProc = extern struct { kp_proc: ExternProc, kp_eproc: Eproc };
fn size(comptime T: type, comptime n: usize) void {
    if (@sizeOf(T) != n) @compileError("Darwin KERN_PROC_PID ABI size mismatch");
}
fn offset(comptime T: type, comptime field: []const u8, comptime n: usize) void {
    if (@offsetOf(T, field) != n) @compileError("Darwin KERN_PROC_PID ABI offset mismatch: " ++ field);
}
comptime {
    // Constants and security-relevant offsets are also checked against SDK C
    // declarations in the independent ABI test. Fail closed on another ABI.
    size(Timeval, 16);
    offset(Timeval, "tv_usec", 8);
    size(ExternProc, 296);
    offset(ExternProc, "p_un", 0);
    offset(ExternProc, "p_flag", 32);
    offset(ExternProc, "p_stat", 36);
    offset(ExternProc, "p_pid", 40);
    size(Pcred, 104);
    offset(Pcred, "p_ruid", 80);
    offset(Pcred, "p_svuid", 84);
    size(Ucred, 76);
    offset(Ucred, "cr_uid", 4);
    size(Vmspace, 64);
    size(Eproc, 352);
    offset(Eproc, "e_pcred", 16);
    offset(Eproc, "e_ucred", 120);
    offset(Eproc, "e_vm", 200);
    offset(Eproc, "e_ppid", 264);
    offset(Eproc, "e_pgid", 268);
    offset(Eproc, "e_tdev", 276);
    offset(Eproc, "e_tpgid", 280);
    size(KinfoProc, 648);
    offset(KinfoProc, "kp_proc", 0);
    offset(KinfoProc, "kp_eproc", 296);
}
/// No effects, no enumeration, no variable-size or heuristic decoding. A denied
/// or partial read is an error, NEVER evidence that the process has exited.
pub fn read(pid: i32) !?KinfoProc {
    if (builtin.os.tag != .macos or (builtin.cpu.arch != .aarch64 and builtin.cpu.arch != .x86_64)) return error.UnsupportedPlatform;
    if (pid < 1) return error.InvalidProcess;
    const mib = [_]c_int{ 1, 14, 1, pid }; // CTL_KERN, KERN_PROC, KERN_PROC_PID
    var k: KinfoProc = undefined;
    var len: usize = @sizeOf(KinfoProc);
    if (std.c.sysctl(&mib, mib.len, &k, &len, null, 0) != 0) {
        switch (std.c.errno(-1)) {
            .SRCH => return null,
            .PERM, .ACCES => return error.RootProcessReadDenied,
            else => return error.RootProcessReadFailed,
        }
    }
    return validateRead(len, &k, pid);
}

// Inspect only complete successful sysctl results. The pointer may address
// uninitialized storage for zero/short reads; never copy or dereference it
// until the kernel-reported length has been checked.
fn validateRead(len: usize, k: *const KinfoProc, pid: i32) !?KinfoProc {
    if (len == 0) return null; // Successful KERN_PROC_PID with no matching PID.
    if (len != @sizeOf(KinfoProc)) return error.RootProcessAbiMismatch;
    if (k.kp_proc.p_pid != pid) return error.ProcessConflict;
    if (k.kp_proc.p_stat == 5) return null; // SZOMB
    if (k.kp_proc.p_stat < 1 or k.kp_proc.p_stat > 4) return error.InvalidProcess;
    const birth = k.kp_proc.p_un.p_starttime;
    if (birth.tv_sec <= 0 or birth.tv_usec < 0 or birth.tv_usec >= 1000000) return error.InvalidProcess;
    return k.*;
}

fn testProcess() KinfoProc {
    var k = std.mem.zeroes(KinfoProc);
    k.kp_proc.p_pid = 42;
    k.kp_proc.p_stat = 2; // SRUN
    k.kp_proc.p_un.p_starttime = .{ .tv_sec = 123456789, .tv_usec = 123456 };
    k.kp_eproc.e_ppid = 7;
    k.kp_eproc.e_ucred.cr_uid = 501;
    return k;
}

test "successful Darwin sysctl preserves the validated process identity" {
    var k = testProcess();
    for (1..5) |status| {
        k.kp_proc.p_stat = @intCast(status);
        const result = (try validateRead(@sizeOf(KinfoProc), &k, 42)).?;
        try std.testing.expectEqual(k.kp_proc.p_pid, result.kp_proc.p_pid);
        try std.testing.expectEqual(k.kp_proc.p_stat, result.kp_proc.p_stat);
        try std.testing.expectEqualDeep(k.kp_proc.p_un.p_starttime, result.kp_proc.p_un.p_starttime);
        try std.testing.expectEqualDeep(k.kp_eproc, result.kp_eproc);
    }
}

test "successful Darwin sysctl with no PID never reads uninitialized storage" {
    const k: KinfoProc = undefined;
    try std.testing.expect((try validateRead(0, &k, 42)) == null);
}

test "short and oversized Darwin sysctl results fail closed before decoding" {
    const k: KinfoProc = undefined;
    for ([_]usize{ 1, @sizeOf(KinfoProc) - 1, @sizeOf(KinfoProc) + 1, std.math.maxInt(usize) }) |len| {
        try std.testing.expectError(error.RootProcessAbiMismatch, validateRead(len, &k, 42));
    }
}

test "Darwin sysctl cannot substitute another PID even when zombie" {
    var k = testProcess();
    try std.testing.expectError(error.ProcessConflict, validateRead(@sizeOf(KinfoProc), &k, 43));
    k.kp_proc.p_stat = 5;
    try std.testing.expectError(error.ProcessConflict, validateRead(@sizeOf(KinfoProc), &k, 43));
}

test "Darwin sysctl rejects invalid process status rather than reporting absence" {
    var k = testProcess();
    for ([_]u8{ 0, 6, 255 }) |status| {
        k.kp_proc.p_stat = status;
        try std.testing.expectError(error.InvalidProcess, validateRead(@sizeOf(KinfoProc), &k, 42));
    }
}

test "Darwin sysctl zombie is absent without requiring a live birth identity" {
    var k = testProcess();
    k.kp_proc.p_stat = 5;
    k.kp_proc.p_un.p_starttime = .{ .tv_sec = 0, .tv_usec = -1 };
    try std.testing.expect((try validateRead(@sizeOf(KinfoProc), &k, 42)) == null);
}

test "Darwin sysctl rejects zero and negative birth seconds" {
    var k = testProcess();
    for ([_]i64{ 0, -1, std.math.minInt(i64) }) |sec| {
        k.kp_proc.p_un.p_starttime.tv_sec = sec;
        try std.testing.expectError(error.InvalidProcess, validateRead(@sizeOf(KinfoProc), &k, 42));
    }
    k.kp_proc.p_un.p_starttime.tv_sec = 1;
    try std.testing.expect((try validateRead(@sizeOf(KinfoProc), &k, 42)) != null);
}

test "Darwin sysctl birth microseconds are in the closed interval zero to 999999" {
    var k = testProcess();
    for ([_]i32{ -1, std.math.minInt(i32), 1000000, std.math.maxInt(i32) }) |usec| {
        k.kp_proc.p_un.p_starttime.tv_usec = usec;
        try std.testing.expectError(error.InvalidProcess, validateRead(@sizeOf(KinfoProc), &k, 42));
    }
    for ([_]i32{ 0, 999999 }) |usec| {
        k.kp_proc.p_un.p_starttime.tv_usec = usec;
        try std.testing.expect((try validateRead(@sizeOf(KinfoProc), &k, 42)) != null);
    }
}
