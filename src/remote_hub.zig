//! Native remote-link supervision. Each approved host owns independent bounded
//! data/control pipes; these are transport slots, not Pi tasks or a scheduler.
const std = @import("std");
const Native = @import("native.zig");
const wire = @import("generated/contracts.zig");
const Link = @import("remote_link.zig").Link;
const tcp = @import("remote_io.zig");
const a = tcp.a;
const Route = std.meta.Elem(@FieldType(wire.RemoteRuntimeRoutes, "hosts"));
pub const Hub = struct {
    native: Native,
    registry: std.json.Parsed(wire.RemoteRegistry),
    links: std.ArrayList(*Link) = .empty,
    threads: std.ArrayList(std.Thread) = .empty,
    inherit: std.ArrayList(std.Io.File) = .empty,
    routes: std.ArrayList(Route) = .empty,
    fn bind(native: Native, address: std.Io.net.IpAddress) !std.Io.net.Server {
        return address.listen(native.io, .{ .reuse_address = true });
    }
    pub fn init(native: Native, path: []const u8, executable: []const u8, local_machine: []const u8) !Hub {
        try @import("tailscale.zig").validateExecutable(native, executable);
        return initUsing(native, path, executable, local_machine, bind);
    }
    // Test injection of loopback listeners; production always uses the validated
    // literal registry address. There is no CLI/environment bypass.
    pub fn initUsing(native: Native, path: []const u8, executable: []const u8, local_machine: []const u8, listener_factory: *const fn (Native, std.Io.net.IpAddress) anyerror!std.Io.net.Server) !Hub {
        tcp.ignorePipe();
        var self: Hub = .{ .native = native, .registry = try @import("remote_check.zig").load(native, a, path) };
        errdefer self.deinit();
        // Preflight the entire registry before binding any listener.
        var count: usize = 0;
        for (self.registry.value.hosts, 0..) |host, index| {
            if (host.implementation == null) {
                if (host.listen != null) return error.InvalidWorkerListener;
                continue;
            }
            if (std.mem.eql(u8, host.machineId, local_machine) or !std.mem.eql(wire.WorkerCapability, host.capabilities.?, @import("remote_worker.zig").capabilitiesWithMcp(host.rexClient, std.mem.indexOfScalar(wire.WorkerCapability, host.capabilities.?, .mcp) != null))) return error.InvalidWorkerRegistration;
            const address = try @import("tailscale.zig").endpoint(host.listen orelse return error.MissingWorkerListener);
            for (self.registry.value.hosts[0..index]) |prior| if (prior.listen) |listen| {
                if (std.meta.eql(address, try @import("tailscale.zig").endpoint(listen))) return error.DuplicateWorkerListener;
            };
            count += 1;
            if (count > 8) return error.WorkerCapacity;
        }
        try self.links.ensureTotalCapacity(a, count);
        try self.inherit.ensureTotalCapacity(a, count * 5);
        try self.routes.ensureTotalCapacity(a, count);
        try self.threads.ensureTotalCapacity(a, count);
        for (self.registry.value.hosts, 0..) |host, index| {
            if (host.implementation == null) continue;
            const address = try @import("tailscale.zig").endpoint(host.listen.?);
            var listener = try listener_factory(native, address);
            errdefer listener.deinit(native.io);
            _ = try Native.fcntl(listener.socket.handle, std.posix.F.SETFD, std.posix.FD_CLOEXEC);
            const requests = try Native.pipe();
            errdefer for (requests) |fd| Native.close(fd);
            const results = try Native.pipe();
            errdefer for (results) |fd| Native.close(fd);
            const controls = try Native.pipe();
            errdefer for (controls) |fd| Native.close(fd);
            const client_requests = if (host.rexClient != null) try Native.pipe() else null;
            errdefer if (client_requests) |fds| for (fds) |fd| Native.close(fd);
            const client_replies = if (host.rexClient != null) try Native.pipe() else null;
            errdefer if (client_replies) |fds| for (fds) |fd| Native.close(fd);
            const link = try a.create(Link);
            link.* = .{ .native = native, .registry = self.registry.value, .index = index, .tailscale = executable, .listener = listener, .input = requests[0], .output = results[1], .control = controls[0], .clients = if (client_requests) |r| .{ .input = client_replies.?[0], .output = r[1] } else null };
            self.links.appendAssumeCapacity(link);
            self.routes.appendAssumeCapacity(.{ .machineId = host.machineId, .mcp = if (std.mem.indexOfScalar(wire.WorkerCapability, host.capabilities.?, .mcp) != null) true else null, .readFd = results[0], .writeFd = requests[1], .controlFd = controls[1], .rexClient = host.rexClient, .clientReadFd = if (client_requests) |r| r[0] else null, .clientWriteFd = if (client_replies) |r| r[1] else null });
            if (client_requests) |r| for ([_]tcp.fd_t{ r[0], client_replies.?[1] }) |fd| self.inherit.appendAssumeCapacity(.{ .handle = fd, .flags = .{ .nonblocking = false } });
            for ([_]tcp.fd_t{ results[0], requests[1], controls[1] }) |fd| self.inherit.appendAssumeCapacity(.{ .handle = fd, .flags = .{ .nonblocking = false } });
        }
        return self;
    }
    pub fn json(self: *Hub) ![]u8 {
        return std.json.Stringify.valueAlloc(a, wire.RemoteRuntimeRoutes{ .hubId = self.registry.value.hubId, .hosts = self.routes.items }, .{});
    }
    pub fn closeChildEnds(self: *Hub) void {
        for (self.inherit.items) |file| file.close(self.native.io);
        self.inherit.clearRetainingCapacity();
    }
    pub fn start(self: *Hub) !void {
        for (self.links.items) |link| self.threads.appendAssumeCapacity(try std.Thread.spawn(.{}, Link.serve, .{link}));
    }
    pub fn deinit(self: *Hub) void {
        self.closeChildEnds();
        for (self.links.items, 0..) |link, index| {
            if (index < self.threads.items.len) self.threads.items[index].join() else {
                link.listener.deinit(self.native.io);
                Native.close(link.input);
                Native.close(link.output);
                Native.close(link.control);
                if (link.clients) |p| {
                    Native.close(p.input);
                    Native.close(p.output);
                }
            }
            a.destroy(link);
        }
        self.threads.deinit(a);
        self.links.deinit(a);
        self.inherit.deinit(a);
        self.routes.deinit(a);
        self.registry.deinit();
    }
};
