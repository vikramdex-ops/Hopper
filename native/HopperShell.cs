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
                case "properties":
                    ui.Invoke(delegate { ShellUi.Properties(StrList(a, "paths")); });
                    return "true";
                case "openWith":
                    ui.Invoke(delegate { ShellUi.OpenWith(Str(a, "path")); });
                    return "true";
                case "contextMenu":
                    string chosen = null;
                    ui.Invoke(delegate
                    {
                        chosen = ShellMenu.Show(StrList(a, "paths"), Int(a, "x"), Int(a, "y"), (long)Num(a, "hwnd"));
                    });
                    return Json.Serialize(chosen);
                case "recycleList": return Json.Serialize(Recycle.List());
                case "recycleRestore": return Json.Serialize(Recycle.Restore(StrList(a, "paths")));
                default: throw new Exception("unknown command " + cmd);
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
    // Shell dialogs

    static class ShellUi
    {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern bool SHObjectProperties(IntPtr hwnd, int shopObjectType, string pszObjectName, string pszPropertyPage);
        [DllImport("shell32.dll")]
        static extern int SHMultiFileProperties(System.Runtime.InteropServices.ComTypes.IDataObject pdtobj, int dwFlags);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern int SHOpenWithDialog(IntPtr hwnd, ref OPENASINFO info);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct OPENASINFO { public string pcszFile; public string pcszClass; public int oaifInFlags; }

        public static void Properties(List<string> paths)
        {
            if (paths.Count == 0) return;
            if (paths.Count == 1) { SHObjectProperties(IntPtr.Zero, 2 /* SHOP_FILEPATH */, paths[0], null); return; }
            var files = new StringCollection();
            foreach (var p in paths) files.Add(p);
            var data = new DataObject();
            data.SetFileDropList(files);
            SHMultiFileProperties((System.Runtime.InteropServices.ComTypes.IDataObject)data, 0);
        }

        public static void OpenWith(string path)
        {
            var info = new OPENASINFO { pcszFile = path, oaifInFlags = 0x1 | 0x4 | 0x8 /* ALLOW_REGISTRATION | REGISTER_EXT | EXEC */ };
            SHOpenWithDialog(IntPtr.Zero, ref info);
        }
    }

    // -----------------------------------------------------------------------
    // The real Explorer context menu (7-Zip, WinRAR, Send to, Open with…)

    static class ShellMenu
    {
        [ComImport, Guid("000214E6-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellFolder
        {
            void ParseDisplayName(IntPtr hwnd, IntPtr pbc, [MarshalAs(UnmanagedType.LPWStr)] string name, out uint eaten, out IntPtr pidl, ref uint attrs);
            void EnumObjects(IntPtr hwnd, int flags, out IntPtr enumIDList);
            void BindToObject(IntPtr pidl, IntPtr pbc, [In] ref Guid riid, out IntPtr ppv);
            void BindToStorage(IntPtr pidl, IntPtr pbc, [In] ref Guid riid, out IntPtr ppv);
            [PreserveSig] int CompareIDs(IntPtr lParam, IntPtr pidl1, IntPtr pidl2);
            void CreateViewObject(IntPtr hwnd, [In] ref Guid riid, out IntPtr ppv);
            void GetAttributesOf(uint cidl, [MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl, ref uint rgfInOut);
            void GetUIObjectOf(IntPtr hwnd, uint cidl, [MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl, [In] ref Guid riid, IntPtr rgfReserved, out IntPtr ppv);
            void GetDisplayNameOf(IntPtr pidl, uint flags, IntPtr name);
            void SetNameOf(IntPtr hwnd, IntPtr pidl, [MarshalAs(UnmanagedType.LPWStr)] string name, uint flags, out IntPtr ppidlOut);
        }

        [ComImport, Guid("000214e4-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IContextMenu
        {
            [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
            [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX info);
            [PreserveSig] int GetCommandString(UIntPtr idcmd, uint uflags, IntPtr reserved, [MarshalAs(UnmanagedType.LPStr)] StringBuilder commandstring, int cch);
        }

        [ComImport, Guid("000214f4-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IContextMenu2
        {
            [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
            [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX info);
            [PreserveSig] int GetCommandString(UIntPtr idcmd, uint uflags, IntPtr reserved, [MarshalAs(UnmanagedType.LPStr)] StringBuilder commandstring, int cch);
            [PreserveSig] int HandleMenuMsg(int uMsg, IntPtr wParam, IntPtr lParam);
        }

        [ComImport, Guid("bcfce0a0-ec17-11d0-8d10-00a0c90f2719"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IContextMenu3
        {
            [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
            [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX info);
            [PreserveSig] int GetCommandString(UIntPtr idcmd, uint uflags, IntPtr reserved, [MarshalAs(UnmanagedType.LPStr)] StringBuilder commandstring, int cch);
            [PreserveSig] int HandleMenuMsg(int uMsg, IntPtr wParam, IntPtr lParam);
            [PreserveSig] int HandleMenuMsg2(int uMsg, IntPtr wParam, IntPtr lParam, out IntPtr result);
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct CMINVOKECOMMANDINFOEX
        {
            public int cbSize;
            public int fMask;
            public IntPtr hwnd;
            public IntPtr lpVerb;
            [MarshalAs(UnmanagedType.LPStr)] public string lpParameters;
            [MarshalAs(UnmanagedType.LPStr)] public string lpDirectory;
            public int nShow;
            public int dwHotKey;
            public IntPtr hIcon;
            [MarshalAs(UnmanagedType.LPStr)] public string lpTitle;
            public IntPtr lpVerbW;
            public string lpParametersW;
            public string lpDirectoryW;
            public string lpTitleW;
            public POINT ptInvoke;
        }

        [StructLayout(LayoutKind.Sequential)] struct POINT { public int x; public int y; }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern int SHParseDisplayName(string name, IntPtr pbc, out IntPtr pidl, uint sfgaoIn, out uint psfgaoOut);
        [DllImport("shell32.dll")]
        static extern int SHBindToParent(IntPtr pidl, [In] ref Guid riid, out IntPtr ppv, out IntPtr ppidlLast);
        [DllImport("user32.dll")] static extern IntPtr CreatePopupMenu();
        [DllImport("user32.dll")] static extern bool DestroyMenu(IntPtr hMenu);
        [DllImport("user32.dll")] static extern int TrackPopupMenuEx(IntPtr hmenu, uint flags, int x, int y, IntPtr hwnd, IntPtr lptpm);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetMenuString(IntPtr hMenu, uint uIDItem, StringBuilder lpString, int nMaxCount, uint uFlag);
        [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr pv);

        static IContextMenu2 cm2;
        static IContextMenu3 cm3;

        class Hook : NativeWindow
        {
            protected override void WndProc(ref Message m)
            {
                const int WM_INITMENUPOPUP = 0x117, WM_DRAWITEM = 0x2B, WM_MEASUREITEM = 0x2C, WM_MENUCHAR = 0x120;
                if (cm3 != null && (m.Msg == WM_INITMENUPOPUP || m.Msg == WM_DRAWITEM || m.Msg == WM_MEASUREITEM || m.Msg == WM_MENUCHAR))
                {
                    IntPtr res;
                    if (cm3.HandleMenuMsg2(m.Msg, m.WParam, m.LParam, out res) == 0) { m.Result = res; return; }
                }
                else if (cm2 != null && (m.Msg == WM_INITMENUPOPUP || m.Msg == WM_DRAWITEM || m.Msg == WM_MEASUREITEM))
                {
                    if (cm2.HandleMenuMsg(m.Msg, m.WParam, m.LParam) == 0) { m.Result = IntPtr.Zero; return; }
                }
                base.WndProc(ref m);
            }
        }

        /// <summary>Shows the native menu for items that share one parent folder; returns the verb run, or null.</summary>
        public static string Show(List<string> paths, int x, int y, long ownerHwnd)
        {
            if (paths.Count == 0) return null;
            var pidls = new List<IntPtr>();
            IntPtr parentPtr = IntPtr.Zero, menu = IntPtr.Zero, cmPtr = IntPtr.Zero;
            var hook = new Hook();
            try
            {
                IntPtr full;
                uint dummy;
                if (SHParseDisplayName(paths[0], IntPtr.Zero, out full, 0, out dummy) != 0) throw new Exception("cannot parse " + paths[0]);
                pidls.Add(full);
                Guid iidShellFolder = typeof(IShellFolder).GUID;
                IntPtr last;
                if (SHBindToParent(full, ref iidShellFolder, out parentPtr, out last) != 0) throw new Exception("cannot bind parent");
                var parent = (IShellFolder)Marshal.GetObjectForIUnknown(parentPtr);
                var children = new List<IntPtr> { last };
                for (int i = 1; i < paths.Count; i++)
                {
                    IntPtr p;
                    if (SHParseDisplayName(paths[i], IntPtr.Zero, out p, 0, out dummy) != 0) continue;
                    pidls.Add(p);
                    IntPtr childParent, childLast;
                    if (SHBindToParent(p, ref iidShellFolder, out childParent, out childLast) == 0)
                    {
                        Marshal.Release(childParent);
                        children.Add(childLast);
                    }
                }
                Guid iidCm = typeof(IContextMenu).GUID;
                parent.GetUIObjectOf(IntPtr.Zero, (uint)children.Count, children.ToArray(), ref iidCm, IntPtr.Zero, out cmPtr);
                var cm = (IContextMenu)Marshal.GetObjectForIUnknown(cmPtr);
                cm2 = cm as IContextMenu2;
                cm3 = cm as IContextMenu3;

                menu = CreatePopupMenu();
                const uint CMF_NORMAL = 0, CMF_EXTENDEDVERBS = 0x100;
                bool shift = (Control.ModifierKeys & Keys.Shift) != 0;
                cm.QueryContextMenu(menu, 0, 1, 0x7FFF, CMF_NORMAL | (shift ? CMF_EXTENDEDVERBS : 0));

                var host = Application.OpenForms[0];
                hook.AssignHandle(host.Handle);
                SetForegroundWindow(host.Handle);
                const uint TPM_RETURNCMD = 0x100, TPM_RIGHTBUTTON = 0x2;
                int cmd = TrackPopupMenuEx(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, x, y, host.Handle, IntPtr.Zero);
                if (cmd <= 0) return null;

                var verb = new StringBuilder(256);
                cm.GetCommandString((UIntPtr)(uint)(cmd - 1), 0 /* GCS_VERBA */, IntPtr.Zero, verb, verb.Capacity);
                var info = new CMINVOKECOMMANDINFOEX();
                info.cbSize = Marshal.SizeOf(typeof(CMINVOKECOMMANDINFOEX));
                info.fMask = 0x4000 /* CMIC_MASK_UNICODE */ | 0x20000000 /* PTINVOKE */;
                info.hwnd = ownerHwnd != 0 ? new IntPtr(ownerHwnd) : host.Handle;
                info.lpVerb = (IntPtr)(cmd - 1);
                info.lpVerbW = (IntPtr)(cmd - 1);
                info.nShow = 1;
                info.ptInvoke = new POINT { x = x, y = y };
                cm.InvokeCommand(ref info);
                return verb.Length > 0 ? verb.ToString() : "cmd:" + (cmd - 1);
            }
            finally
            {
                hook.ReleaseHandle();
                cm2 = null; cm3 = null;
                if (menu != IntPtr.Zero) DestroyMenu(menu);
                if (cmPtr != IntPtr.Zero) Marshal.Release(cmPtr);
                if (parentPtr != IntPtr.Zero) Marshal.Release(parentPtr);
                foreach (var p in pidls) CoTaskMemFree(p);
            }
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
}
