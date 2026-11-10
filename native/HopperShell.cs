// HopperShell: a long-lived helper process for the Windows-only things Node cannot do well.
// Protocol: one JSON request per stdin line {"id":1,"cmd":"list","args":{...}},
// one JSON reply per stdout line {"id":1,"ok":true,"result":...}.
// Built with the .NET Framework 4.8 csc.exe that ships with Windows (C# 5).

using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Hopper
{
    static class Program
    {
        static readonly object OutLock = new object();
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        static UiThread ui;
        static int pending;

        [STAThread]
        static int Main(string[] argv)
        {
            var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            stdout.AutoFlush = false;
            Console.SetOut(stdout);
            // Listings block on I/O (often SMB); don't let the pool's slow ramp-up queue them.
            ThreadPool.SetMinThreads(32, 16);
            ui = new UiThread();

            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                string reqLine = line;
                // Each request runs on the thread pool so a slow network listing
                // never holds up a clipboard call.
                Interlocked.Increment(ref pending);
                ThreadPool.QueueUserWorkItem(delegate { try { Handle(reqLine); } finally { Interlocked.Decrement(ref pending); } });
            }
            // stdin closed (parent gone): finish what is in flight, then exit.
            for (int i = 0; i < 600 && Volatile.Read(ref pending) > 0; i++) Thread.Sleep(50);
            return 0;
        }

        static void Handle(string line)
        {
            long id = 0;
            try
            {
                var req = (Dictionary<string, object>)Json.DeserializeObject(line);
                id = Convert.ToInt64(req["id"]);
                var cmd = (string)req["cmd"];
                var args = req.ContainsKey("args") && req["args"] != null
                    ? (Dictionary<string, object>)req["args"]
                    : new Dictionary<string, object>();
                string resultJson = Dispatch(cmd, args);
                Write("{\"id\":" + id + ",\"ok\":true,\"result\":" + resultJson + "}");
            }
            catch (Exception ex)
            {
                Write("{\"id\":" + id + ",\"ok\":false,\"error\":" + Json.Serialize(ex.Message) + "}");
            }
        }

        static void Write(string s)
        {
            lock (OutLock)
            {
                Console.Out.Write(s);
                Console.Out.Write('\n');
                Console.Out.Flush();
            }
        }

        static string Dispatch(string cmd, Dictionary<string, object> a)
        {
            if (cmd.StartsWith("net", StringComparison.Ordinal)) return Network.Dispatch(cmd, a); // native/Network.cs
            switch (cmd)
            {
                case "ping": return "\"pong\"";
                case "list": return Lister.List(Str(a, "path"));
                case "drives": return Drives.Get();
                case "user": return Json.Serialize(UserInfo.Get());
                case "clipWrite":
                    ui.Invoke(delegate { Clip.Write(StrList(a, "paths"), Bool(a, "cut")); });
                    return "true";
                case "clipRead":
                    object r = null;
                    ui.Invoke(delegate { r = Clip.Read(); });
                    return Json.Serialize(r);
                case "props": return Json.Serialize(Props.Get(StrList(a, "paths")));
                case "setAttrs": return Json.Serialize(Props.SetAttrs(StrList(a, "paths"), Int(a, "set"), Int(a, "clear")));
                case "cluster": return Props.Cluster(Str(a, "path")).ToString();
                case "shares": return Json.Serialize(Props.Shares());
                case "shellNew": return Json.Serialize(ShellNew.List());
                case "openWithList": return Json.Serialize(OpenWith.List(Str(a, "path")));
                case "openWithInvoke":
                    ui.Invoke(delegate { OpenWith.Invoke(Str(a, "path"), Str(a, "name")); });
                    return "true";
                case "recycleList": return Json.Serialize(Recycle.List());
                case "recycleRestore": return Json.Serialize(Recycle.Restore(StrList(a, "paths")));
                default: return PreviewTools.Dispatch(cmd, a); // preview helpers live in PreviewTools.cs
            }
        }

        static string Str(Dictionary<string, object> a, string k) { return a.ContainsKey(k) ? Convert.ToString(a[k]) : ""; }
        static bool Bool(Dictionary<string, object> a, string k) { return a.ContainsKey(k) && a[k] is bool && (bool)a[k]; }
        static int Int(Dictionary<string, object> a, string k) { return a.ContainsKey(k) ? Convert.ToInt32(a[k]) : 0; }
        static double Num(Dictionary<string, object> a, string k) { return a.ContainsKey(k) && a[k] != null ? Convert.ToDouble(a[k]) : 0; }
        static List<string> StrList(Dictionary<string, object> a, string k)
        {
            var list = new List<string>();
            if (!a.ContainsKey(k) || a[k] == null) return list;
            foreach (var o in (IEnumerable)a[k]) list.Add(Convert.ToString(o));
            return list;
        }

        internal static string Esc(string s)
        {
            var sb = new StringBuilder(s.Length + 8);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }

    /// <summary>A dedicated STA thread with a message loop for clipboard, menus and shell dialogs.</summary>
    class UiThread
    {
        readonly Form form;
        public UiThread()
        {
            var ready = new ManualResetEvent(false);
            Form f = null;
            var t = new Thread(delegate ()
            {
                f = new Form { ShowInTaskbar = false, FormBorderStyle = FormBorderStyle.None, Opacity = 0, Width = 1, Height = 1, StartPosition = FormStartPosition.Manual, Left = -32000, Top = -32000 };
                f.Load += delegate { ready.Set(); };
                Application.Run(f);
            });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Start();
            ready.WaitOne();
            form = f;
        }
        public IntPtr Handle { get { return form.Handle; } }
        public void Invoke(Action a)
        {
            Exception err = null;
            form.Invoke((MethodInvoker)delegate { try { a(); } catch (Exception e) { err = e; } });
            if (err != null) throw err;
        }
        public Form Form { get { return form; } }
    }

    // -----------------------------------------------------------------------
    // Directory listing with FindFirstFileEx (one round trip per batch, no per-file stat)

    static class Lister
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct WIN32_FIND_DATA
        {
            public uint dwFileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftCreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftLastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME ftLastWriteTime;
            public uint nFileSizeHigh;
            public uint nFileSizeLow;
            public uint dwReserved0;
            public uint dwReserved1;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string cFileName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string cAlternateFileName;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr FindFirstFileExW(string lpFileName, int fInfoLevelId, out WIN32_FIND_DATA lpFindFileData, int fSearchOp, IntPtr lpSearchFilter, int dwAdditionalFlags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool FindNextFileW(IntPtr hFindFile, out WIN32_FIND_DATA lpFindFileData);
        [DllImport("kernel32.dll")]
        static extern bool FindClose(IntPtr hFindFile);

        const int FindExInfoBasic = 1;
        const int FIND_FIRST_EX_LARGE_FETCH = 2;
        static readonly IntPtr INVALID = new IntPtr(-1);

        static long Ms(System.Runtime.InteropServices.ComTypes.FILETIME ft)
        {
            long v = ((long)(uint)ft.dwHighDateTime << 32) | (uint)ft.dwLowDateTime;
            if (v == 0) return 0;
            return (v - 116444736000000000L) / 10000L;
        }

        public static string List(string path)
        {
            if (string.IsNullOrEmpty(path)) throw new Exception("path required");
            string p = path.EndsWith("\\") ? path : path + "\\";
            string q = p.StartsWith("\\\\") ? "\\\\?\\UNC\\" + p.Substring(2) : "\\\\?\\" + p;
            WIN32_FIND_DATA fd;
            IntPtr h = FindFirstFileExW(q + "*", FindExInfoBasic, out fd, 0, IntPtr.Zero, FIND_FIRST_EX_LARGE_FETCH);
            if (h == INVALID)
            {
                int err = Marshal.GetLastWin32Error();
                if (err == 2 || err == 18) return "[]"; // empty
                throw new System.ComponentModel.Win32Exception(err);
            }
            var sb = new StringBuilder(1 << 16);
            sb.Append('[');
            bool first = true;
            try
            {
                do
                {
                    string n = fd.cFileName;
                    if (n == "." || n == "..") continue;
                    if (!first) sb.Append(',');
                    first = false;
                    long size = ((long)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
                    sb.Append("[").Append(Program.Esc(n)).Append(',')
                      .Append(fd.dwFileAttributes).Append(',')
                      .Append(size).Append(',')
                      .Append(Ms(fd.ftLastWriteTime)).Append(',')
                      .Append(Ms(fd.ftCreationTime)).Append(',')
                      .Append(Ms(fd.ftLastAccessTime)).Append(',')
                      .Append(fd.dwReserved0).Append(']');
                } while (FindNextFileW(h, out fd));
            }
            finally { FindClose(h); }
            sb.Append(']');
            return sb.ToString();
        }
    }

    // -----------------------------------------------------------------------
    // Drives: every query has a timeout so a dead mapped drive never stalls the bar.

    static class Drives
    {
        [DllImport("mpr.dll", CharSet = CharSet.Unicode)]
        static extern int WNetGetConnectionW(string localName, StringBuilder remoteName, ref int length);

        public static string Get()
        {
            var drives = DriveInfo.GetDrives();
            var tasks = new List<Task<string>>();
            foreach (var d in drives)
            {
                var drive = d;
                tasks.Add(Task.Factory.StartNew(() => Describe(drive)));
            }
            var parts = new List<string>();
            for (int i = 0; i < tasks.Count; i++)
            {
                var d = drives[i];
                if (tasks[i].Wait(1500)) parts.Add(tasks[i].Result);
                else parts.Add(Obj(d.Name, "", Kind(d), 0, 0, false, Remote(d)));
            }
            return "[" + string.Join(",", parts) + "]";
        }

        static string Describe(DriveInfo d)
        {
            try
            {
                if (!d.IsReady) return Obj(d.Name, "", Kind(d), 0, 0, false, Remote(d));
                return Obj(d.Name, d.VolumeLabel, Kind(d), d.TotalSize, d.AvailableFreeSpace, true, Remote(d));
            }
            catch { return Obj(d.Name, "", Kind(d), 0, 0, false, Remote(d)); }
        }

        static string Remote(DriveInfo d)
        {
            if (d.DriveType != DriveType.Network) return null;
            var sb = new StringBuilder(512);
            int len = sb.Capacity;
            return WNetGetConnectionW(d.Name.TrimEnd('\\'), sb, ref len) == 0 ? sb.ToString() : null;
        }

        static string Kind(DriveInfo d)
        {
            switch (d.DriveType)
            {
                case DriveType.Fixed: return "fixed";
                case DriveType.Removable: return "removable";
                case DriveType.Network: return "network";
                case DriveType.CDRom: return "cdrom";
                case DriveType.Ram: return "ram";
                default: return "unknown";
            }
        }

        static string Obj(string root, string label, string kind, long total, long free, bool ready, string remote)
        {
            return "{\"root\":" + Program.Esc(root) + ",\"label\":" + Program.Esc(label ?? "") + ",\"kind\":\"" + kind +
                   "\",\"total\":" + total + ",\"free\":" + free + ",\"ready\":" + (ready ? "true" : "false") +
                   (remote != null ? ",\"remote\":" + Program.Esc(remote) : "") + "}";
        }
    }

    // -----------------------------------------------------------------------
    // User identity

    static class UserInfo
    {
        [DllImport("secur32.dll", CharSet = CharSet.Unicode)]
        static extern bool GetUserNameExW(int nameFormat, StringBuilder buf, ref int size);
        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        static extern int NetUserGetInfo(string server, string user, int level, out IntPtr buf);
        [DllImport("netapi32.dll")]
        static extern int NetApiBufferFree(IntPtr buf);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct USER_INFO_10 { public string name; public string comment; public string usr_comment; public string full_name; }

        public static Dictionary<string, object> Get()
        {
            string user = Environment.UserName;
            string full = null;
            try
            {
                var sb = new StringBuilder(256);
                int size = sb.Capacity;
                if (GetUserNameExW(3 /* NameDisplay */, sb, ref size)) full = sb.ToString();
            }
            catch { }
            if (string.IsNullOrEmpty(full))
            {
                try
                {
                    IntPtr buf;
                    if (NetUserGetInfo(null, user, 10, out buf) == 0)
                    {
                        var info = (USER_INFO_10)Marshal.PtrToStructure(buf, typeof(USER_INFO_10));
                        full = info.full_name;
                        NetApiBufferFree(buf);
                    }
                }
                catch { }
            }
            var d = new Dictionary<string, object>();
            d["user"] = user;
            d["displayName"] = string.IsNullOrEmpty(full) ? user : full;
            d["host"] = Environment.MachineName;
            d["domain"] = Environment.UserDomainName;
            d["sid"] = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
            return d;
        }
    }

    // -----------------------------------------------------------------------
    // Explorer-compatible clipboard (CF_HDROP + Preferred DropEffect)

    static class Clip
    {
        public static void Write(List<string> paths, bool cut)
        {
            var files = new StringCollection();
            foreach (var p in paths) files.Add(p);
            var data = new DataObject();
            data.SetFileDropList(files);
            var effect = new MemoryStream(BitConverter.GetBytes(cut ? 2 : 5)); // MOVE : COPY|LINK
            data.SetData("Preferred DropEffect", effect);
            Clipboard.SetDataObject(data, true, 5, 50);
        }

        public static Dictionary<string, object> Read()
        {
            var d = new Dictionary<string, object>();
            var list = new List<string>();
            bool cut = false;
            if (Clipboard.ContainsFileDropList())
            {
                foreach (var s in Clipboard.GetFileDropList()) list.Add(s);
                var obj = Clipboard.GetData("Preferred DropEffect") as MemoryStream;
                if (obj != null)
                {
                    var b = new byte[4];
                    obj.Read(b, 0, 4);
                    cut = (BitConverter.ToInt32(b, 0) & 2) != 0;
                }
            }
            d["paths"] = list;
            d["cut"] = cut;
            d["text"] = Clipboard.ContainsText() ? Clipboard.GetText() : null;
            return d;
        }
    }

    // -----------------------------------------------------------------------
    // Recycle Bin: list and restore by parsing $I records (language independent).

    static class Recycle
    {
        static string Sid() { return System.Security.Principal.WindowsIdentity.GetCurrent().User.Value; }

        static IEnumerable<string[]> Records()
        {
            // yields [infoFile, dataFile, originalPath, deletedMs, size]
            string sid = Sid();
            foreach (var d in DriveInfo.GetDrives())
            {
                if (d.DriveType != DriveType.Fixed && d.DriveType != DriveType.Removable) continue;
                string bin = Path.Combine(d.Name, "$Recycle.Bin", sid);
                string[] infos;
                try { if (!Directory.Exists(bin)) continue; infos = Directory.GetFiles(bin, "$I*"); }
                catch { continue; }
                foreach (var info in infos)
                {
                    string[] rec = null;
                    try
                    {
                        var b = File.ReadAllBytes(info);
                        long version = BitConverter.ToInt64(b, 0);
                        long size = BitConverter.ToInt64(b, 8);
                        long ft = BitConverter.ToInt64(b, 16);
                        string orig;
                        if (version >= 2)
                        {
                            int len = BitConverter.ToInt32(b, 24);
                            orig = Encoding.Unicode.GetString(b, 28, Math.Max(0, (len - 1) * 2));
                        }
                        else orig = Encoding.Unicode.GetString(b, 24, 520).TrimEnd('\0');
                        string data = Path.Combine(bin, "$R" + Path.GetFileName(info).Substring(2));
                        long ms = ft == 0 ? 0 : (ft - 116444736000000000L) / 10000L;
                        rec = new[] { info, data, orig, ms.ToString(), size.ToString() };
                    }
                    catch { }
                    if (rec != null) yield return rec;
                }
            }
        }

        public static List<Dictionary<string, object>> List()
        {
            var list = new List<Dictionary<string, object>>();
            foreach (var r in Records())
            {
                var d = new Dictionary<string, object>();
                d["path"] = r[2]; d["deleted"] = long.Parse(r[3]); d["size"] = long.Parse(r[4]);
                list.Add(d);
            }
            return list;
        }

        /// <summary>Restores the most recently deleted copy of each original path.</summary>
        public static Dictionary<string, object> Restore(List<string> paths)
        {
            var want = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);
            foreach (var r in Records())
            {
                if (!paths.Exists(p => string.Equals(p, r[2], StringComparison.OrdinalIgnoreCase))) continue;
                string[] prev;
                if (!want.TryGetValue(r[2], out prev) || long.Parse(prev[3]) < long.Parse(r[3])) want[r[2]] = r;
            }
            var restored = new List<string>();
            var failed = new List<string>();
            foreach (var p in paths)
            {
                string[] r;
                if (!want.TryGetValue(p, out r)) { failed.Add(p); continue; }
                try
                {
                    if (File.Exists(r[2]) || Directory.Exists(r[2])) throw new Exception("exists");
                    Directory.CreateDirectory(Path.GetDirectoryName(r[2]));
                    if (Directory.Exists(r[1])) Directory.Move(r[1], r[2]); else File.Move(r[1], r[2]);
                    File.Delete(r[0]);
                    restored.Add(p);
                }
                catch { failed.Add(p); }
            }
            var d = new Dictionary<string, object>();
            d["restored"] = restored; d["failed"] = failed;
            return d;
        }
    }

    // -----------------------------------------------------------------------
    // Properties for Hopper's own Properties window (no Explorer dialogs)

    static class Props
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetCompressedFileSizeW(string name, out uint high);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool GetDiskFreeSpaceW(string root, out uint sectorsPerCluster, out uint bytesPerSector, out uint freeClusters, out uint totalClusters);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool SetFileAttributesW(string name, uint attrs);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFileAttributesW(string name);

        public static long Cluster(string path)
        {
            try
            {
                uint spc, bps, free, total;
                if (GetDiskFreeSpaceW(Path.GetPathRoot(path), out spc, out bps, out free, out total)) return (long)spc * bps;
            }
            catch { }
            return 4096;
        }

        public static List<Dictionary<string, object>> Get(List<string> paths)
        {
            var list = new List<Dictionary<string, object>>();
            foreach (var p in paths)
            {
                var d = new Dictionary<string, object>();
                d["path"] = p;
                try
                {
                    bool isDir = Directory.Exists(p);
                    FileSystemInfo fi = isDir ? (FileSystemInfo)new DirectoryInfo(p) : new FileInfo(p);
                    d["dir"] = isDir;
                    d["attrs"] = (int)fi.Attributes;
                    d["created"] = ToMs(fi.CreationTimeUtc);
                    d["modified"] = ToMs(fi.LastWriteTimeUtc);
                    d["accessed"] = ToMs(fi.LastAccessTimeUtc);
                    if (!isDir)
                    {
                        long size = ((FileInfo)fi).Length;
                        d["size"] = size;
                        uint high;
                        uint low = GetCompressedFileSizeW(p, out high);
                        long onDisk = low == 0xFFFFFFFF && Marshal.GetLastWin32Error() != 0 ? size : ((long)high << 32) | low;
                        long c = Cluster(p);
                        d["sizeOnDisk"] = ((onDisk + c - 1) / c) * c;
                    }
                    try
                    {
                        System.Security.AccessControl.FileSystemSecurity sec = isDir
                            ? (System.Security.AccessControl.FileSystemSecurity)Directory.GetAccessControl(p)
                            : File.GetAccessControl(p);
                        d["owner"] = Translate(sec.GetOwner(typeof(System.Security.Principal.SecurityIdentifier)));
                        var rules = new List<Dictionary<string, object>>();
                        foreach (System.Security.AccessControl.FileSystemAccessRule r in sec.GetAccessRules(true, true, typeof(System.Security.Principal.SecurityIdentifier)))
                        {
                            var rd = new Dictionary<string, object>();
                            rd["who"] = Translate(r.IdentityReference);
                            rd["allow"] = r.AccessControlType == System.Security.AccessControl.AccessControlType.Allow;
                            rd["rights"] = Rights(r.FileSystemRights);
                            rd["inherited"] = r.IsInherited;
                            rules.Add(rd);
                            if (rules.Count >= 40) break;
                        }
                        d["access"] = rules;
                    }
                    catch (Exception ex) { d["securityError"] = ex.Message; }
                    if ((fi.Attributes & FileAttributes.ReparsePoint) != 0) d["link"] = true;
                }
                catch (Exception ex) { d["error"] = ex.Message; }
                list.Add(d);
            }
            return list;
        }

        static string Translate(System.Security.Principal.IdentityReference id)
        {
            try { return id.Translate(typeof(System.Security.Principal.NTAccount)).Value; }
            catch { return id.Value; }
        }

        static string Rights(System.Security.AccessControl.FileSystemRights r)
        {
            var F = System.Security.AccessControl.FileSystemRights.FullControl;
            var M = System.Security.AccessControl.FileSystemRights.Modify;
            var X = System.Security.AccessControl.FileSystemRights.ReadAndExecute;
            var R = System.Security.AccessControl.FileSystemRights.Read;
            var W = System.Security.AccessControl.FileSystemRights.Write;
            if ((r & F) == F) return "Full control";
            if ((r & M) == M) return "Modify";
            if ((r & X) == X) return (r & W) == W ? "Read, write and run" : "Read and run";
            if ((r & R) == R) return (r & W) == W ? "Read and write" : "Read";
            if ((r & W) == W) return "Write";
            return "Special";
        }

        static long ToMs(DateTime utc) { return (long)(utc - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }

        public static Dictionary<string, object> SetAttrs(List<string> paths, int set, int clear)
        {
            var failed = new List<string>();
            int ok = 0;
            foreach (var p in paths)
            {
                uint cur = GetFileAttributesW(p);
                if (cur == 0xFFFFFFFF) { failed.Add(p); continue; }
                // only read-only (1), hidden (2), system (4) and archive (0x20) may be changed
                uint mask = 0x27;
                uint next = (cur | ((uint)set & mask)) & ~((uint)clear & mask);
                if (next == cur || SetFileAttributesW(p, next)) ok++; else failed.Add(p);
            }
            var d = new Dictionary<string, object>();
            d["ok"] = ok; d["failed"] = failed;
            return d;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct SHARE_INFO_2
        {
            public string netname; public uint type; public string remark; public uint permissions;
            public uint max_uses; public uint current_uses; public string path; public string passwd;
        }
        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        static extern int NetShareEnum(string server, int level, out IntPtr buf, int prefMax, out int read, out int total, ref int resume);
        [DllImport("netapi32.dll")]
        static extern int NetApiBufferFree(IntPtr buf);

        /// <summary>Folders this PC shares (name + local path); empty when the account may not list them.</summary>
        public static List<Dictionary<string, object>> Shares()
        {
            var list = new List<Dictionary<string, object>>();
            IntPtr buf; int read, total, resume = 0;
            if (NetShareEnum(null, 2, out buf, -1, out read, out total, ref resume) != 0) return list;
            try
            {
                int size = Marshal.SizeOf(typeof(SHARE_INFO_2));
                for (int i = 0; i < read; i++)
                {
                    var si = (SHARE_INFO_2)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + (long)i * size), typeof(SHARE_INFO_2));
                    if ((si.type & 0xFF) != 0 || string.IsNullOrEmpty(si.path)) continue; // disk shares only
                    var d = new Dictionary<string, object>();
                    d["name"] = si.netname; d["path"] = si.path;
                    list.Add(d);
                }
            }
            finally { NetApiBufferFree(buf); }
            return list;
        }
    }

    // -----------------------------------------------------------------------
    // "Open with": the apps Windows has registered for a file type, listed and launched by Hopper

    static class OpenWith
    {
        [ComImport, Guid("F04061AC-1659-4a3f-A954-775AA57FC083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAssocHandler
        {
            [PreserveSig] int GetName([MarshalAs(UnmanagedType.LPWStr)] out string name);
            [PreserveSig] int GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string name);
            [PreserveSig] int GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] out string path, out int index);
            [PreserveSig] int IsRecommended();
            [PreserveSig] int MakeDefault([MarshalAs(UnmanagedType.LPWStr)] string description);
            [PreserveSig] int Invoke(System.Runtime.InteropServices.ComTypes.IDataObject data);
            [PreserveSig] int CreateInvoker(System.Runtime.InteropServices.ComTypes.IDataObject data, out IntPtr invoker);
        }

        [ComImport, Guid("973810ae-9599-4b88-9e4d-6ee98c9552da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IEnumAssocHandlers
        {
            [PreserveSig] int Next(int count, [MarshalAs(UnmanagedType.Interface)] out IAssocHandler handler, out int fetched);
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern int SHAssocEnumHandlers(string extra, int filter, out IEnumAssocHandlers handlers);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern int SHCreateItemFromParsingName(string path, IntPtr bc, [In] ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

        [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItem
        {
            [PreserveSig] int BindToHandler(IntPtr bc, [In] ref Guid bhid, [In] ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);
        }

        static List<IAssocHandler> Handlers(string path)
        {
            var list = new List<IAssocHandler>();
            string ext = Path.GetExtension(path);
            if (string.IsNullOrEmpty(ext)) return list;
            IEnumAssocHandlers en;
            if (SHAssocEnumHandlers(ext, 0 /* ASSOC_FILTER_NONE */, out en) != 0 || en == null) return list;
            IAssocHandler h; int fetched;
            while (en.Next(1, out h, out fetched) == 0 && fetched == 1) list.Add(h);
            return list;
        }

        public static List<Dictionary<string, object>> List(string path)
        {
            var list = new List<Dictionary<string, object>>();
            foreach (var h in Handlers(path))
            {
                string name, ui, icon; int idx;
                h.GetName(out name); h.GetUIName(out ui);
                var d = new Dictionary<string, object>();
                d["name"] = name ?? "";
                d["label"] = string.IsNullOrEmpty(ui) ? Path.GetFileNameWithoutExtension(name ?? "") : ui;
                d["recommended"] = h.IsRecommended() == 0;
                if (h.GetIconLocation(out icon, out idx) == 0) d["icon"] = icon;
                list.Add(d);
            }
            return list;
        }

        public static void Invoke(string path, string name)
        {
            foreach (var h in Handlers(path))
            {
                string n; h.GetName(out n);
                if (!string.Equals(n, name, StringComparison.OrdinalIgnoreCase)) continue;
                Guid iidItem = typeof(IShellItem).GUID;
                IShellItem item;
                if (SHCreateItemFromParsingName(path, IntPtr.Zero, ref iidItem, out item) != 0) throw new Exception("cannot open " + path);
                Guid bhidDataObject = new Guid("b8c0bd9f-ed24-455c-83e6-d5390c4fe8c4");
                Guid iidDataObject = new Guid("0000010e-0000-0000-C000-000000000046");
                object data;
                if (item.BindToHandler(IntPtr.Zero, ref bhidDataObject, ref iidDataObject, out data) != 0) throw new Exception("cannot prepare " + path);
                int hr = h.Invoke((System.Runtime.InteropServices.ComTypes.IDataObject)data);
                if (hr != 0) throw new Exception("the app could not be started (0x" + hr.ToString("x") + ")");
                return;
            }
            throw new Exception("app not found");
        }
    }
}
