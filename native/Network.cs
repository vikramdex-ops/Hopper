// Network browsing for the sidebar's Network node: which computers are out there, what a
// computer shares, and signing in to one. Everything has its own time budget so an offline
// server answers "offline" in seconds instead of holding a request for the SMB timeout.
// Results are plain data; deciding what to show (and the wording) is the TypeScript side's job.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace Hopper
{
    static class Network
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        public static string Dispatch(string cmd, Dictionary<string, object> a)
        {
            switch (cmd)
            {
                // -> { sources: [{ id, ms, items: [{ name, address? }], error? }] }
                // "sources" picks some of: browse, serverEnum, wsd, connected (default all)
                case "netComputers": return Json.Serialize(Computers(StrList(a, "sources"), Int(a, "wsdMs", 2500), Int(a, "budgetMs", 8000)));
                // -> { server, shares: [{ name, type, remark }], connected, remembered } | { server, error: { stage, code } }
                case "netShares": return Json.Serialize(Shares(Str(a, "server"), Int(a, "timeoutMs", 15000)));
                // -> { ok: true } | { error: { stage, code } }. The password arrives here over stdin and is used once.
                case "netConnect": return Json.Serialize(Connect(Str(a, "remote"), Str(a, "user"), Str(a, "password"), Bool(a, "remember"), Int(a, "timeoutMs", 30000)));
                // -> { closed, failed: [{ remote, code }], forgot }
                case "netDisconnect": return Json.Serialize(Disconnect(Str(a, "server"), Bool(a, "forget")));
                // -> [{ local, remote, status }]
                case "netConnections": return Json.Serialize(Connections());
                default: throw new Exception("unknown command " + cmd);
            }
        }

        static string Str(Dictionary<string, object> a, string k) { return a.ContainsKey(k) && a[k] != null ? Convert.ToString(a[k]) : ""; }
        static bool Bool(Dictionary<string, object> a, string k) { return a.ContainsKey(k) && a[k] is bool && (bool)a[k]; }
        static int Int(Dictionary<string, object> a, string k, int def) { return a.ContainsKey(k) && a[k] != null ? Convert.ToInt32(a[k]) : def; }
        static List<string> StrList(Dictionary<string, object> a, string k)
        {
            var list = new List<string>();
            if (a.ContainsKey(k) && a[k] is IEnumerable && !(a[k] is string)) foreach (var o in (IEnumerable)a[k]) list.Add(Convert.ToString(o));
            return list;
        }

        /// <summary>"\\NAS01\x", "NAS01", "\\NAS01" -> "NAS01".</summary>
        static string Host(string s)
        {
            s = (s ?? "").Trim().TrimStart('\\', '/');
            int i = s.IndexOfAny(new[] { '\\', '/' });
            return i < 0 ? s : s.Substring(0, i);
        }

        /// <summary>Runs f on its own thread; returns false if it did not finish in time (the thread is abandoned).</summary>
        internal static bool Within<T>(int ms, Func<T> f, out T result)
        {
            T r = default(T);
            Exception err = null;
            var t = new Thread(delegate () { try { r = f(); } catch (Exception e) { err = e; } });
            t.IsBackground = true;
            t.Start();
            if (!t.Join(Math.Max(1, ms))) { result = default(T); return false; }
            if (err != null) throw err;
            result = r;
            return true;
        }

        static Dictionary<string, object> Err(string stage, int code)
        {
            var e = new Dictionary<string, object>();
            e["stage"] = stage; e["code"] = code;
            var d = new Dictionary<string, object>();
            d["error"] = e;
            return d;
        }

        // -------------------------------------------------------------------
        // mpr.dll / netapi32.dll

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        class NETRESOURCE
        {
            public int dwScope;
            public int dwType;
            public int dwDisplayType;
            public int dwUsage;
            public string lpLocalName;
            public string lpRemoteName;
            public string lpComment;
            public string lpProvider;
        }

        [DllImport("mpr.dll", CharSet = CharSet.Unicode)]
        static extern int WNetOpenEnumW(int scope, int type, int usage, NETRESOURCE nr, out IntPtr handle);
        [DllImport("mpr.dll", CharSet = CharSet.Unicode)]
        static extern int WNetEnumResourceW(IntPtr handle, ref int count, IntPtr buffer, ref int size);
        [DllImport("mpr.dll")]
        static extern int WNetCloseEnum(IntPtr handle);
        [DllImport("mpr.dll", CharSet = CharSet.Unicode)]
        static extern int WNetAddConnection2W(NETRESOURCE nr, string password, string user, int flags);
        [DllImport("mpr.dll", CharSet = CharSet.Unicode)]
        static extern int WNetCancelConnection2W(string name, int flags, bool force);

        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        static extern int NetServerEnum(string server, int level, out IntPtr buf, int prefMax, out int read, out int total, uint type, string domain, IntPtr resume);
        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        static extern int NetShareEnum(string server, int level, out IntPtr buf, int prefMax, out int read, out int total, ref int resume);
        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        static extern int NetUseEnum(string server, int level, out IntPtr buf, int prefMax, out int read, out int total, ref int resume);
        [DllImport("netapi32.dll")]
        static extern int NetApiBufferFree(IntPtr buf);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct SERVER_INFO_100 { public int platform_id; public string name; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct SHARE_INFO_1 { public string netname; public uint type; public string remark; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct USE_INFO_1 { public string local; public string remote; public IntPtr password; public int status; public int asg_type; public int refcount; public int usecount; }

        const int RESOURCE_CONNECTED = 1, RESOURCE_GLOBALNET = 2, RESOURCE_REMEMBERED = 3;
        const int RESOURCETYPE_ANY = 0, RESOURCETYPE_DISK = 1;
        const int RESOURCEUSAGE_CONTAINER = 2;
        const int RESOURCEDISPLAYTYPE_SERVER = 2;
        const int CONNECT_TEMPORARY = 4;

        // -------------------------------------------------------------------
        // Computers

        static Dictionary<string, object> Computers(List<string> only, int wsdMs, int budgetMs)
        {
            // Every source runs at once; each is cut off at the budget so one slow source can't hold the rest.
            var jobs = new List<KeyValuePair<string, Func<List<Dictionary<string, object>>>>>();
            jobs.Add(new KeyValuePair<string, Func<List<Dictionary<string, object>>>>("browse", BrowseWNet));
            jobs.Add(new KeyValuePair<string, Func<List<Dictionary<string, object>>>>("serverEnum", ServerEnum));
            jobs.Add(new KeyValuePair<string, Func<List<Dictionary<string, object>>>>("wsd", delegate { return Wsd.Discover(wsdMs, Math.Max(500, budgetMs - wsdMs - 200)); }));
            jobs.Add(new KeyValuePair<string, Func<List<Dictionary<string, object>>>>("connected", ConnectedServers));
            if (only.Count > 0) jobs.RemoveAll(delegate (KeyValuePair<string, Func<List<Dictionary<string, object>>>> j) { return !only.Contains(j.Key); });

            var results = new Dictionary<string, object>[jobs.Count];
            var threads = new List<Thread>();
            var sw = Stopwatch.StartNew();
            for (int i = 0; i < jobs.Count; i++)
            {
                int k = i;
                var t = new Thread(delegate ()
                {
                    var d = new Dictionary<string, object>();
                    d["id"] = jobs[k].Key;
                    var t0 = Stopwatch.StartNew();
                    try { d["items"] = jobs[k].Value(); }
                    catch (NetException e) { d["items"] = new List<object>(); d["error"] = e.Code; }
                    catch (Exception e) { d["items"] = new List<object>(); d["error"] = -1; d["message"] = e.Message; }
                    d["ms"] = (int)t0.ElapsedMilliseconds;
                    results[k] = d;
                });
                t.IsBackground = true;
                t.Start();
                threads.Add(t);
            }
            foreach (var t in threads) t.Join(Math.Max(1, budgetMs - (int)sw.ElapsedMilliseconds));
            var list = new List<object>();
            for (int i = 0; i < jobs.Count; i++)
            {
                var d = results[i];
                if (d == null)
                {
                    d = new Dictionary<string, object>();
                    d["id"] = jobs[i].Key; d["items"] = new List<object>(); d["error"] = 1460; d["ms"] = budgetMs; // ERROR_TIMEOUT
                }
                list.Add(d);
            }
            var r = new Dictionary<string, object>();
            r["sources"] = list;
            r["ms"] = (int)sw.ElapsedMilliseconds;
            return r;
        }

        class NetException : Exception
        {
            public readonly int Code;
            public NetException(int code) : base("Windows error " + code) { Code = code; }
        }

        static Dictionary<string, object> Item(string name, string address)
        {
            var d = new Dictionary<string, object>();
            d["name"] = name;
            if (!string.IsNullOrEmpty(address)) d["address"] = address;
            return d;
        }

        /// <summary>The "Microsoft Windows Network" browse list (needs the Computer Browser service, i.e. SMB1, somewhere on the LAN).</summary>
        static List<Dictionary<string, object>> BrowseWNet()
        {
            var found = new List<Dictionary<string, object>>();
            int firstError = 0;
            Walk(null, 0, found, ref firstError);
            if (found.Count == 0 && firstError != 0) throw new NetException(firstError);
            return found;
        }

        static void Walk(NETRESOURCE parent, int depth, List<Dictionary<string, object>> found, ref int firstError)
        {
            if (depth > 3) return;
            IntPtr h;
            int rc = WNetOpenEnumW(RESOURCE_GLOBALNET, RESOURCETYPE_ANY, 0, parent, out h);
            if (rc != 0) { if (firstError == 0) firstError = rc; return; }
            var buf = Marshal.AllocHGlobal(64 * 1024);
            try
            {
                while (true)
                {
                    int count = -1, size = 64 * 1024;
                    rc = WNetEnumResourceW(h, ref count, buf, ref size);
                    if (rc == 259) break; // ERROR_NO_MORE_ITEMS
                    if (rc != 0) { if (firstError == 0) firstError = rc; break; }
                    int sz = Marshal.SizeOf(typeof(NETRESOURCE));
                    for (int i = 0; i < count; i++)
                    {
                        var nr = new NETRESOURCE();
                        Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + (long)i * sz), nr);
                        if (nr.dwDisplayType == RESOURCEDISPLAYTYPE_SERVER && !string.IsNullOrEmpty(nr.lpRemoteName))
                            found.Add(Item(Host(nr.lpRemoteName), null));
                        else if ((nr.dwUsage & RESOURCEUSAGE_CONTAINER) != 0)
                            Walk(nr, depth + 1, found, ref firstError);
                    }
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buf);
                WNetCloseEnum(h);
            }
        }

        /// <summary>NetServerEnum: the same browse list through the Workstation service.</summary>
        static List<Dictionary<string, object>> ServerEnum()
        {
            var list = new List<Dictionary<string, object>>();
            IntPtr buf; int read, total;
            int rc = NetServerEnum(null, 100, out buf, -1, out read, out total, 0xFFFFFFFF, null, IntPtr.Zero);
            if (rc != 0 && rc != 234) { if (buf != IntPtr.Zero) NetApiBufferFree(buf); throw new NetException(rc); }
            try
            {
                int size = Marshal.SizeOf(typeof(SERVER_INFO_100));
                for (int i = 0; i < read; i++)
                {
                    var si = (SERVER_INFO_100)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + (long)i * size), typeof(SERVER_INFO_100));
                    if (!string.IsNullOrEmpty(si.name)) list.Add(Item(si.name, null));
                }
            }
            finally { NetApiBufferFree(buf); }
            return list;
        }

        /// <summary>Servers this PC is already connected to (mapped drives, open sessions) or remembers a mapped drive for.</summary>
        static List<Dictionary<string, object>> ConnectedServers()
        {
            var list = new List<Dictionary<string, object>>();
            foreach (var u in Uses()) list.Add(Item(Host(u.remote), null));
            IntPtr h;
            if (WNetOpenEnumW(RESOURCE_REMEMBERED, RESOURCETYPE_DISK, 0, null, out h) == 0)
            {
                var buf = Marshal.AllocHGlobal(32 * 1024);
                try
                {
                    while (true)
                    {
                        int count = -1, size = 32 * 1024;
                        if (WNetEnumResourceW(h, ref count, buf, ref size) != 0) break;
                        int sz = Marshal.SizeOf(typeof(NETRESOURCE));
                        for (int i = 0; i < count; i++)
                        {
                            var nr = new NETRESOURCE();
                            Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + (long)i * sz), nr);
                            if (!string.IsNullOrEmpty(nr.lpRemoteName) && nr.lpRemoteName.StartsWith("\\\\")) list.Add(Item(Host(nr.lpRemoteName), null));
                        }
                    }
                }
                finally { Marshal.FreeHGlobal(buf); WNetCloseEnum(h); }
            }
            return list;
        }

        struct Use { public string local; public string remote; public int status; }

        static List<Use> Uses()
        {
            var list = new List<Use>();
            IntPtr buf; int read, total, resume = 0;
            int rc = NetUseEnum(null, 1, out buf, -1, out read, out total, ref resume);
            if (rc != 0 && rc != 234) { if (buf != IntPtr.Zero) NetApiBufferFree(buf); return list; }
            try
            {
                int size = Marshal.SizeOf(typeof(USE_INFO_1));
                for (int i = 0; i < read; i++)
                {
                    var u = (USE_INFO_1)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + (long)i * size), typeof(USE_INFO_1));
                    if (string.IsNullOrEmpty(u.remote) || !u.remote.StartsWith("\\\\")) continue;
                    list.Add(new Use { local = u.local ?? "", remote = u.remote, status = u.status });
                }
            }
            finally { NetApiBufferFree(buf); }
            return list;
        }

        static List<Dictionary<string, object>> Connections()
        {
            var list = new List<Dictionary<string, object>>();
            foreach (var u in Uses())
            {
                var d = new Dictionary<string, object>();
                d["local"] = u.local; d["remote"] = u.remote; d["status"] = u.status;
                list.Add(d);
            }
            return list;
        }

        // -------------------------------------------------------------------
        // Shares of one server

        /// <summary>Resolve the name and reach the SMB port quickly, so "offline" never waits for the SMB timeout.</summary>
        static Dictionary<string, object> Reach(string host, int ms)
        {
            var sw = Stopwatch.StartNew();
            IPAddress[] addrs;
            IPAddress literal;
            if (IPAddress.TryParse(host, out literal)) addrs = new[] { literal };
            else
            {
                bool done;
                try { done = Within(Math.Min(ms, 5000), delegate { return Dns.GetHostAddresses(host); }, out addrs); }
                catch { return Err("resolve", 53); } // ERROR_BAD_NETPATH
                if (!done) return Err("resolve", 1460);
                if (addrs == null || addrs.Length == 0) return Err("resolve", 53);
            }
            // IPv4 first; try 445 then 139 (old NAS boxes) on each address, in parallel.
            var order = new List<IPAddress>();
            foreach (var a in addrs) if (a.AddressFamily == AddressFamily.InterNetwork) order.Add(a);
            foreach (var a in addrs) if (a.AddressFamily == AddressFamily.InterNetworkV6) order.Add(a);
            if (order.Count == 0) return Err("resolve", 53);
            int left = Math.Max(500, Math.Min(4000, ms - (int)sw.ElapsedMilliseconds));
            var sockets = new List<Socket>();
            var waits = new List<IAsyncResult>();
            foreach (var a in order)
            {
                foreach (int port in new[] { 445, 139 })
                {
                    try
                    {
                        var s = new Socket(a.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
                        sockets.Add(s);
                        waits.Add(s.BeginConnect(new IPEndPoint(a, port), null, null));
                    }
                    catch { }
                }
            }
            bool reached = false;
            var until = DateTime.UtcNow.AddMilliseconds(left);
            while (!reached && DateTime.UtcNow < until)
            {
                bool pending = false;
                for (int i = 0; i < waits.Count; i++)
                {
                    if (!waits[i].IsCompleted) { pending = true; continue; }
                    try { if (sockets[i].Connected) reached = true; } catch { }
                }
                if (!pending) break;
                Thread.Sleep(25);
            }
            foreach (var s in sockets) { try { s.Close(); } catch { } }
            return reached ? null : Err("connect", 1231); // ERROR_NETWORK_UNREACHABLE: nothing answered on 445/139
        }

        static Dictionary<string, object> Shares(string server, int timeoutMs)
        {
            string host = Host(server);
            if (host.Length == 0) return Err("input", 123); // ERROR_INVALID_NAME
            var sw = Stopwatch.StartNew();
            var reach = Reach(host, timeoutMs);
            if (reach != null) { reach["server"] = host; reach["ms"] = (int)sw.ElapsedMilliseconds; return reach; }

            int rc = 0, ignored;
            var shares = new List<Dictionary<string, object>>();
            bool done = Within(Math.Max(1000, timeoutMs - (int)sw.ElapsedMilliseconds), delegate
            {
                IntPtr buf; int read, total, resume = 0;
                rc = NetShareEnum("\\\\" + host, 1, out buf, -1, out read, out total, ref resume);
                if (rc != 0 && rc != 234) { if (buf != IntPtr.Zero) NetApiBufferFree(buf); return 0; }
                try
                {
                    int size = Marshal.SizeOf(typeof(SHARE_INFO_1));
                    for (int i = 0; i < read; i++)
                    {
                        var si = (SHARE_INFO_1)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + (long)i * size), typeof(SHARE_INFO_1));
                        var d = new Dictionary<string, object>();
                        d["name"] = si.netname ?? ""; d["type"] = (long)si.type; d["remark"] = si.remark ?? "";
                        shares.Add(d);
                    }
                }
                finally { NetApiBufferFree(buf); }
                rc = 0;
                return 0;
            }, out ignored);
            Dictionary<string, object> r;
            if (!done) r = Err("enum", 1460);
            else if (rc != 0) r = Err("enum", rc);
            else { r = new Dictionary<string, object>(); r["shares"] = shares; }
            r["server"] = host;
            r["ms"] = (int)sw.ElapsedMilliseconds;
            bool connected = false;
            foreach (var u in Uses()) if (string.Equals(Host(u.remote), host, StringComparison.OrdinalIgnoreCase)) connected = true;
            r["connected"] = connected;
            r["remembered"] = Creds.User(host);
            return r;
        }

        // -------------------------------------------------------------------
        // Sign in / out

        static Dictionary<string, object> Connect(string remote, string user, string password, bool remember, int timeoutMs)
        {
            string host = Host(remote);
            if (host.Length == 0) return Err("input", 123);
            // A share, or the server itself (its IPC$ share), which is what listing its shares needs.
            string target = remote.Trim().Replace('/', '\\').TrimEnd('\\');
            if (!target.StartsWith("\\\\")) target = "\\\\" + target.TrimStart('\\');
            if (target.Substring(2).IndexOf('\\') < 0) target += "\\IPC$";
            var reach = Reach(host, Math.Min(timeoutMs, 8000));
            if (reach != null) return reach;
            var nr = new NETRESOURCE { dwType = RESOURCETYPE_ANY, lpRemoteName = target };
            string u = string.IsNullOrEmpty(user) ? null : user;
            // With no user name Windows uses the current sign-in; a password without a user is meaningless.
            string p = u == null ? null : (password ?? "");
            int rc;
            bool done = Within(timeoutMs, delegate { return WNetAddConnection2W(nr, p, u, CONNECT_TEMPORARY); }, out rc);
            if (!done) return Err("connect", 1460);
            if (rc != 0) return Err("signin", rc);
            var r = new Dictionary<string, object>();
            r["ok"] = true;
            r["remote"] = target;
            if (remember && u != null) r["remembered"] = Creds.Save(host, u, p);
            return r;
        }

        static Dictionary<string, object> Disconnect(string server, bool forget)
        {
            string host = Host(server);
            var failed = new List<object>();
            int closed = 0;
            foreach (var use in Uses())
            {
                // Only Hopper-style connections without a drive letter; mapped drives are the user's own business.
                if (!string.Equals(Host(use.remote), host, StringComparison.OrdinalIgnoreCase) || use.local.Length > 0) continue;
                int rc = WNetCancelConnection2W(use.remote, 0, false);
                if (rc == 0) closed++;
                else
                {
                    var f = new Dictionary<string, object>();
                    f["remote"] = use.remote; f["code"] = rc;
                    failed.Add(f);
                }
            }
            var r = new Dictionary<string, object>();
            r["closed"] = closed;
            r["failed"] = failed;
            r["forgot"] = forget && host.Length > 0 && Creds.Delete(host);
            return r;
        }
    }

    // -----------------------------------------------------------------------
    // Windows Credential Manager: "remember on this PC" for a server. Hopper never stores the password itself;
    // Windows uses this entry for later connections to that server, like `cmdkey /add`.

    static class Creds
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct CREDENTIAL
        {
            public int Flags;
            public int Type;
            public string TargetName;
            public string Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public int CredentialBlobSize;
            public IntPtr CredentialBlob;
            public int Persist;
            public int AttributeCount;
            public IntPtr Attributes;
            public string TargetAlias;
            public string UserName;
        }

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CredDeleteW(string target, int type, int flags);
        [DllImport("advapi32.dll")]
        static extern void CredFree(IntPtr cred);

        const int CRED_TYPE_DOMAIN_PASSWORD = 2;
        const int CRED_PERSIST_LOCAL_MACHINE = 2;

        public static bool Save(string target, string user, string password)
        {
            byte[] blob = Encoding.Unicode.GetBytes(password ?? "");
            IntPtr mem = Marshal.AllocHGlobal(Math.Max(1, blob.Length));
            try
            {
                Marshal.Copy(blob, 0, mem, blob.Length);
                var c = new CREDENTIAL
                {
                    Type = CRED_TYPE_DOMAIN_PASSWORD,
                    TargetName = target,
                    UserName = user,
                    CredentialBlob = mem,
                    CredentialBlobSize = blob.Length,
                    Persist = CRED_PERSIST_LOCAL_MACHINE,
                    Comment = "Saved by Hopper"
                };
                return CredWriteW(ref c, 0);
            }
            finally
            {
                // wipe our copies of the password
                for (int i = 0; i < blob.Length; i++) { blob[i] = 0; Marshal.WriteByte(mem, i, 0); }
                Marshal.FreeHGlobal(mem);
            }
        }

        /// <summary>The user name Windows has saved for this server, or null. Never the password.</summary>
        public static string User(string target)
        {
            IntPtr p;
            if (!CredReadW(target, CRED_TYPE_DOMAIN_PASSWORD, 0, out p)) return null;
            try
            {
                var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
                return c.UserName;
            }
            finally { CredFree(p); }
        }

        public static bool Delete(string target)
        {
            return CredDeleteW(target, CRED_TYPE_DOMAIN_PASSWORD, 0);
        }
    }

    // -----------------------------------------------------------------------
    // WS-Discovery: how Windows 10/11 PCs (Function Discovery Resource Publication) and most NAS
    // boxes (wsdd) announce themselves now that the SMB1 browse list is gone.

    static class Wsd
    {
        const string NsAddr = "http://schemas.xmlsoap.org/ws/2004/08/addressing";
        const string NsDisc = "http://schemas.xmlsoap.org/ws/2005/04/discovery";

        static string Probe(string id)
        {
            return "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
                "<soap:Envelope xmlns:soap=\"http://www.w3.org/2003/05/soap-envelope\" xmlns:wsa=\"" + NsAddr + "\" xmlns:wsd=\"" + NsDisc + "\" " +
                "xmlns:wsdp=\"http://schemas.xmlsoap.org/ws/2006/02/devprof\" xmlns:pub=\"http://schemas.microsoft.com/windows/pub/2005/07\">" +
                "<soap:Header><wsa:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To>" +
                "<wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action>" +
                "<wsa:MessageID>urn:uuid:" + id + "</wsa:MessageID></soap:Header>" +
                "<soap:Body><wsd:Probe><wsd:Types>pub:Computer</wsd:Types></wsd:Probe></soap:Body></soap:Envelope>";
        }

        static string Get(string to, string id)
        {
            return "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
                "<soap:Envelope xmlns:soap=\"http://www.w3.org/2003/05/soap-envelope\" xmlns:wsa=\"" + NsAddr + "\">" +
                "<soap:Header><wsa:To>" + System.Security.SecurityElement.Escape(to) + "</wsa:To>" +
                "<wsa:Action>http://schemas.xmlsoap.org/ws/2004/09/transfer/Get</wsa:Action>" +
                "<wsa:MessageID>urn:uuid:" + id + "</wsa:MessageID>" +
                "<wsa:ReplyTo><wsa:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:Address></wsa:ReplyTo>" +
                "</soap:Header><soap:Body/></soap:Envelope>";
        }

        class Match { public string Epr; public string XAddr; public string Address; }

        public static List<Dictionary<string, object>> Discover(int listenMs, int metaMs)
        {
            var matches = new Dictionary<string, Match>(StringComparer.OrdinalIgnoreCase);
            var sockets = new List<UdpClient>();
            string id = Guid.NewGuid().ToString();
            byte[] probe = Encoding.UTF8.GetBytes(Probe(id));
            var group = new IPEndPoint(IPAddress.Parse("239.255.255.250"), 3702);
            // one socket per IPv4 interface address, so the probe goes out on every LAN the PC is on
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != OperationalStatus.Up || nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                if (!nic.SupportsMulticast) continue;
                foreach (var ua in nic.GetIPProperties().UnicastAddresses)
                {
                    if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                    try
                    {
                        var u = new UdpClient(new IPEndPoint(ua.Address, 0));
                        u.Client.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastInterface, ua.Address.GetAddressBytes());
                        u.Client.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastTimeToLive, 1);
                        sockets.Add(u);
                    }
                    catch { }
                }
            }
            if (sockets.Count == 0) throw new Exception("no network interface is up");
            try
            {
                // WS-Discovery repeats UDP messages; two sends a short while apart is what Windows does.
                foreach (var u in sockets) { try { u.Send(probe, probe.Length, group); } catch { } }
                var until = DateTime.UtcNow.AddMilliseconds(listenMs);
                bool resent = false;
                while (DateTime.UtcNow < until)
                {
                    if (!resent && DateTime.UtcNow > until.AddMilliseconds(-listenMs / 2))
                    {
                        resent = true;
                        foreach (var u in sockets) { try { u.Send(probe, probe.Length, group); } catch { } }
                    }
                    bool any = false;
                    foreach (var u in sockets)
                    {
                        while (u.Available > 0)
                        {
                            any = true;
                            var from = new IPEndPoint(IPAddress.Any, 0);
                            byte[] data;
                            try { data = u.Receive(ref from); } catch { break; }
                            ParseMatches(data, from.Address, id, matches);
                        }
                    }
                    if (!any) Thread.Sleep(30);
                }
            }
            finally { foreach (var u in sockets) { try { u.Close(); } catch { } } }

            // Ask each match for its computer name (metadata Get over HTTP), all at once.
            var list = new List<Match>(matches.Values);
            var names = new string[list.Count];
            var threads = new List<Thread>();
            for (int i = 0; i < list.Count; i++)
            {
                int k = i;
                var t = new Thread(delegate () { try { names[k] = NameOf(list[k], metaMs); } catch { } });
                t.IsBackground = true;
                t.Start();
                threads.Add(t);
            }
            var deadline = Stopwatch.StartNew();
            foreach (var t in threads) t.Join(Math.Max(1, metaMs + 200 - (int)deadline.ElapsedMilliseconds));
            var outList = new List<Dictionary<string, object>>();
            for (int i = 0; i < list.Count; i++)
            {
                var d = new Dictionary<string, object>();
                d["name"] = names[i] ?? list[i].Address;
                d["address"] = list[i].Address;
                if (names[i] == null) d["unnamed"] = true;
                outList.Add(d);
            }
            return outList;
        }

        static void ParseMatches(byte[] data, IPAddress from, string probeId, Dictionary<string, Match> matches)
        {
            var doc = new System.Xml.XmlDocument();
            try { doc.LoadXml(Encoding.UTF8.GetString(data)); } catch { return; }
            var ns = new System.Xml.XmlNamespaceManager(doc.NameTable);
            ns.AddNamespace("wsa", NsAddr);
            ns.AddNamespace("wsd", NsDisc);
            var rel = doc.SelectSingleNode("//wsa:RelatesTo", ns);
            if (rel == null || rel.InnerText.Trim() != "urn:uuid:" + probeId) return;
            foreach (System.Xml.XmlNode m in doc.SelectNodes("//wsd:ProbeMatch", ns))
            {
                var types = m.SelectSingleNode("wsd:Types", ns);
                if (types == null || types.InnerText.IndexOf("Computer", StringComparison.Ordinal) < 0) continue;
                var epr = m.SelectSingleNode("wsa:EndpointReference/wsa:Address", ns);
                var x = m.SelectSingleNode("wsd:XAddrs", ns);
                if (epr == null) continue;
                string xaddr = null;
                if (x != null)
                {
                    foreach (var part in x.InnerText.Split(new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                    {
                        // prefer the IPv4 address the reply came from
                        if (xaddr == null || part.Contains("//" + from + ":")) xaddr = part;
                    }
                }
                matches[epr.InnerText.Trim()] = new Match { Epr = epr.InnerText.Trim(), XAddr = xaddr, Address = from.ToString() };
            }
        }

        static string NameOf(Match m, int ms)
        {
            if (m.XAddr != null && m.XAddr.StartsWith("http", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create(m.XAddr);
                    req.Method = "POST";
                    req.ContentType = "application/soap+xml";
                    req.Timeout = ms;
                    req.ReadWriteTimeout = ms;
                    req.Proxy = null;
                    req.UserAgent = "Hopper";
                    byte[] body = Encoding.UTF8.GetBytes(Get(m.Epr, Guid.NewGuid().ToString()));
                    req.ContentLength = body.Length;
                    using (var s = req.GetRequestStream()) s.Write(body, 0, body.Length);
                    string xml;
                    using (var resp = req.GetResponse())
                    using (var r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) xml = r.ReadToEnd();
                    // <pub:Computer>NAME/Workgroup:WG</pub:Computer> (or /Domain:, /NotJoined)
                    var c = Regex.Match(xml, "<(?:\\w+:)?Computer[^>]*>([^<]+)</(?:\\w+:)?Computer>");
                    if (c.Success)
                    {
                        string v = WebUtility.HtmlDecode(c.Groups[1].Value).Trim();
                        int slash = v.IndexOf('/');
                        if (slash > 0) v = v.Substring(0, slash);
                        if (v.Length > 0) return v;
                    }
                }
                catch { }
            }
            // fall back to the name DNS has for the address
            string name;
            try
            {
                if (Network.Within(Math.Min(ms, 2000), delegate { return Dns.GetHostEntry(m.Address).HostName; }, out name) && !string.IsNullOrEmpty(name) && name != m.Address)
                {
                    int dot = name.IndexOf('.');
                    return (dot > 0 ? name.Substring(0, dot) : name).ToUpperInvariant();
                }
            }
            catch { }
            return null;
        }
    }
}
